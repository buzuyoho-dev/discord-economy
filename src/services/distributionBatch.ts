import { Prisma, TransactionType } from '@prisma/client';
import { prisma } from '../db/client';
import { getOrCreateEconomyConfig } from './economyConfig';
import { applyHouseTransaction, getOrCreateHouse, HOUSE_ID } from './house';
import { applyTransaction } from './ledger';

type Db = Prisma.TransactionClient | typeof prisma;

const LOWER_TIER_RATIO = 0.3;
const COUPON_VALIDITY_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_VALID_COUPONS_PER_USER = 2;

export interface DistributionBatchResult {
  distributed: boolean;
  fundAmount: number;
  lowerTierCount: number;
  couponsIssued: number;
  couponsSkipped: number;
  perUserAmounts: Map<string, number>;
}

// 순위(잔액) 기준 하위 30% 유저 discordId 목록. distributionBatch()와 1회성 긴급 발급 스크립트
// 양쪽에서 동일한 "하위 플레이어" 판정을 재사용한다.
export async function getLowerTierUserIds(db: Db): Promise<string[]> {
  const users = await db.user.findMany({
    orderBy: { balance: 'asc' },
    select: { discordId: true },
  });
  const lowerTierCount = Math.floor(users.length * LOWER_TIER_RATIO);
  return users.slice(0, lowerTierCount).map((user) => user.discordId);
}

export interface CouponIssuanceResult {
  issuedUserIds: string[];
  skippedUserIds: string[];
}

// 주어진 유저 목록에 베팅2배쿠폰을 발급한다 - 이미 미사용+미만료 쿠폰을
// MAX_VALID_COUPONS_PER_USER장 이상 보유 중이면 조용히 스킵한다(에러 없음).
export async function issueCouponsForUsers(
  db: Db,
  userIds: string[],
  now: Date
): Promise<CouponIssuanceResult> {
  const expiresAt = new Date(now.getTime() + COUPON_VALIDITY_MS);
  const issuedUserIds: string[] = [];
  const skippedUserIds: string[] = [];

  for (const userId of userIds) {
    const validCouponCount = await db.bettingDoubleCoupon.count({
      where: { userId, usedAt: null, expiresAt: { gt: now } },
    });

    if (validCouponCount >= MAX_VALID_COUPONS_PER_USER) {
      skippedUserIds.push(userId);
      continue;
    }

    await db.bettingDoubleCoupon.create({
      data: { userId, issuedAt: now, expiresAt },
    });
    issuedUserIds.push(userId);
  }

  return { issuedUserIds, skippedUserIds };
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
    const lowerTierUserIds = await getLowerTierUserIds(tx);
    const lowerTierCount = lowerTierUserIds.length;
    const lowerTierIds = new Set(lowerTierUserIds);

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

    const { issuedUserIds, skippedUserIds } = await issueCouponsForUsers(tx, lowerTierUserIds, now);

    return {
      distributed,
      fundAmount,
      lowerTierCount,
      couponsIssued: issuedUserIds.length,
      couponsSkipped: skippedUserIds.length,
      perUserAmounts,
    };
  });
}
