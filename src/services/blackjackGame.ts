// 💡 이 파일은 블랙잭 게임과 "돈/DB"가 만나는 지점이다. 카드 규칙 자체는 blackjack.ts가
// 담당하고, 여기서는 "베팅금 차감", "정산 지급", "오늘 몇 번 했는지 기록"만 다룬다.
// 모든 돈 처리는 기존 베팅 시스템(mode1Bet.ts 등)과 똑같이 prisma.$transaction으로
// 감싸서, 동시에 여러 요청이 와도 중복 차감/누락이 일어나지 않게 한다.

import { TransactionType } from '@prisma/client';
import { prisma } from '../db/client';
import { type BlackjackOutcome, calculatePayout, validateBetAmount } from './blackjack';
import { applyHouseTransaction } from './house';
import { kstMidnightUtc } from './kst';
import { applyTransaction, getOrCreateUser } from './ledger';

export const BLACKJACK_GAME_TYPE = 'BLACKJACK';
export const MAX_PLAYS_PER_DAY = 5; // 💡 블랙잭은 하루에 최대 5번까지만 할 수 있다 (스펙 고정값)

// 💡 오늘 이미 5번 다 썼는데 또 하려고 하면 이 에러가 난다.
export class DailyPlayLimitExceededError extends Error {
  constructor(discordId: string, public readonly limit: number) {
    super(`${discordId} already played blackjack ${limit} times today (KST)`);
    this.name = 'DailyPlayLimitExceededError';
  }
}

// 💡 "게임을 시작한다" = 오늘 횟수/베팅금 규칙을 확인하고, 통과하면 베팅금을 바로 차감한다.
// 카드를 나눠주는 건 여기서 하지 않는다(순수 카드 로직은 blackjack.ts, 실제로 카드를 뽑아서
// 들고 있는 건 디스코드 쪽 인메모리 상태가 담당).
export async function startBlackjackGame(params: {
  discordId: string;
  betAmount: number;
  now?: Date;
}): Promise<{ balanceAfter: number }> {
  const now = params.now ?? new Date();

  // 💡 유저가 아직 한 번도 뭘 안 해봤으면(User row가 없으면) 여기서 시작 포인트를 만들어준다.
  await getOrCreateUser(params.discordId);

  return prisma.$transaction(async (tx) => {
    // 1) 오늘 이미 5번 했는지 확인
    const playDate = kstMidnightUtc(now);
    const existingLog = await tx.minigamePlayLog.findUnique({
      where: {
        userId_gameType_playDate: {
          userId: params.discordId,
          gameType: BLACKJACK_GAME_TYPE,
          playDate,
        },
      },
    });
    const playedToday = existingLog?.count ?? 0;
    if (playedToday >= MAX_PLAYS_PER_DAY) {
      throw new DailyPlayLimitExceededError(params.discordId, MAX_PLAYS_PER_DAY);
    }

    // 2) 베팅금이 최소/최대 규칙에 맞는지 확인 (현재 잔액 기준)
    const user = await tx.user.findUniqueOrThrow({ where: { discordId: params.discordId } });
    validateBetAmount(params.betAmount, user.balance);

    // 3) 통과했으면 베팅금을 바로 차감한다 (원자적 - 이 트랜잭션 안에서 잔액을 다시 읽고
    // 감소시키므로, 동시에 두 번 요청이 와도 한쪽만 성공한다).
    const updated = await applyTransaction(tx, {
      discordId: params.discordId,
      type: TransactionType.BLACKJACK_BET,
      amount: -params.betAmount,
      description: '블랙잭 베팅',
      occurredAt: now,
    });

    return { balanceAfter: updated.balance };
  });
}

// 💡 "게임을 정산한다" = 결과(WIN/LOSE/PUSH/NATURAL_WIN)에 따라 돈을 지급하고,
// 오늘 플레이 횟수를 1 늘린다. 이것도 전부 하나의 트랜잭션 안에서 처리한다.
export async function settleBlackjackGame(params: {
  discordId: string;
  betAmount: number;
  outcome: BlackjackOutcome;
  now?: Date;
}): Promise<{ balanceAfter: number; playsToday: number; playsRemaining: number }> {
  const now = params.now ?? new Date();
  const payout = calculatePayout(params.betAmount, params.outcome);

  return prisma.$transaction(async (tx) => {
    let balanceAfter: number;

    if (payout > 0) {
      // 💡 PUSH(환급)/WIN(승리)/NATURAL_WIN(자연승) - 유저에게 돈을 지급한다.
      const type =
        params.outcome === 'PUSH' ? TransactionType.BLACKJACK_PUSH : TransactionType.BLACKJACK_WIN;
      const description =
        params.outcome === 'PUSH'
          ? '블랙잭 무승부 환급'
          : params.outcome === 'NATURAL_WIN'
            ? '블랙잭 자연승 정산 (1.5배)'
            : '블랙잭 승리 정산';

      const updated = await applyTransaction(tx, {
        discordId: params.discordId,
        type,
        amount: payout,
        description,
        occurredAt: now,
      });
      balanceAfter = updated.balance;
    } else {
      // 💡 LOSE(패배) - 베팅금은 이미 게임 시작할 때 차감했으므로 유저 쪽엔 더 할 게 없다.
      // 그 돈이 최종적으로 하우스 것이 됐다는 걸 기록만 해준다.
      const user = await tx.user.findUniqueOrThrow({ where: { discordId: params.discordId } });
      balanceAfter = user.balance;

      await applyHouseTransaction(tx, {
        type: TransactionType.BLACKJACK_LOSE,
        amount: params.betAmount,
        description: '블랙잭 패배 귀속',
        occurredAt: now,
      });
    }

    // 💡 오늘 플레이 횟수를 1 늘린다. 오늘 처음이면 새로 만들고(count=1), 이미 있으면 +1.
    const playDate = kstMidnightUtc(now);
    const log = await tx.minigamePlayLog.upsert({
      where: {
        userId_gameType_playDate: {
          userId: params.discordId,
          gameType: BLACKJACK_GAME_TYPE,
          playDate,
        },
      },
      create: { userId: params.discordId, gameType: BLACKJACK_GAME_TYPE, playDate, count: 1 },
      update: { count: { increment: 1 } },
    });

    return {
      balanceAfter,
      playsToday: log.count,
      playsRemaining: MAX_PLAYS_PER_DAY - log.count,
    };
  });
}
