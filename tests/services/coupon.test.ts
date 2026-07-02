import { describe, expect, test } from 'vitest';
import { prisma } from '../../src/db/client';
import {
  findValidCouponForUser,
  listValidCoupons,
  restoreCouponsUsedInBet,
  tryConsumeCoupon,
} from '../../src/services/coupon';

const NOW = new Date('2026-07-05T00:00:00.000Z');

async function createCoupon(params: {
  userId: string;
  expiresAt: Date;
  usedAt?: Date | null;
  usedInBetId?: number | null;
}) {
  return prisma.bettingDoubleCoupon.create({
    data: {
      userId: params.userId,
      expiresAt: params.expiresAt,
      usedAt: params.usedAt ?? null,
      usedInBetId: params.usedInBetId ?? null,
    },
  });
}

describe('findValidCouponForUser / listValidCoupons', () => {
  test('미사용/미만료 쿠폰만 반환하고, 만료 임박한 순으로 정렬한다', async () => {
    await createCoupon({ userId: 'c1', expiresAt: new Date('2026-07-20T00:00:00.000Z') });
    const soon = await createCoupon({ userId: 'c1', expiresAt: new Date('2026-07-06T00:00:00.000Z') });
    await createCoupon({
      userId: 'c1',
      expiresAt: new Date('2026-07-10T00:00:00.000Z'),
      usedAt: NOW,
    }); // 이미 소진
    await createCoupon({ userId: 'c1', expiresAt: new Date('2026-07-01T00:00:00.000Z') }); // 이미 만료

    const found = await findValidCouponForUser('c1', NOW);
    expect(found?.id).toBe(soon.id);

    const list = await listValidCoupons('c1', NOW);
    expect(list).toHaveLength(2);
    expect(list[0].id).toBe(soon.id);
  });

  test('유효한 쿠폰이 없으면 null/빈 배열을 반환한다', async () => {
    const found = await findValidCouponForUser('nobody', NOW);
    expect(found).toBeNull();

    const list = await listValidCoupons('nobody', NOW);
    expect(list).toEqual([]);
  });
});

describe('tryConsumeCoupon', () => {
  test('유효한 쿠폰이면 소진 처리하고 true를 반환한다', async () => {
    const coupon = await createCoupon({ userId: 'winner-1', expiresAt: new Date('2026-07-10T00:00:00.000Z') });

    const consumed = await prisma.$transaction((tx) =>
      tryConsumeCoupon(tx, { couponId: coupon.id, userId: 'winner-1', betId: 42, now: NOW })
    );

    expect(consumed).toBe(true);
    const updated = await prisma.bettingDoubleCoupon.findUniqueOrThrow({ where: { id: coupon.id } });
    expect(updated.usedAt?.toISOString()).toBe(NOW.toISOString());
    expect(updated.usedInBetId).toBe(42);
  });

  test('존재하지 않는 쿠폰ID면 false를 반환한다', async () => {
    const consumed = await prisma.$transaction((tx) =>
      tryConsumeCoupon(tx, { couponId: 'does-not-exist', userId: 'winner-2', betId: 1, now: NOW })
    );
    expect(consumed).toBe(false);
  });

  test('다른 유저의 쿠폰이면 거부한다', async () => {
    const coupon = await createCoupon({ userId: 'owner', expiresAt: new Date('2026-07-10T00:00:00.000Z') });

    const consumed = await prisma.$transaction((tx) =>
      tryConsumeCoupon(tx, { couponId: coupon.id, userId: 'not-owner', betId: 1, now: NOW })
    );

    expect(consumed).toBe(false);
    const unchanged = await prisma.bettingDoubleCoupon.findUniqueOrThrow({ where: { id: coupon.id } });
    expect(unchanged.usedAt).toBeNull();
  });

  test('이미 소진된 쿠폰이면 거부한다', async () => {
    const coupon = await createCoupon({
      userId: 'winner-3',
      expiresAt: new Date('2026-07-10T00:00:00.000Z'),
      usedAt: new Date('2026-07-04T00:00:00.000Z'),
      usedInBetId: 7,
    });

    const consumed = await prisma.$transaction((tx) =>
      tryConsumeCoupon(tx, { couponId: coupon.id, userId: 'winner-3', betId: 99, now: NOW })
    );

    expect(consumed).toBe(false);
    const unchanged = await prisma.bettingDoubleCoupon.findUniqueOrThrow({ where: { id: coupon.id } });
    expect(unchanged.usedInBetId).toBe(7); // 원래 기록 그대로, 덮어써지지 않음
  });

  test('만료된 쿠폰이면 거부한다', async () => {
    const coupon = await createCoupon({ userId: 'winner-4', expiresAt: new Date('2026-07-04T23:59:59.000Z') });

    const consumed = await prisma.$transaction((tx) =>
      tryConsumeCoupon(tx, { couponId: coupon.id, userId: 'winner-4', betId: 1, now: NOW })
    );

    expect(consumed).toBe(false);
  });
});

describe('restoreCouponsUsedInBet', () => {
  test('해당 베팅에서 소진된 쿠폰을 usedAt/usedInBetId 초기화로 되돌린다', async () => {
    const coupon = await createCoupon({
      userId: 'restorable',
      expiresAt: new Date('2026-07-10T00:00:00.000Z'),
      usedAt: NOW,
      usedInBetId: 55,
    });

    await prisma.$transaction((tx) => restoreCouponsUsedInBet(tx, 55));

    const restored = await prisma.bettingDoubleCoupon.findUniqueOrThrow({ where: { id: coupon.id } });
    expect(restored.usedAt).toBeNull();
    expect(restored.usedInBetId).toBeNull();
  });

  test('해당 베팅에서 소진된 쿠폰이 없어도 안전하게 아무 일도 하지 않는다', async () => {
    await expect(prisma.$transaction((tx) => restoreCouponsUsedInBet(tx, 999))).resolves.toBeUndefined();
  });
});
