import { Prisma } from '@prisma/client';
import { prisma } from '../db/client';

type Db = Prisma.TransactionClient | typeof prisma;

// 참가 UI에서 "쿠폰 사용" 선택지를 보여줄지 판단할 때 쓴다 - 여러 개 유효하면 가장 먼저
// 만료되는 것부터 제안한다.
export async function findValidCouponForUser(userId: string, now: Date = new Date()) {
  return prisma.bettingDoubleCoupon.findFirst({
    where: { userId, usedAt: null, expiresAt: { gt: now } },
    orderBy: { expiresAt: 'asc' },
  });
}

// /쿠폰함 - 보유한 미사용/미만료 쿠폰 전체 목록.
export async function listValidCoupons(userId: string, now: Date = new Date()) {
  return prisma.bettingDoubleCoupon.findMany({
    where: { userId, usedAt: null, expiresAt: { gt: now } },
    orderBy: { expiresAt: 'asc' },
  });
}

// 정산 시점의 최후 방어선 검증. 참가 시점엔 소진하지 않고, 승리해서 실제로 배당을 받을 때만
// 여기서 재검증 후 소진 처리한다. 무효하면 조용히 false를 반환 - 호출부는 원래 배당 그대로
// 지급하면 된다.
export async function tryConsumeCoupon(
  tx: Prisma.TransactionClient,
  params: { couponId: string; userId: string; betId: number; now: Date }
): Promise<boolean> {
  const coupon = await tx.bettingDoubleCoupon.findUnique({ where: { id: params.couponId } });
  if (
    !coupon ||
    coupon.userId !== params.userId ||
    coupon.usedAt !== null ||
    coupon.expiresAt <= params.now
  ) {
    return false;
  }

  await tx.bettingDoubleCoupon.update({
    where: { id: params.couponId },
    data: { usedAt: params.now, usedInBetId: params.betId },
  });
  return true;
}

// /정산취소로 정산이 취소될 때, 그 베팅에서 소진된 쿠폰이 있으면 되돌려준다(usedAt/usedInBetId
// 초기화). 소진된 게 없어도(0건) 안전하게 아무 일도 하지 않는다.
export async function restoreCouponsUsedInBet(tx: Db, betId: number): Promise<void> {
  await tx.bettingDoubleCoupon.updateMany({
    where: { usedInBetId: betId },
    data: { usedAt: null, usedInBetId: null },
  });
}
