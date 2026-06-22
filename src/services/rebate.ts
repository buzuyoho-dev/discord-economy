import { TransactionType } from '@prisma/client';
import { prisma } from '../db/client';
import { applyHouseTransaction, getOrCreateHouse } from './house';
import { applyTransaction } from './ledger';

const HOUSE_SHARE_THRESHOLD = 0.25;
const REBATE_RATE = 0.5;

export interface RebateCalculation {
  shouldRebate: boolean;
  currentShare: number;
  rebateAmount: number;
}

export function calculateRebate(houseBalance: number, totalUserBalance: number): RebateCalculation {
  const totalEconomy = houseBalance + totalUserBalance;
  if (totalEconomy <= 0) {
    return { shouldRebate: false, currentShare: 0, rebateAmount: 0 };
  }

  const currentShare = houseBalance / totalEconomy;
  if (currentShare <= HOUSE_SHARE_THRESHOLD) {
    return { shouldRebate: false, currentShare, rebateAmount: 0 };
  }

  const fullExcess = houseBalance - HOUSE_SHARE_THRESHOLD * totalEconomy;
  const rebateAmount = Math.floor(fullExcess * REBATE_RATE);

  return { shouldRebate: rebateAmount > 0, currentShare, rebateAmount };
}

export function distributeRebate(userIds: string[], rebateAmount: number): Map<string, number> {
  const sortedIds = [...userIds].sort();
  const result = new Map<string, number>();
  if (sortedIds.length === 0) {
    return result;
  }

  const base = Math.floor(rebateAmount / sortedIds.length);
  const remainder = rebateAmount % sortedIds.length;

  sortedIds.forEach((discordId, index) => {
    result.set(discordId, base + (index < remainder ? 1 : 0));
  });

  return result;
}

export interface WeeklyRebateResult {
  rebated: boolean;
  currentShare: number;
  rebateAmount: number;
  perUserAmounts: Map<string, number>;
}

export async function applyWeeklyRebate(now: Date = new Date()): Promise<WeeklyRebateResult> {
  return prisma.$transaction(async (tx) => {
    const house = await getOrCreateHouse(tx);
    const users = await tx.user.findMany({ select: { discordId: true, balance: true } });
    const totalUserBalance = users.reduce((sum, user) => sum + user.balance, 0);

    const { shouldRebate, currentShare, rebateAmount } = calculateRebate(
      house.balance,
      totalUserBalance
    );

    if (!shouldRebate) {
      return { rebated: false, currentShare, rebateAmount: 0, perUserAmounts: new Map() };
    }

    const perUserAmounts = distributeRebate(users.map((user) => user.discordId), rebateAmount);

    await applyHouseTransaction(tx, {
      type: TransactionType.REBATE,
      amount: -rebateAmount,
      description: '주간 하우스 점유율 환원',
      occurredAt: now,
    });

    for (const discordId of [...perUserAmounts.keys()].sort()) {
      const amount = perUserAmounts.get(discordId)!;
      if (amount <= 0) {
        continue;
      }
      await applyTransaction(tx, {
        discordId,
        type: TransactionType.REBATE,
        amount,
        description: '주간 하우스 점유율 환원',
        occurredAt: now,
      });
    }

    return { rebated: true, currentShare, rebateAmount, perUserAmounts };
  });
}
