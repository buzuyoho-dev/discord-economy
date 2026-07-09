import { describe, expect, test } from 'vitest';
import { prisma } from '../../src/db/client';
import { runCatchUp } from '../../src/scripts/houseBalanceCapCatchUp';
import { getOrCreateHouse, HOUSE_ID } from '../../src/services/house';

async function setHouse(balance: number) {
  await getOrCreateHouse();
  await prisma.house.update({ where: { id: HOUSE_ID }, data: { balance } });
}

async function createUsers(prefix: string, count: number, balanceOf: (i: number) => number) {
  for (let i = 1; i <= count; i++) {
    await prisma.user.create({ data: { discordId: `${prefix}${i}`, balance: balanceOf(i) } });
  }
}

describe('runCatchUp - dry-run', () => {
  test('계산만 하고 DB에는 아무 것도 쓰지 않는다', async () => {
    await createUsers('u', 10, (i) => i * 1_000_000); // 합계 55,000,000
    await setHouse(37_500_000);
    // totalEconomy = 92,500,000, cap(40%) = 37,000,000, 초과분 = 500,000

    const plan = await runCatchUp(false, new Date('2026-07-10T00:00:00.000Z'));

    expect(plan.excessAmount).toBe(500_000);
    expect(plan.items.length).toBeGreaterThan(0);

    const house = await prisma.house.findUniqueOrThrow({ where: { id: HOUSE_ID } });
    expect(house.balance).toBe(37_500_000); // 변동 없음

    const txs = await prisma.transaction.findMany();
    expect(txs).toHaveLength(0);

    const houseTxs = await prisma.houseTransaction.findMany();
    expect(houseTxs).toHaveLength(0);

    const coupons = await prisma.bettingDoubleCoupon.findMany();
    expect(coupons).toHaveLength(0); // catch-up은 쿠폰을 발급하지 않는다
  });

  test('초과분이 없으면 items가 비어있고 아무 것도 안 한다', async () => {
    await createUsers('v', 5, () => 1_000_000); // 합계 5,000,000
    await setHouse(1_000_000);
    // totalEconomy = 6,000,000, cap(40%) = 2,400,000, 하우스(1,000,000) < cap -> 초과분 0

    const plan = await runCatchUp(false, new Date('2026-07-10T00:00:00.000Z'));

    expect(plan.excessAmount).toBe(0);
    expect(plan.items).toHaveLength(0);
    expect(plan.totalDistributed).toBe(0);
  });
});

describe('runCatchUp - execute', () => {
  test('초과분만큼 실제로 지급하고 Transaction/HouseTransaction에 감사 로그를 남긴다', async () => {
    await createUsers('w', 10, (i) => i * 1_000_000); // 합계 55,000,000
    await setHouse(37_500_000);
    // totalEconomy = 92,500,000, cap(40%) = 37,000,000, 초과분 = 500,000

    const plan = await runCatchUp(true, new Date('2026-07-10T00:00:00.000Z'));

    expect(plan.excessAmount).toBe(500_000);
    expect(plan.totalDistributed).toBeGreaterThan(0);

    const house = await prisma.house.findUniqueOrThrow({ where: { id: HOUSE_ID } });
    expect(house.balance).toBe(37_500_000 - plan.totalDistributed);

    const houseTxs = await prisma.houseTransaction.findMany({
      where: { description: { contains: 'catch-up' } },
    });
    expect(houseTxs).toHaveLength(1);
    expect(houseTxs[0].amount).toBe(-plan.totalDistributed);

    const userTxs = await prisma.transaction.findMany({
      where: { description: '하우스 캡 초과분 catch-up 정산' },
    });
    expect(userTxs).toHaveLength(plan.items.length);

    const coupons = await prisma.bettingDoubleCoupon.findMany();
    expect(coupons).toHaveLength(0); // 정기 배치와 달리 쿠폰은 발급하지 않는다
  });

  test('초과분이 없으면 실행 모드여도 아무 것도 지급하지 않는다', async () => {
    await createUsers('x', 5, () => 1_000_000);
    await setHouse(1_000_000);

    const plan = await runCatchUp(true, new Date('2026-07-10T00:00:00.000Z'));

    expect(plan.excessAmount).toBe(0);

    const house = await prisma.house.findUniqueOrThrow({ where: { id: HOUSE_ID } });
    expect(house.balance).toBe(1_000_000); // 변동 없음

    const txs = await prisma.transaction.findMany();
    expect(txs).toHaveLength(0);
  });

  test('excludeUserId로 지정한 계정(봇 자신)은 하위 30% 인원수/지급 대상에서 완전히 빠진다', async () => {
    await createUsers('y', 10, (i) => i * 1_000_000); // 합계 55,000,000
    // 봇 계정: 하위 30%에 들어갈 만큼 잔액이 낮음 (제외되지 않으면 가중치 지급 대상)
    await prisma.user.create({ data: { discordId: 'bot-account', balance: 500_000 } });
    await setHouse(37_500_000);
    // totalEconomy = 92,500,000 + 500,000 = 93,000,000... 봇 제외 시 92,500,000 그대로

    const plan = await runCatchUp(true, new Date('2026-07-10T00:00:00.000Z'), {
      excludeUserId: 'bot-account',
    });

    expect(plan.excessAmount).toBeGreaterThan(0);
    expect(plan.items.find((item) => item.discordId === 'bot-account')).toBeUndefined();
    expect(plan.lowerTierCount).toBe(3); // floor(10 * 0.3) - 봇 계정은 인원수 계산에서도 빠짐

    const botUser = await prisma.user.findUniqueOrThrow({ where: { discordId: 'bot-account' } });
    expect(botUser.balance).toBe(500_000); // 변동 없음

    const botTxs = await prisma.transaction.findMany({ where: { userId: 'bot-account' } });
    expect(botTxs).toHaveLength(0);
  });
});
