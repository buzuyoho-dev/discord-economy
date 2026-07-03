// 💡 "오픈 기념 이벤트" - 전체(혹은 최근 활동) 유저에게 블랙잭 "오늘 하루 잔여 플레이 횟수"를
// +2씩 한 번만 지급하는 1회성 스크립트다. 상시 슬래시 커맨드가 아니라 관리자가 터미널에서
// 딱 한 번 실행하고 끝내는 용도라서 src/commands/index.ts에는 등록하지 않는다.
//
// ⚠️ 중요: 이 보너스는 "영구히 +2"가 아니라 "오늘(KST 기준) 하루만 +2"다.
// 블랙잭 플레이 횟수는 MinigamePlayLog에 날짜별로 따로 저장되고 자정(KST)이 지나면
// 새 날짜 row가 만들어지면서 자연스럽게 초기화되기 때문에, 이 보너스도 딱 오늘치에만 적용된다.
//
// 사용법 (프로젝트 루트에서 실행):
//   npx tsx src/scripts/grantBlackjackBonus.ts                          -> DRY RUN, 전체 유저 대상
//   npx tsx src/scripts/grantBlackjackBonus.ts --confirm                -> 실제 지급, 전체 유저 대상
//   npx tsx src/scripts/grantBlackjackBonus.ts --active-days 7          -> DRY RUN, 최근 7일 내 활동 유저만
//   npx tsx src/scripts/grantBlackjackBonus.ts --active-days 7 --confirm -> 실제 지급, 최근 7일 내 활동 유저만

import fs from 'node:fs';
import path from 'node:path';
import type { Prisma } from '@prisma/client';
import { prisma } from '../db/client';
import { BLACKJACK_GAME_TYPE, MAX_PLAYS_PER_DAY } from '../services/blackjackGame';
import { kstMidnightUtc } from '../services/kst';

// 💡 distributionBatch.ts와 동일한 패턴: 트랜잭션 안(tx)/밖(prisma) 어느 쪽에서 불려도 되게 타입을 열어둔다.
type Db = Prisma.TransactionClient | typeof prisma;

export const BONUS_PLAYS = 2; // 💡 오늘 잔여 횟수에 몇 번을 얹어줄지 (이번 이벤트 요청: +2)
export const EVENT_REASON = '오픈 기념 이벤트 - 블랙잭 하루 잔여 횟수 +2 일괄 지급';

// 💡 유저 한 명의 "지급 전 -> 지급 후" 잔여 횟수를 담는 미리보기 항목.
// dry-run이든 실제 실행이든 항상 이 배열을 만들어서, 실행 결과 로그에도 그대로 남긴다.
export interface GrantPlanItem {
  userId: string;
  playsRemainingBefore: number;
  playsRemainingAfter: number;
}

export interface GrantBlackjackBonusResult {
  targetScope: string;
  targetUserIds: string[];
  plan: GrantPlanItem[];
}

// 💡 MinigamePlayLog.count(오늘 플레이한 횟수)로부터 "오늘 남은 횟수"를 계산한다.
// count가 0이면 아직 한 번도 안 한 것 -> MAX_PLAYS_PER_DAY(5)가 그대로 남아있는 것.
function playsRemainingFromCount(count: number): number {
  return MAX_PLAYS_PER_DAY - count;
}

// 💡 지급 "대상"을 고르는 함수.
// - activeSinceDays를 안 주면: DB에 있는 모든 유저.
// - activeSinceDays를 주면(N): 최근 N일 안에 포인트 거래(Transaction)가 한 번이라도 있었던 유저만.
//   Transaction 테이블은 베팅/미니게임/양도/환급 등 포인트가 움직이는 모든 경로를 이미 다 기록하고
//   있으므로(PROGRESS.md 참고), "최근 활동 여부"를 판단하는 가장 포괄적인 기준으로 재사용한다.
async function getTargetUserIds(
  tx: Db,
  activeSinceDays: number | undefined,
  now: Date
): Promise<{ scope: string; userIds: string[] }> {
  if (activeSinceDays === undefined) {
    const users = await tx.user.findMany({ select: { discordId: true } });
    return { scope: '전체 유저', userIds: users.map((u) => u.discordId) };
  }

  const cutoff = new Date(now.getTime() - activeSinceDays * 24 * 60 * 60 * 1000);
  const recentTransactions = await tx.transaction.findMany({
    where: { createdAt: { gte: cutoff } },
    distinct: ['userId'],
    select: { userId: true },
  });
  return {
    scope: `최근 ${activeSinceDays}일 내 활동 유저`,
    userIds: recentTransactions.map((t) => t.userId),
  };
}

export async function grantBlackjackBonus(options: {
  execute: boolean;
  activeSinceDays?: number;
  now?: Date;
}): Promise<GrantBlackjackBonusResult> {
  const now = options.now ?? new Date();
  const playDate = kstMidnightUtc(now); // 💡 "오늘"을 KST 자정 기준으로 고정 - 블랙잭 로직과 동일한 날짜 계산 함수를 재사용한다.

  // 💡 전체를 하나의 트랜잭션으로 묶어서, 중간에 에러가 나면 일부만 지급되는 일이 없게 한다
  // (기존 emergencyIssueLowerTierCoupons.ts, resetServerBalances.ts와 동일한 패턴).
  return prisma.$transaction(async (tx) => {
    const { scope, userIds: targetUserIds } = await getTargetUserIds(tx, options.activeSinceDays, now);

    // 💡 대상 유저들이 오늘 이미 몇 번 플레이했는지 한 번에 조회해서 "지급 전" 값을 만든다.
    const existingLogs = await tx.minigamePlayLog.findMany({
      where: { userId: { in: targetUserIds }, gameType: BLACKJACK_GAME_TYPE, playDate },
    });
    const countByUserId = new Map(existingLogs.map((log) => [log.userId, log.count]));

    const plan: GrantPlanItem[] = targetUserIds.map((userId) => {
      const countBefore = countByUserId.get(userId) ?? 0;
      return {
        userId,
        playsRemainingBefore: playsRemainingFromCount(countBefore),
        // 💡 "잔여 횟수 +2"는 곧 "오늘 플레이 횟수(count) -2"와 같다 (count가 낮을수록 남은 횟수가 많아짐).
        playsRemainingAfter: playsRemainingFromCount(countBefore - BONUS_PLAYS),
      };
    });

    if (options.execute) {
      for (const userId of targetUserIds) {
        // 💡 오늘 기록이 아예 없던 유저는 count: -BONUS_PLAYS로 새로 만든다.
        // (예: -2로 시작하면 나중에 실제로 2번 플레이해도 count는 0이 되어 5번을 꽉 채워 쓸 수 있다 = 기본 5 + 보너스 2)
        // 이미 기록이 있는 유저는 count를 BONUS_PLAYS만큼 그냥 깎아준다.
        await tx.minigamePlayLog.upsert({
          where: {
            userId_gameType_playDate: { userId, gameType: BLACKJACK_GAME_TYPE, playDate },
          },
          create: { userId, gameType: BLACKJACK_GAME_TYPE, playDate, count: -BONUS_PLAYS },
          update: { count: { decrement: BONUS_PLAYS } },
        });
      }
    }

    return { targetScope: scope, targetUserIds, plan };
  });
}

// 💡 실제 지급(--confirm)이 끝난 뒤에만 호출된다. "언제 / 몇 명에게 / 왜" 지급했는지를
// logs/ 폴더에 파일로 남겨서, 나중에 "그때 그 이벤트 언제 돌렸었지?"를 추적할 수 있게 한다.
// (.gitignore에 *.log가 이미 등록되어 있어서 이 로그 파일은 커밋되지 않는다.)
function writeGrantLog(result: GrantBlackjackBonusResult, activeSinceDays: number | undefined): string {
  const logsDir = path.join(__dirname, '..', '..', 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  const executedAt = new Date();
  const fileTimestamp = executedAt.toISOString().replace(/[:.]/g, '-');
  const logPath = path.join(logsDir, `grantBlackjackBonus-${fileTimestamp}.log`);

  const logBody = {
    executedAt: executedAt.toISOString(),
    reason: EVENT_REASON,
    bonusPlays: BONUS_PLAYS,
    targetScope: result.targetScope,
    targetUserCount: result.targetUserIds.length,
    plan: result.plan,
  };

  fs.writeFileSync(logPath, JSON.stringify(logBody, null, 2), 'utf-8');
  return logPath;
}

async function main() {
  const args = process.argv.slice(2);
  const execute = args.includes('--confirm');

  const activeDaysFlagIndex = args.indexOf('--active-days');
  let activeSinceDays: number | undefined;
  if (activeDaysFlagIndex !== -1) {
    const rawValue = Number(args[activeDaysFlagIndex + 1]);
    if (!Number.isInteger(rawValue) || rawValue <= 0) {
      console.error('--active-days 뒤에는 1 이상의 정수를 입력해주세요. 예: --active-days 7');
      process.exitCode = 1;
      return;
    }
    activeSinceDays = rawValue;
  }

  const result = await grantBlackjackBonus({ execute, activeSinceDays });

  console.log('');
  console.log(execute ? '=== 블랙잭 오픈 기념 보너스 지급 결과 ===' : '=== DRY RUN 결과 (DB에 쓰지 않음) ===');
  console.log(`대상 범위: ${result.targetScope}`);
  console.log(`지급 내용: 블랙잭 오늘(KST) 잔여 횟수 +${BONUS_PLAYS}`);
  console.log(`대상 유저 수: ${result.targetUserIds.length}명`);
  console.log('');
  for (const item of result.plan) {
    console.log(`  ${item.userId}: ${item.playsRemainingBefore} -> ${item.playsRemainingAfter}`);
  }

  if (execute) {
    const logPath = writeGrantLog(result, activeSinceDays);
    console.log('');
    console.log(`실행 로그 저장 완료: ${logPath}`);
  } else {
    console.log('');
    console.log('DRY RUN입니다. 실제로 지급하려면 뒤에 --confirm 플래그를 추가해서 다시 실행하세요.');
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
