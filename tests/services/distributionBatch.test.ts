import { describe, expect, test } from 'vitest';
import { prisma } from '../../src/db/client';
import { getOrCreateHouse, HOUSE_ID } from '../../src/services/house';
import { computeRebateDistribution, distributionBatch } from '../../src/services/distributionBatch';

async function setHouse(balance: number, lastRebateBalance: number) {
  await getOrCreateHouse();
  await prisma.house.update({ where: { id: HOUSE_ID }, data: { balance, lastRebateBalance } });
}

async function createUsers(prefix: string, count: number, balanceOf: (i: number) => number) {
  for (let i = 1; i <= count; i++) {
    await prisma.user.create({ data: { discordId: `${prefix}${i}`, balance: balanceOf(i) } });
  }
}

describe('computeRebateDistribution', () => {
  test('하위 30% 유저는 가중치, 나머지는 균등 분배한다', () => {
    const users = Array.from({ length: 10 }, (_, i) => ({ discordId: `u${i + 1}` }));
    const lowerTierUserIds = ['u1', 'u2', 'u3'];

    const result = computeRebateDistribution({
      users,
      lowerTierUserIds,
      fundAmount: 500_000,
      lowerTierWeight: 1.5,
    });

    // totalWeight = 10 + 3*(1.5-1) = 11.5, unitShare = floor(500,000 / 11.5) = 43,478
    expect(result.perUserAmounts.get('u1')).toBe(65_217); // floor(43,478 * 1.5)
    expect(result.perUserAmounts.get('u4')).toBe(43_478);
    expect(result.totalDistributed).toBe(3 * 65_217 + 7 * 43_478);
  });

  test('fundAmount가 0 이하면 아무도 받지 않는다', () => {
    const result = computeRebateDistribution({
      users: [{ discordId: 'a' }],
      lowerTierUserIds: [],
      fundAmount: -100,
      lowerTierWeight: 1.5,
    });

    expect(result.perUserAmounts.size).toBe(0);
    expect(result.totalDistributed).toBe(0);
  });

  test('유저가 없으면 아무도 받지 않는다', () => {
    const result = computeRebateDistribution({
      users: [],
      lowerTierUserIds: [],
      fundAmount: 100_000,
      lowerTierWeight: 1.5,
    });

    expect(result.perUserAmounts.size).toBe(0);
    expect(result.totalDistributed).toBe(0);
  });
});

describe('distributionBatch - 정상 케이스', () => {
  test('하우스 캡 초과분에 하위 30% 가중치를 적용해 분배한다', async () => {
    await createUsers('u', 10, (i) => i * 1_000_000); // 합계 55,000,000
    await setHouse(37_500_000, 0);
    // totalEconomy = 37,500,000 + 55,000,000 = 92,500,000
    // cap(40%) = floor(92,500,000 * 0.4) = 37,000,000 -> 초과분 500,000

    const result = await distributionBatch(new Date('2026-07-05T00:00:00.000Z'));

    expect(result.distributed).toBe(true);
    expect(result.fundAmount).toBe(500_000);
    expect(result.totalDistributed).toBe(499_997);
    expect(result.lowerTierCount).toBe(3); // floor(10 * 0.3)
    expect(result.couponsIssued).toBe(3);
    expect(result.couponsSkipped).toBe(0);

    const lowerTierIds = ['u1', 'u2', 'u3'];
    const normalIds = ['u4', 'u5', 'u6', 'u7', 'u8', 'u9', 'u10'];

    for (const id of lowerTierIds) {
      const user = await prisma.user.findUniqueOrThrow({ where: { discordId: id } });
      const baseBalance = Number(id.slice(1)) * 1_000_000;
      expect(user.balance).toBe(baseBalance + 65_217);
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
    expect(house.balance).toBe(37_500_000 - 499_997);
    expect(house.lastRebateBalance).toBe(house.balance); // 계산엔 안 쓰이지만 감사 기록용으로 계속 갱신
    expect(house.lastRebateAt?.toISOString()).toBe('2026-07-05T00:00:00.000Z');

    const coupons = await prisma.bettingDoubleCoupon.findMany({ orderBy: { userId: 'asc' } });
    expect(coupons.map((c) => c.userId)).toEqual(['u1', 'u2', 'u3']);
    expect(coupons.every((c) => c.usedAt === null)).toBe(true);
    expect(coupons[0].expiresAt.toISOString()).toBe('2026-07-12T00:00:00.000Z');
  });
});

describe('distributionBatch - 봇 계정 제외', () => {
  test('excludeUserId로 지정한 유저(예: 봇 자신)는 인원수 계산과 지급 대상 양쪽에서 완전히 빠진다', async () => {
    await createUsers('nobot', 9, (i) => i * 1_000_000); // 합계 45,000,000
    await prisma.user.create({ data: { discordId: 'bot-account', balance: 1 } });
    await setHouse(40_000_000, 0);
    // totalEconomy = 40,000,000 + 45,000,001 = 85,000,001, cap(40%) = 34,000,000 -> 초과분 6,000,000

    const result = await distributionBatch(new Date('2026-07-05T00:00:00.000Z'), {
      excludeUserId: 'bot-account',
    });

    expect(result.distributed).toBe(true);
    expect(result.lowerTierCount).toBe(2); // floor(9 * 0.3), 봇 제외한 9명 기준
    expect(result.perUserAmounts.has('bot-account')).toBe(false);

    const botUser = await prisma.user.findUniqueOrThrow({ where: { discordId: 'bot-account' } });
    expect(botUser.balance).toBe(1); // 변동 없음

    const botCoupons = await prisma.bettingDoubleCoupon.findMany({ where: { userId: 'bot-account' } });
    expect(botCoupons).toHaveLength(0);

    const botTxs = await prisma.transaction.findMany({ where: { userId: 'bot-account' } });
    expect(botTxs).toHaveLength(0);
  });
});

describe('distributionBatch - 하우스가 캡 이하', () => {
  test('초과분이 없으면 분배는 스킵하지만 에러 없이 정상 종료하고 체크포인트는 갱신된다', async () => {
    await createUsers('s', 5, () => 1_000_000); // 합계 5,000,000
    await setHouse(1_000_000, 6_000_000);
    // totalEconomy = 1,000,000 + 5,000,000 = 6,000,000, cap(40%) = 2,400,000
    // 하우스 잔고(1,000,000) < cap(2,400,000) -> 초과분 없음

    const result = await distributionBatch(new Date('2026-07-05T00:00:00.000Z'));

    expect(result.distributed).toBe(false);
    expect(result.fundAmount).toBe(0);
    expect(result.perUserAmounts.size).toBe(0);

    for (let i = 1; i <= 5; i++) {
      const user = await prisma.user.findUniqueOrThrow({ where: { discordId: `s${i}` } });
      expect(user.balance).toBe(1_000_000); // 변동 없음
    }

    const house = await prisma.house.findUniqueOrThrow({ where: { id: HOUSE_ID } });
    expect(house.balance).toBe(1_000_000); // 변동 없음
    expect(house.lastRebateBalance).toBe(1_000_000); // 현재 값으로 갱신 (감사 기록용)
    expect(house.lastRebateAt?.toISOString()).toBe('2026-07-05T00:00:00.000Z');

    // 재원이 없어도 하위 플레이어 쿠폰은 발급된다 (floor(5*0.3)=1명)
    const coupons = await prisma.bettingDoubleCoupon.findMany();
    expect(coupons).toHaveLength(1);
  });
});

describe('distributionBatch - 원자성', () => {
  test('설정값이 비정상적이어서 지급액이 하우스 잔고를 초과하면 전부 롤백된다', async () => {
    await createUsers('atomic', 3, () => 1_000_000);
    await setHouse(1_000, 0);
    // 서비스 계층 검증(0 초과 1 이하)을 우회해 DB에 직접 비정상 캡비율을 기록한다 -
    // 계산 로직이 이런 상황에서도 하우스 잔고 이상으로 지급하려 하면 원자적으로
    // 롤백되는지 검증한다. upsert라 EconomyConfig row 존재 여부와 무관하게 동작한다.
    await prisma.economyConfig.upsert({
      where: { id: 'SINGLETON' },
      create: { id: 'SINGLETON', houseBalanceCapRatio: -1 },
      update: { houseBalanceCapRatio: -1 },
    });
    // totalEconomy = 1,000 + 3,000,000 = 3,001,000, cap = floor(3,001,000 * -1) = -3,001,000
    // 초과분 = 1,000 - (-3,001,000) = 3,002,000 -> 실제 하우스 잔고(1,000)를 훨씬 초과

    await expect(distributionBatch(new Date('2026-07-05T00:00:00.000Z'))).rejects.toThrow();

    for (let i = 1; i <= 3; i++) {
      const user = await prisma.user.findUniqueOrThrow({ where: { discordId: `atomic${i}` } });
      expect(user.balance).toBe(1_000_000); // 롤백됨
    }

    const house = await prisma.house.findUniqueOrThrow({ where: { id: HOUSE_ID } });
    expect(house.balance).toBe(1_000); // 롤백됨

    const coupons = await prisma.bettingDoubleCoupon.findMany();
    expect(coupons).toHaveLength(0); // 쿠폰 발급도 함께 롤백됨
  });
});

describe('distributionBatch - 캡 도달 후 연속 실행', () => {
  test('환급 후 하우스 잔고가 캡 근처로 수렴하고, 곧바로 다시 실행하면 재원이 거의 남지 않는다', async () => {
    await createUsers('conv', 4, () => 1_000_000); // 합계 4,000,000
    await setHouse(6_000_000, 0);
    // totalEconomy = 10,000,000, cap(40%) = 4,000,000, 초과분 = 2,000,000

    const first = await distributionBatch(new Date('2026-07-05T00:00:00.000Z'));
    expect(first.distributed).toBe(true);
    expect(first.fundAmount).toBe(2_000_000);

    const houseAfterFirst = await prisma.house.findUniqueOrThrow({ where: { id: HOUSE_ID } });
    // 환급은 포인트를 하우스->유저로 옮길 뿐 totalEconomy를 바꾸지 않으므로,
    // 하우스 잔고는 캡(4,000,000)에 반올림 잔돈 이내로 수렴한다.
    expect(houseAfterFirst.balance).toBeGreaterThanOrEqual(4_000_000);
    expect(houseAfterFirst.balance).toBeLessThan(4_000_010);

    const second = await distributionBatch(new Date('2026-07-05T00:00:10.000Z'));
    // 실행 간격이 짧아도(하루도 안 지나도) 매번 그 시점 실제 잔고 기준으로 재계산하므로
    // 문제없이 재원이 거의 없다고 나온다 (예전 "순증가분" 방식의 간격 의존성이 사라짐).
    expect(second.fundAmount).toBeLessThan(10);
  });
});

describe('distributionBatch - 베팅2배쿠폰 보유 개수 제한', () => {
  test('미사용+미만료 쿠폰을 0장 또는 1장 보유 중이면 정상 발급된다', async () => {
    await createUsers('cap', 10, (i) => i * 1_000_000); // 하위 3명: cap1, cap2, cap3
    await setHouse(37_500_000, 0);

    const existing = await prisma.bettingDoubleCoupon.create({
      data: { userId: 'cap2', expiresAt: new Date('2026-07-20T00:00:00.000Z') },
    });

    const result = await distributionBatch(new Date('2026-07-05T00:00:00.000Z'));

    expect(result.couponsIssued).toBe(3);
    expect(result.couponsSkipped).toBe(0);

    const cap1Coupons = await prisma.bettingDoubleCoupon.findMany({ where: { userId: 'cap1' } });
    expect(cap1Coupons).toHaveLength(1);

    const cap2Coupons = await prisma.bettingDoubleCoupon.findMany({
      where: { userId: 'cap2' },
      orderBy: { issuedAt: 'asc' },
    });
    expect(cap2Coupons).toHaveLength(2);
    expect(cap2Coupons[0].id).toBe(existing.id);
  });

  test('이미 유효한 쿠폰을 2장 보유 중이면 발급을 스킵하고 기존 2장을 그대로 유지한다', async () => {
    await createUsers('capb', 10, (i) => i * 1_000_000);
    await setHouse(37_500_000, 0);

    await prisma.bettingDoubleCoupon.create({
      data: { userId: 'capb1', expiresAt: new Date('2026-07-10T00:00:00.000Z') },
    });
    await prisma.bettingDoubleCoupon.create({
      data: { userId: 'capb1', expiresAt: new Date('2026-07-15T00:00:00.000Z') },
    });

    const result = await distributionBatch(new Date('2026-07-05T00:00:00.000Z'));

    expect(result.couponsIssued).toBe(2);
    expect(result.couponsSkipped).toBe(1);

    const capb1Coupons = await prisma.bettingDoubleCoupon.findMany({ where: { userId: 'capb1' } });
    expect(capb1Coupons).toHaveLength(2);
  });

  test('2장 중 1장이 이미 만료됐으면 유효한 것만 카운트해서 정상 발급된다', async () => {
    await createUsers('capc', 10, (i) => i * 1_000_000);
    await setHouse(37_500_000, 0);

    await prisma.bettingDoubleCoupon.create({
      data: { userId: 'capc1', expiresAt: new Date('2026-07-01T00:00:00.000Z') },
    });
    await prisma.bettingDoubleCoupon.create({
      data: { userId: 'capc1', expiresAt: new Date('2026-07-20T00:00:00.000Z') },
    });

    const result = await distributionBatch(new Date('2026-07-05T00:00:00.000Z'));

    expect(result.couponsIssued).toBe(3);
    expect(result.couponsSkipped).toBe(0);

    const capc1Coupons = await prisma.bettingDoubleCoupon.findMany({ where: { userId: 'capc1' } });
    expect(capc1Coupons).toHaveLength(3);
  });
});
