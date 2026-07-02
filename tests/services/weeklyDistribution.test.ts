import { describe, expect, test } from 'vitest';
import { prisma } from '../../src/db/client';
import { updateEconomyConfig } from '../../src/services/economyConfig';
import { getOrCreateHouse, HOUSE_ID } from '../../src/services/house';
import { weeklyDistribution } from '../../src/services/weeklyDistribution';

async function setHouse(balance: number, lastRebateBalance: number) {
  await getOrCreateHouse();
  await prisma.house.update({ where: { id: HOUSE_ID }, data: { balance, lastRebateBalance } });
}

async function createUsers(prefix: string, count: number, balanceOf: (i: number) => number) {
  for (let i = 1; i <= count; i++) {
    await prisma.user.create({ data: { discordId: `${prefix}${i}`, balance: balanceOf(i) } });
  }
}

describe('weeklyDistribution - 정상 케이스', () => {
  test('순증가분에 환급 비율을 적용해 하위 30%는 가중치, 나머지는 균등 분배한다', async () => {
    await createUsers('u', 10, (i) => i * 1_000_000);
    await setHouse(10_000_000, 0);

    const result = await weeklyDistribution(new Date('2026-07-05T00:00:00.000Z'));

    expect(result.distributed).toBe(true);
    expect(result.fundAmount).toBe(500_000); // floor(10,000,000 * 0.05)
    expect(result.lowerTierCount).toBe(3); // floor(10 * 0.3)
    expect(result.couponsIssued).toBe(3);

    // totalWeight = 10 + 3*(1.5-1) = 11.5, unitShare = floor(500,000 / 11.5) = 43,478
    const lowerTierIds = ['u1', 'u2', 'u3'];
    const normalIds = ['u4', 'u5', 'u6', 'u7', 'u8', 'u9', 'u10'];

    for (const id of lowerTierIds) {
      const user = await prisma.user.findUniqueOrThrow({ where: { discordId: id } });
      const baseBalance = Number(id.slice(1)) * 1_000_000;
      expect(user.balance).toBe(baseBalance + 65_217); // floor(43,478 * 1.5)
      expect(result.perUserAmounts.get(id)).toBe(65_217);
    }
    for (const id of normalIds) {
      const user = await prisma.user.findUniqueOrThrow({ where: { discordId: id } });
      const baseBalance = Number(id.slice(1)) * 1_000_000;
      expect(user.balance).toBe(baseBalance + 43_478);
      expect(result.perUserAmounts.get(id)).toBe(43_478);
    }

    // totalDistributed = 3*65,217 + 7*43,478 = 499,997 -> 잔돈 3은 하우스에 남는다
    const house = await prisma.house.findUniqueOrThrow({ where: { id: HOUSE_ID } });
    expect(house.balance).toBe(10_000_000 - 499_997);
    expect(house.lastRebateBalance).toBe(house.balance); // 분배 후 잔고로 갱신
    expect(house.lastRebateAt?.toISOString()).toBe('2026-07-05T00:00:00.000Z');

    // 하위 플레이어에게만 베팅2배쿠폰 발급 (7일 유효)
    const coupons = await prisma.bettingDoubleCoupon.findMany({ orderBy: { userId: 'asc' } });
    expect(coupons.map((c) => c.userId)).toEqual(['u1', 'u2', 'u3']);
    expect(coupons.every((c) => c.usedAt === null)).toBe(true);
    expect(coupons[0].expiresAt.toISOString()).toBe('2026-07-12T00:00:00.000Z');
  });
});

describe('weeklyDistribution - 재원이 0 이하', () => {
  test('분배는 스킵하지만 lastRebateBalance/lastRebateAt은 현재 값으로 갱신된다', async () => {
    await createUsers('s', 5, () => 1_000_000);
    await setHouse(5_000_000, 6_000_000); // lastRebateBalance > balance -> netGain 클램프로 0

    const result = await weeklyDistribution(new Date('2026-07-05T00:00:00.000Z'));

    expect(result.distributed).toBe(false);
    expect(result.fundAmount).toBe(0);
    expect(result.perUserAmounts.size).toBe(0);

    for (let i = 1; i <= 5; i++) {
      const user = await prisma.user.findUniqueOrThrow({ where: { discordId: `s${i}` } });
      expect(user.balance).toBe(1_000_000); // 변동 없음
    }

    const house = await prisma.house.findUniqueOrThrow({ where: { id: HOUSE_ID } });
    expect(house.balance).toBe(5_000_000); // 변동 없음
    expect(house.lastRebateBalance).toBe(5_000_000); // 현재 값으로 갱신 (다음 주 계산 안 꼬이게)
    expect(house.lastRebateAt?.toISOString()).toBe('2026-07-05T00:00:00.000Z');

    // 재원이 없어도 하위 플레이어 쿠폰은 발급된다 (floor(5*0.3)=1명)
    const coupons = await prisma.bettingDoubleCoupon.findMany();
    expect(coupons).toHaveLength(1);
  });
});

describe('weeklyDistribution - 원자성', () => {
  test('분배 도중 하우스 잔고 부족으로 실패하면 전부 롤백된다', async () => {
    await createUsers('atomic', 3, () => 1_000_000);
    // lastRebateBalance를 비정상적으로 낮게(음수) 잡아 netGain이 실제 하우스 잔고보다
    // 훨씬 크게 계산되도록 만들어, 분배 도중 하우스 차감이 마이너스가 되어 실패를 유도한다.
    await setHouse(1_000, -999_000); // netGain = 1,000 - (-999,000) = 1,000,000
    await updateEconomyConfig({
      requestedBy: 'admin-1',
      adminDiscordId: 'admin-1',
      rebateRate: 1,
      lowerTierWeight: 1.5,
    });

    await expect(weeklyDistribution(new Date('2026-07-05T00:00:00.000Z'))).rejects.toThrow();

    for (let i = 1; i <= 3; i++) {
      const user = await prisma.user.findUniqueOrThrow({ where: { discordId: `atomic${i}` } });
      expect(user.balance).toBe(1_000_000); // 롤백됨
    }

    const house = await prisma.house.findUniqueOrThrow({ where: { id: HOUSE_ID } });
    expect(house.balance).toBe(1_000); // 롤백됨
    expect(house.lastRebateBalance).toBe(-999_000); // 롤백됨(갱신 안 됨)

    const coupons = await prisma.bettingDoubleCoupon.findMany();
    expect(coupons).toHaveLength(0); // 쿠폰 발급도 함께 롤백됨
  });
});
