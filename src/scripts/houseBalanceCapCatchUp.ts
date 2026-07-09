import { Client, DiscordAPIError, GatewayIntentBits } from 'discord.js';
import { Prisma, TransactionType } from '@prisma/client';
import { sendRebateAnnouncement } from '../discord/rebateAnnouncement';
import { prisma } from '../db/client';
import { computeRebateDistribution, getLowerTierUserIds } from '../services/distributionBatch';
import { getOrCreateEconomyConfig } from '../services/economyConfig';
import { applyHouseTransaction, computeHouseCapExcess, getEconomySnapshot } from '../services/house';
import { applyTransaction } from '../services/ledger';

// Discord API 오류 코드: https://discord.com/developers/docs/topics/opcodes-and-status-codes#json
const MISSING_ACCESS = 50001;
const MISSING_PERMISSIONS = 50013;

type Db = Prisma.TransactionClient | typeof prisma;

export interface CatchUpPlanItem {
  discordId: string;
  amount: number;
}

export interface CatchUpPlan {
  totalEconomy: number;
  capRatio: number;
  capAmount: number;
  houseBalanceBefore: number;
  excessAmount: number;
  lowerTierCount: number;
  items: CatchUpPlanItem[];
  totalDistributed: number;
}

async function buildCatchUpPlan(db: Db, options?: { excludeUserId?: string }): Promise<CatchUpPlan> {
  const config = await getOrCreateEconomyConfig(db);
  const { house, totalEconomy } = await getEconomySnapshot(db);
  const { capAmount, excessAmount } = computeHouseCapExcess({
    totalEconomy,
    houseBalance: house.balance,
    capRatio: config.houseBalanceCapRatio,
  });

  const users = await db.user.findMany({
    where: options?.excludeUserId ? { discordId: { not: options.excludeUserId } } : undefined,
    select: { discordId: true },
  });
  const lowerTierUserIds = await getLowerTierUserIds(db, options);
  const { perUserAmounts, totalDistributed } = computeRebateDistribution({
    users,
    lowerTierUserIds,
    fundAmount: excessAmount,
    lowerTierWeight: config.lowerTierWeight,
  });

  return {
    totalEconomy,
    capRatio: config.houseBalanceCapRatio,
    capAmount,
    houseBalanceBefore: house.balance,
    excessAmount,
    lowerTierCount: lowerTierUserIds.length,
    items: [...perUserAmounts].map(([discordId, amount]) => ({ discordId, amount })),
    totalDistributed,
  };
}

// catch-up(격차를 한 번에 메우는 일회성 조정): 하우스 잔고가 전체 경제의 캡을 넘어선
// 만큼을 한 번에 지급한다. execute=false(기본값)면 계산만 하고 DB에 아무것도 쓰지
// 않는다 - dry-run과 execute 양쪽에서 이 함수를 그대로 재사용하며, 매번 그 시점의
// 실제 DB 상태를 다시 읽는다(dry-run 확인 직후 곧바로 execute를 실행하는 것을 전제).
export async function runCatchUp(
  execute: boolean,
  now: Date = new Date(),
  options?: { excludeUserId?: string }
): Promise<CatchUpPlan> {
  return prisma.$transaction(async (tx) => {
    const plan = await buildCatchUpPlan(tx, options);

    console.log(execute ? '=== 실행 결과 ===' : '=== DRY-RUN 결과 (DB에 쓰지 않음) ===');
    console.log(`전체 경제 규모: ${plan.totalEconomy.toLocaleString()}P`);
    console.log(`캡(${(plan.capRatio * 100).toFixed(0)}%): ${plan.capAmount.toLocaleString()}P`);
    console.log(`하우스 현재 잔고: ${plan.houseBalanceBefore.toLocaleString()}P`);
    console.log(`초과분(지급 재원): ${plan.excessAmount.toLocaleString()}P`);

    if (plan.excessAmount <= 0) {
      console.log('하우스 잔고가 이미 캡 이하입니다. 지급할 것이 없습니다.');
      return plan;
    }

    for (const item of plan.items) {
      console.log(
        `${execute ? '[실행]' : '[DRY-RUN]'} ${item.discordId}: +${item.amount.toLocaleString()}P`
      );
    }
    console.log(`총 지급액: ${plan.totalDistributed.toLocaleString()}P (반올림 잔돈은 하우스에 남음)`);

    if (execute) {
      for (const item of plan.items) {
        await applyTransaction(tx, {
          discordId: item.discordId,
          type: TransactionType.REBATE,
          amount: item.amount,
          description: '하우스 캡 초과분 catch-up 정산',
          occurredAt: now,
        });
      }
      await applyHouseTransaction(tx, {
        type: TransactionType.REBATE,
        amount: -plan.totalDistributed,
        description: '하우스 캡 초과분 catch-up 재원 지급 (일회성)',
        occurredAt: now,
      });
    }

    return plan;
  });
}

async function main() {
  // 💡 '../config/env'의 env 객체는 DISCORD_TOKEN 등을 import 시점에 즉시 검증(없으면 throw)한다 -
  // 이 스크립트는 테스트가 직접 import하므로(runCatchUp/buildCatchUpPlan 단위 테스트), 거기서
  // env를 정적 import하면 .env가 없는 환경(새 워크트리, CI 등)에서 테스트 스위트 전체가 깨진다.
  // main()이 실제로 실행될 때만(= 이 스크립트를 직접 실행할 때만) dotenv를 동적으로 로드한다.
  await import('dotenv/config');
  const execute = process.argv.includes('--execute');
  // 봇 자신은 절대 catch-up 지급 대상이 되면 안 되므로, 봇의 Discord ID(=DISCORD_CLIENT_ID)를
  // 명시적으로 제외한다. (runDistributionBatch()의 client.user?.id 제외와 동일한 취지)
  const plan = await runCatchUp(execute, undefined, { excludeUserId: process.env.DISCORD_CLIENT_ID });

  if (!execute || plan.totalDistributed <= 0) {
    // dry-run이거나 실제 지급액이 없으면 디스코드 공지 없이 콘솔 출력만으로 충분하다 -
    // 불필요한 로그인 자체를 생략해 더 가볍게 만든다.
    return;
  }

  // 💡 이 스크립트는 상시 실행 중인 봇 프로세스가 아니라 관리자가 직접 실행하는 CLI라서,
  // 공지를 보내야 할 때만 잠깐 로그인했다가 바로 끊는다. (manualLotteryDraw.ts와 동일한 패턴)
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  try {
    await new Promise<void>((resolve, reject) => {
      client.once('ready', () => resolve());
      client.login(process.env.DISCORD_TOKEN).catch(reject);
    });

    const config = await getOrCreateEconomyConfig();
    const { house, totalEconomy } = await getEconomySnapshot();
    await sendRebateAnnouncement(client, config.rebateAnnounceChannelId, {
      reason: 'CATCH_UP',
      distributed: true,
      totalDistributed: plan.totalDistributed,
      perUserAmounts: plan.items,
      houseBalanceAfter: house.balance,
      totalEconomy,
      capRatio: config.houseBalanceCapRatio,
    });
    console.log('디스코드 채널에 공지 메시지를 보냈습니다.');
  } catch (error) {
    // 공지 실패는 지급(DB 처리) 결과에 영향을 주지 않는다 - runCatchUp()이 이미 끝난 뒤이므로.
    if (
      error instanceof DiscordAPIError &&
      (error.code === MISSING_PERMISSIONS || error.code === MISSING_ACCESS)
    ) {
      console.error(
        `지급 처리는 정상적으로 완료되었지만, 공지 메시지 전송에 실패했습니다. 봇에게 채널의 ` +
          `"메시지 보내기" 권한이 있는지 확인해주세요. (Discord error code ${error.code})`
      );
    } else {
      console.error('지급 처리는 정상적으로 완료되었지만, 공지 메시지 전송 중 오류가 발생했습니다.', error);
    }
  } finally {
    await client.destroy();
  }
}

if (require.main === module) {
  main()
    .catch((e) => {
      console.error(e);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
