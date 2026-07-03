import { TransactionType } from '@prisma/client';
import { prisma } from '../db/client';
import { getOrCreateEconomyConfig } from './economyConfig';
import { applyHouseTransaction, getOrCreateHouse, HOUSE_ID } from './house';
import { applyTransaction } from './ledger';

const LOWER_TIER_RATIO = 0.3;
const COUPON_VALIDITY_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_VALID_COUPONS_PER_USER = 2;

export interface DistributionBatchResult {
  distributed: boolean;
  fundAmount: number;
  lowerTierCount: number;
  couponsIssued: number;
  couponsSkipped: number;
  perUserAmounts: Map<string, number>;
}

export async function distributionBatch(now: Date = new Date()): Promise<DistributionBatchResult> {
  return prisma.$transaction(async (tx) => {
    const config = await getOrCreateEconomyConfig(tx);
    const house = await getOrCreateHouse(tx);

    // 실행 간격이 얼마든(주 1회든 주 3회든) 이 시점의 순증가분만 계산하므로 빈도 변경과 무관하다.
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
          description: '환급',
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
        description: '환급 재원 지급 (반올림 잔돈은 하우스에 남김)',
        occurredAt: now,
      });
      await tx.house.update({
        where: { id: HOUSE_ID },
        data: { lastRebateBalance: updatedHouse.balance, lastRebateAt: now },
      });
    } else {
      // 재원이 없어도 다음 실행의 순증가분 계산 기준이 꼬이지 않도록 현재 값으로 체크포인트를 갱신한다.
      await tx.house.update({
        where: { id: HOUSE_ID },
        data: { lastRebateBalance: house.balance, lastRebateAt: now },
      });
    }

    // 베팅2배쿠폰: 유저가 이미 미사용+미만료 쿠폰을 MAX_VALID_COUPONS_PER_USER장 이상 보유하고
    // 있으면 이번 발급 대상에서 조용히 제외한다(에러 없음).
    const expiresAt = new Date(now.getTime() + COUPON_VALIDITY_MS);
    let couponsIssued = 0;
    let couponsSkipped = 0;

    for (const user of lowerTierUsers) {
      const validCouponCount = await tx.bettingDoubleCoupon.count({
        where: { userId: user.discordId, usedAt: null, expiresAt: { gt: now } },
      });

      if (validCouponCount >= MAX_VALID_COUPONS_PER_USER) {
        couponsSkipped += 1;
        continue;
      }

      await tx.bettingDoubleCoupon.create({
        data: { userId: user.discordId, issuedAt: now, expiresAt },
      });
      couponsIssued += 1;
    }

    return {
      distributed,
      fundAmount,
      lowerTierCount: lowerTierUsers.length,
      couponsIssued,
      couponsSkipped,
      perUserAmounts,
    };
  });
}
