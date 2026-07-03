import { describe, expect, test } from 'vitest';
import { prisma } from '../../src/db/client';
import { updateEconomyConfig } from '../../src/services/economyConfig';
import { getOrCreateHouse, HOUSE_ID } from '../../src/services/house';
import { distributionBatch } from '../../src/services/distributionBatch';

async function setHouse(balance: number, lastRebateBalance: number) {
  await getOrCreateHouse();
  await prisma.house.update({ where: { id: HOUSE_ID }, data: { balance, lastRebateBalance } });
}

async function createUsers(prefix: string, count: number, balanceOf: (i: number) => number) {
  for (let i = 1; i <= count; i++) {
    await prisma.user.create({ data: { discordId: `${prefix}${i}`, balance: balanceOf(i) } });
  }
}

describe('distributionBatch - 정상 케이스', () => {
  test('순증가분에 환급 비율을 적용해 하위 30%는 가중치, 나머지는 균등 분배한다', async () => {
    await createUsers('u', 10, (i) => i * 1_000_000);
    await setHouse(10_000_000, 0);

    const result = await distributionBatch(new Date('2026-07-05T00:00:00.000Z'));

    expect(result.distributed).toBe(true);
    expect(result.fundAmount).toBe(500_000); // floor(10,000,000 * 0.05)
    expect(result.lowerTierCount).toBe(3); // floor(10 * 0.3)
    expect(result.couponsIssued).toBe(3);
    expect(result.couponsSkipped).toBe(0);

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

describe('distributionBatch - 봇 계정 제외', () => {
  test('excludeUserId로 지정한 유저(예: 봇 자신)는 User row가 있어도 환급/쿠폰 대상에서 완전히 빠진다', async () => {
    await createUsers('nobot', 9, (i) => i * 1_000_000);
    // 봇 계정이 User row로 실수로 남아있는 상황을 재현 - 잔액이 가장 낮아서
    // 필터링이 없다면 하위 30%(쿠폰 대상)에 반드시 포함될 위치에 둔다.
    await prisma.user.create({ data: { discordId: 'bot-account', balance: 1 } });
    await setHouse(10_000_000, 0);

    const result = await distributionBatch(new Date('2026-07-05T00:00:00.000Z'), {
      excludeUserId: 'bot-account',
    });

    // 총 인원 계산에서 봇이 빠져야 하므로 9명 기준 하위 30% = floor(9*0.3) = 2명
    expect(result.lowerTierCount).toBe(2);
    expect(result.perUserAmounts.has('bot-account')).toBe(false);

    const botUser = await prisma.user.findUniqueOrThrow({ where: { discordId: 'bot-account' } });
    expect(botUser.balance).toBe(1); // 변동 없음

    const botCoupons = await prisma.bettingDoubleCoupon.findMany({ where: { userId: 'bot-account' } });
    expect(botCoupons).toHaveLength(0);

    const botTxs = await prisma.transaction.findMany({ where: { userId: 'bot-account' } });
    expect(botTxs).toHaveLength(0);
  });
});

describe('distributionBatch - 재원이 0 이하', () => {
  test('분배는 스킵하지만 lastRebateBalance/lastRebateAt은 현재 값으로 갱신된다', async () => {
    await createUsers('s', 5, () => 1_000_000);
    await setHouse(5_000_000, 6_000_000); // lastRebateBalance > balance -> netGain 클램프로 0

    const result = await distributionBatch(new Date('2026-07-05T00:00:00.000Z'));

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

describe('distributionBatch - 원자성', () => {
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

    await expect(distributionBatch(new Date('2026-07-05T00:00:00.000Z'))).rejects.toThrow();

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

describe('distributionBatch - 베팅2배쿠폰 보유 개수 제한', () => {
  test('미사용+미만료 쿠폰을 0장 또는 1장 보유 중이면 정상 발급된다', async () => {
    await createUsers('cap', 10, (i) => i * 1_000_000); // 하위 3명: cap1, cap2, cap3
    await setHouse(10_000_000, 0);

    // cap2는 이미 유효 쿠폰 1장을 보유 중 (0장인 cap1, cap3와 대비)
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
    expect(cap2Coupons[0].id).toBe(existing.id); // 기존 쿠폰은 그대로 유지된다
  });

  test('이미 유효한 쿠폰을 2장 보유 중이면 발급을 스킵하고 기존 2장을 그대로 유지한다', async () => {
    await createUsers('capb', 10, (i) => i * 1_000_000); // 하위 3명: capb1, capb2, capb3
    await setHouse(10_000_000, 0);

    await prisma.bettingDoubleCoupon.create({
      data: { userId: 'capb1', expiresAt: new Date('2026-07-10T00:00:00.000Z') },
    });
    await prisma.bettingDoubleCoupon.create({
      data: { userId: 'capb1', expiresAt: new Date('2026-07-15T00:00:00.000Z') },
    });

    const result = await distributionBatch(new Date('2026-07-05T00:00:00.000Z'));

    expect(result.couponsIssued).toBe(2); // capb2, capb3만
    expect(result.couponsSkipped).toBe(1); // capb1은 이미 2장 보유로 스킵

    const capb1Coupons = await prisma.bettingDoubleCoupon.findMany({ where: { userId: 'capb1' } });
    expect(capb1Coupons).toHaveLength(2); // 새로 발급되지 않고 그대로 2장
  });

  test('2장 중 1장이 이미 만료됐으면 유효한 것만 카운트해서 정상 발급된다', async () => {
    await createUsers('capc', 10, (i) => i * 1_000_000); // 하위 3명: capc1, capc2, capc3
    await setHouse(10_000_000, 0);

    await prisma.bettingDoubleCoupon.create({
      data: { userId: 'capc1', expiresAt: new Date('2026-07-01T00:00:00.000Z') }, // 실행 시점(07-05) 기준 이미 만료
    });
    await prisma.bettingDoubleCoupon.create({
      data: { userId: 'capc1', expiresAt: new Date('2026-07-20T00:00:00.000Z') }, // 유효
    });

    const result = await distributionBatch(new Date('2026-07-05T00:00:00.000Z'));

    expect(result.couponsIssued).toBe(3); // capc1도 포함 (유효 쿠폰은 1장뿐이므로)
    expect(result.couponsSkipped).toBe(0);

    const capc1Coupons = await prisma.bettingDoubleCoupon.findMany({ where: { userId: 'capc1' } });
    expect(capc1Coupons).toHaveLength(3); // 만료 1 + 기존 유효 1 + 신규 발급 1
  });
});

describe('distributionBatch - 실행 간격이 짧아져도 순증가분만 반영', () => {
  test('월요일 실행 후 이틀 뒤 수요일에 실행해도 그 사이의 순증가분만 재원으로 계산된다', async () => {
    await setHouse(1_000_000, 0);

    const monday = new Date('2026-07-06T00:00:00.000Z');
    const mondayResult = await distributionBatch(monday);
    expect(mondayResult.fundAmount).toBe(50_000); // floor(1,000,000 * 0.05)

    const houseAfterMonday = await prisma.house.findUniqueOrThrow({ where: { id: HOUSE_ID } });
    expect(houseAfterMonday.lastRebateBalance).toBe(1_000_000); // 유저가 없어 분배는 없었지만 체크포인트는 갱신됨

    // 월/수 사이(이틀) 다른 활동으로 하우스 잔고가 300,000 늘었다고 가정
    await prisma.house.update({ where: { id: HOUSE_ID }, data: { balance: 1_300_000 } });

    const wednesday = new Date('2026-07-08T00:00:00.000Z');
    const wednesdayResult = await distributionBatch(wednesday);

    // 순증가분은 1,300,000 - 1,000,000(월요일 체크포인트) = 300,000만 반영되어야 한다
    expect(wednesdayResult.fundAmount).toBe(15_000); // floor(300,000 * 0.05)

    const houseAfterWednesday = await prisma.house.findUniqueOrThrow({ where: { id: HOUSE_ID } });
    expect(houseAfterWednesday.lastRebateBalance).toBe(1_300_000);
  });
});
