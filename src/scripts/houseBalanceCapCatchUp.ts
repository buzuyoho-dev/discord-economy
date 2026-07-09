import { Prisma, TransactionType } from '@prisma/client';
import { prisma } from '../db/client';
import { computeRebateDistribution, getLowerTierUserIds } from '../services/distributionBatch';
import { getOrCreateEconomyConfig } from '../services/economyConfig';
import { applyHouseTransaction, computeHouseCapExcess, getEconomySnapshot } from '../services/house';
import { applyTransaction } from '../services/ledger';

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

async function buildCatchUpPlan(db: Db): Promise<CatchUpPlan> {
  const config = await getOrCreateEconomyConfig(db);
  const { house, totalEconomy } = await getEconomySnapshot(db);
  const { capAmount, excessAmount } = computeHouseCapExcess({
    totalEconomy,
    houseBalance: house.balance,
    capRatio: config.houseBalanceCapRatio,
  });

  const users = await db.user.findMany({ select: { discordId: true } });
  const lowerTierUserIds = await getLowerTierUserIds(db);
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
export async function runCatchUp(execute: boolean, now: Date = new Date()): Promise<CatchUpPlan> {
  return prisma.$transaction(async (tx) => {
    const plan = await buildCatchUpPlan(tx);

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
  const execute = process.argv.includes('--execute');
  await runCatchUp(execute);
}

if (require.main === module) {
  main()
    .catch((e) => {
      console.error(e);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
