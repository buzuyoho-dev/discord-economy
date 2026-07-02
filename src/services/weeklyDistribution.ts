import { TransactionType } from '@prisma/client';
import { prisma } from '../db/client';
import { getOrCreateEconomyConfig } from './economyConfig';
import { applyHouseTransaction, getOrCreateHouse, HOUSE_ID } from './house';
import { applyTransaction } from './ledger';

const LOWER_TIER_RATIO = 0.3;
const COUPON_VALIDITY_MS = 7 * 24 * 60 * 60 * 1000;

export interface WeeklyDistributionResult {
  distributed: boolean;
  fundAmount: number;
  lowerTierCount: number;
  couponsIssued: number;
  perUserAmounts: Map<string, number>;
}

export async function weeklyDistribution(now: Date = new Date()): Promise<WeeklyDistributionResult> {
  return prisma.$transaction(async (tx) => {
    const config = await getOrCreateEconomyConfig(tx);
    const house = await getOrCreateHouse(tx);

    const netGain = Math.max(0, house.balance - house.lastRebateBalance);
    const fundAmount = Math.floor(netGain * config.rebateRate);

    const users = await tx.user.findMany({
      orderBy: { balance: 'asc' },
      select: { discordId: true, balance: true },
    });
    const lowerTierCount = Math.floor(users.length * LOWER_TIER_RATIO);
    const lowerTierUsers = users.slice(0, lowerTierCount);
    const lowerTierIds = new Set(lowerTierUsers.map((user) => user.discordId));

    const perUserAmounts = new Map<string, number>();

    if (fundAmount > 0 && users.length > 0) {
      const totalWeight = users.length + lowerTierCount * (config.lowerTierWeight - 1);
      const unitShare = Math.floor(fundAmount / totalWeight);

      for (const user of users) {
        const amount = lowerTierIds.has(user.discordId)
          ? Math.floor(unitShare * config.lowerTierWeight)
          : unitShare;
        if (amount <= 0) {
          continue;
        }
        perUserAmounts.set(user.discordId, amount);
        await applyTransaction(tx, {
          discordId: user.discordId,
          type: TransactionType.REBATE,
          amount,
          description: '주간 환급',
          occurredAt: now,
        });
      }
    }

    const totalDistributed = [...perUserAmounts.values()].reduce((sum, amount) => sum + amount, 0);
    const distributed = totalDistributed > 0;

    if (distributed) {
      const updatedHouse = await applyHouseTransaction(tx, {
        type: TransactionType.REBATE,
        amount: -totalDistributed,
        description: '주간 환급 재원 지급 (반올림 잔돈은 하우스에 남김)',
        occurredAt: now,
      });
      await tx.house.update({
        where: { id: HOUSE_ID },
        data: { lastRebateBalance: updatedHouse.balance, lastRebateAt: now },
      });
    } else {
      // 재원이 없어도 다음 주 순증가분 계산 기준이 꼬이지 않도록 현재 값으로 체크포인트를 갱신한다.
      await tx.house.update({
        where: { id: HOUSE_ID },
        data: { lastRebateBalance: house.balance, lastRebateAt: now },
      });
    }

    const expiresAt = new Date(now.getTime() + COUPON_VALIDITY_MS);
    for (const user of lowerTierUsers) {
      await tx.bettingDoubleCoupon.create({
        data: { userId: user.discordId, issuedAt: now, expiresAt },
      });
    }

    return {
      distributed,
      fundAmount,
      lowerTierCount: lowerTierUsers.length,
      couponsIssued: lowerTierUsers.length,
      perUserAmounts,
    };
  });
}
