import { Prisma, TransactionType } from '@prisma/client';
import { prisma } from '../db/client';
import { getOrCreateEconomyConfig } from './economyConfig';
import { applyHouseTransaction, computeHouseCapExcess, getEconomySnapshot, HOUSE_ID } from './house';
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
// 💡 excludeUserId를 넘기면(봇 자신의 ID 등) 그 유저는 인원수 계산과 대상 목록 양쪽에서
// 완전히 빠진다 - 봇 명의 User row가 어떤 이유로든 남아있어도 환급/쿠폰 대상이 되지 않는다.
export async function getLowerTierUserIds(db: Db, options?: { excludeUserId?: string }): Promise<string[]> {
  const users = await db.user.findMany({
    where: options?.excludeUserId ? { discordId: { not: options.excludeUserId } } : undefined,
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

export interface RebateDistributionResult {
  perUserAmounts: Map<string, number>;
  totalDistributed: number;
}

// 정기 배치와 catch-up 스크립트가 공유하는 순수 분배 함수 (DB 접근 없음).
// fundAmount를 "일반 유저 1지분 + 하위 30% 유저는 lowerTierWeight배" 규칙으로 나눈다.
export function computeRebateDistribution(params: {
  users: { discordId: string }[];
  lowerTierUserIds: string[];
  fundAmount: number;
  lowerTierWeight: number;
}): RebateDistributionResult {
  const lowerTierIds = new Set(params.lowerTierUserIds);
  const perUserAmounts = new Map<string, number>();

  if (params.fundAmount <= 0 || params.users.length === 0) {
    return { perUserAmounts, totalDistributed: 0 };
  }

  const totalWeight =
    params.users.length + params.lowerTierUserIds.length * (params.lowerTierWeight - 1);
  const unitShare = Math.floor(params.fundAmount / totalWeight);

  let totalDistributed = 0;
  for (const user of params.users) {
    const amount = lowerTierIds.has(user.discordId)
      ? Math.floor(unitShare * params.lowerTierWeight)
      : unitShare;
    if (amount <= 0) continue;
    perUserAmounts.set(user.discordId, amount);
    totalDistributed += amount;
  }

  return { perUserAmounts, totalDistributed };
}

export async function distributionBatch(
  now: Date = new Date(),
  options?: { excludeUserId?: string }
): Promise<DistributionBatchResult> {
  return prisma.$transaction(async (tx) => {
    const config = await getOrCreateEconomyConfig(tx);
    const { house, totalEconomy } = await getEconomySnapshot(tx);

    // 예전 방식: "순증가분(house.balance - lastRebateBalance) × rebateRate(5%)".
    // 하우스 유입 속도가 빨라지면 환급이 못 따라가는 문제가 있어(2026-07 하우스 잔고
    // 75%까지 급증) "하우스가 전체 경제의 houseBalanceCapRatio를 넘지 않도록 초과분
    // 전액을 환급"하는 방식으로 교체했다. rebateRate는 스키마/DB에는 남겨두지만
    // (추후 다른 용도로 재사용될 수 있어 완전히 제거하지 않음) 이 계산에는 더 이상
    // 쓰이지 않는다.
    const { excessAmount: fundAmount } = computeHouseCapExcess({
      totalEconomy,
      houseBalance: house.balance,
      capRatio: config.houseBalanceCapRatio,
    });

    const users = await tx.user.findMany({
      where: options?.excludeUserId ? { discordId: { not: options.excludeUserId } } : undefined,
      orderBy: { balance: 'asc' },
      select: { discordId: true },
    });
    const lowerTierUserIds = await getLowerTierUserIds(tx, options);

    const { perUserAmounts, totalDistributed } = computeRebateDistribution({
      users,
      lowerTierUserIds,
      fundAmount,
      lowerTierWeight: config.lowerTierWeight,
    });

    for (const [discordId, amount] of perUserAmounts) {
      await applyTransaction(tx, {
        discordId,
        type: TransactionType.REBATE,
        amount,
        description: '환급',
        occurredAt: now,
      });
    }

    const distributed = totalDistributed > 0;

    if (distributed) {
      const updatedHouse = await applyHouseTransaction(tx, {
        type: TransactionType.REBATE,
        amount: -totalDistributed,
        description: '환급 재원 지급 (하우스 캡 초과분, 반올림 잔돈은 하우스에 남김)',
        occurredAt: now,
      });
      await tx.house.update({
        where: { id: HOUSE_ID },
        data: { lastRebateBalance: updatedHouse.balance, lastRebateAt: now },
      });
    } else {
      // 초과분이 없어도 감사 기록 차원에서 체크포인트는 현재 값으로 갱신한다.
      await tx.house.update({
        where: { id: HOUSE_ID },
        data: { lastRebateBalance: house.balance, lastRebateAt: now },
      });
    }

    const { issuedUserIds, skippedUserIds } = await issueCouponsForUsers(tx, lowerTierUserIds, now);

    return {
      distributed,
      fundAmount,
      lowerTierCount: lowerTierUserIds.length,
      couponsIssued: issuedUserIds.length,
      couponsSkipped: skippedUserIds.length,
      perUserAmounts,
    };
  });
}
