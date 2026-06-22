import { TransactionType } from '@prisma/client';
import { prisma } from '../db/client';
import { applyHouseTransaction } from './house';
import { isSameKstDay } from './kst';
import { applyTransaction, getOrCreateUser } from './ledger';

export const GAMBLE_AMOUNT = 1_000_000;
export const MAX_GAMBLES_PER_DAY = 2;
const WIN_THRESHOLD = 0.5;

export class DailyGambleLimitExceededError extends Error {
  constructor(discordId: string) {
    super(`${discordId} already gambled ${MAX_GAMBLES_PER_DAY} times today (KST)`);
    this.name = 'DailyGambleLimitExceededError';
  }
}

export class InsufficientBalanceForGambleError extends Error {
  constructor(discordId: string) {
    super(`${discordId} has insufficient balance to gamble`);
    this.name = 'InsufficientBalanceForGambleError';
  }
}

export interface GambleResult {
  won: boolean;
  amount: number;
  balanceAfter: number;
}

const ROLLBACK_REF_PATTERN = /원거래 #(\d+)/;

export function buildGambleRollbackDescription(originalTransactionId: number): string {
  return `도박 버그 롤백 (원거래 #${originalTransactionId})`;
}

function parseRolledBackTransactionId(description: string | null): number | null {
  const match = description?.match(ROLLBACK_REF_PATTERN);
  return match ? Number(match[1]) : null;
}

export async function gamble(params: {
  discordId: string;
  now?: Date;
  random?: () => number;
}): Promise<GambleResult> {
  const now = params.now ?? new Date();
  const random = params.random ?? Math.random;

  await getOrCreateUser(params.discordId);

  return prisma.$transaction(async (tx) => {
    const recentGambles = await tx.transaction.findMany({
      where: {
        userId: params.discordId,
        type: { in: [TransactionType.GAMBLE_WIN, TransactionType.GAMBLE_LOSE] },
      },
      orderBy: { createdAt: 'desc' },
      take: MAX_GAMBLES_PER_DAY,
    });
    const todaysGambles = recentGambles.filter((g) => isSameKstDay(g.createdAt, now));

    let todaysCount = todaysGambles.length;
    if (todaysGambles.length > 0) {
      const rollbacks = await tx.transaction.findMany({
        where: { userId: params.discordId, type: TransactionType.GAMBLE_ROLLBACK },
        select: { description: true },
      });
      const rolledBackIds = new Set(
        rollbacks
          .map((r) => parseRolledBackTransactionId(r.description))
          .filter((id): id is number => id !== null)
      );
      todaysCount = todaysGambles.filter((g) => !rolledBackIds.has(g.id)).length;
    }

    if (todaysCount >= MAX_GAMBLES_PER_DAY) {
      throw new DailyGambleLimitExceededError(params.discordId);
    }

    const user = await tx.user.findUniqueOrThrow({ where: { discordId: params.discordId } });
    if (user.balance < GAMBLE_AMOUNT) {
      throw new InsufficientBalanceForGambleError(params.discordId);
    }

    const won = random() < WIN_THRESHOLD;

    if (won) {
      const updated = await applyTransaction(tx, {
        discordId: params.discordId,
        type: TransactionType.GAMBLE_WIN,
        amount: GAMBLE_AMOUNT,
        description: '도박 승리',
        occurredAt: now,
      });
      return { won: true, amount: GAMBLE_AMOUNT, balanceAfter: updated.balance };
    }

    const updated = await applyTransaction(tx, {
      discordId: params.discordId,
      type: TransactionType.GAMBLE_LOSE,
      amount: -GAMBLE_AMOUNT,
      description: '도박 패배',
      occurredAt: now,
    });

    await applyHouseTransaction(tx, {
      type: TransactionType.GAMBLE_LOSE,
      amount: GAMBLE_AMOUNT,
      description: `도박 패배 귀속: ${params.discordId}`,
      occurredAt: now,
    });

    return { won: false, amount: -GAMBLE_AMOUNT, balanceAfter: updated.balance };
  });
}
