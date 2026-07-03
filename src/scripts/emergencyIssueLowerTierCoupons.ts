import { prisma } from '../db/client';
import {
  getLowerTierUserIds,
  issueCouponsForUsers,
  MAX_VALID_COUPONS_PER_USER,
} from '../services/distributionBatch';

// distributionBatch()의 "쿠폰 발급" 부분만 떼어내 1회성으로 실행하는 긴급 스크립트.
// 정기 cron(scheduleDistributionBatch)에는 연결하지 않는다 - 지금 한 번만 수동 실행하는 용도.
export interface EmergencyCouponIssuanceResult {
  lowerTierUserIds: string[];
  issuedUserIds: string[];
  skippedUserIds: string[];
}

export async function emergencyIssueLowerTierCoupons(
  execute: boolean,
  now: Date = new Date()
): Promise<EmergencyCouponIssuanceResult> {
  return prisma.$transaction(async (tx) => {
    const lowerTierUserIds = await getLowerTierUserIds(tx);

    if (!execute) {
      // DRY-RUN: 실제 발급 함수(issueCouponsForUsers)와 동일한 기준(미사용+미만료 2장 이상이면
      // 스킵)으로 미리보기만 계산한다 - DB에는 쓰지 않는다.
      const counts = await Promise.all(
        lowerTierUserIds.map((userId) =>
          tx.bettingDoubleCoupon
            .count({ where: { userId, usedAt: null, expiresAt: { gt: now } } })
            .then((validCouponCount) => ({ userId, validCouponCount }))
        )
      );

      return {
        lowerTierUserIds,
        issuedUserIds: counts.filter((c) => c.validCouponCount < MAX_VALID_COUPONS_PER_USER).map((c) => c.userId),
        skippedUserIds: counts.filter((c) => c.validCouponCount >= MAX_VALID_COUPONS_PER_USER).map((c) => c.userId),
      };
    }

    const { issuedUserIds, skippedUserIds } = await issueCouponsForUsers(tx, lowerTierUserIds, now);
    return { lowerTierUserIds, issuedUserIds, skippedUserIds };
  });
}

async function main() {
  const execute = process.argv.includes('--execute');

  const result = await emergencyIssueLowerTierCoupons(execute);

  console.log('');
  console.log(execute ? '=== 긴급 쿠폰 발급 실행 결과 ===' : '=== DRY RUN 결과 (DB에 쓰지 않음) ===');
  console.log(`하위 플레이어로 판정된 유저 수: ${result.lowerTierUserIds.length}명`);
  console.log(`${execute ? '신규 발급된' : '발급될 예정인'} 유저 수: ${result.issuedUserIds.length}명`);
  console.log(result.issuedUserIds.length > 0 ? result.issuedUserIds.join(', ') : '(없음)');
  console.log(`이미 ${MAX_VALID_COUPONS_PER_USER}장 보유 중이라 스킵${execute ? '된' : '될'} 유저 수: ${result.skippedUserIds.length}명`);
  console.log(result.skippedUserIds.length > 0 ? result.skippedUserIds.join(', ') : '(없음)');
}

if (require.main === module) {
  main()
    .catch((e) => {
      console.error(e);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
