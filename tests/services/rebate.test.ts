import { describe, expect, test } from 'vitest';
import { prisma } from '../../src/db/client';
import {
  applyWeeklyRebate,
  calculateRebate,
  distributeRebate,
} from '../../src/services/rebate';
import { applyHouseTransaction, getOrCreateHouse, HOUSE_ID } from '../../src/services/house';
import { getOrCreateUser } from '../../src/services/ledger';

async function setHouseBalance(amount: number) {
  await getOrCreateHouse();
  await prisma.$transaction((tx) =>
    applyHouseTransaction(tx, { type: 'TAX', amount, description: 'test setup' })
  );
}

describe('calculateRebate', () => {
  test('점유율이 25% 이하면 환원이 발생하지 않는다', () => {
    const result = calculateRebate(25, 75); // 25/100 = 0.25, 초과 아님
    expect(result.shouldRebate).toBe(false);
    expect(result.currentShare).toBe(0.25);
    expect(result.rebateAmount).toBe(0);
  });

  test('점유율이 25%를 초과하면 초과분의 절반을 환원한다', () => {
    // houseBalance=30, totalUserBalance=70 => totalEconomy=100, share=0.3
    // fullExcess = 30 - 0.25*100 = 5, rebateAmount = floor(5*0.5) = 2
    const result = calculateRebate(30, 70);
    expect(result.shouldRebate).toBe(true);
    expect(result.currentShare).toBe(0.3);
    expect(result.rebateAmount).toBe(2);
  });

  test('나누어지지 않는 경우 내림 처리한다', () => {
    const houseBalance = 1_000_001;
    const totalUserBalance = 2_000_000;
    const totalEconomy = houseBalance + totalUserBalance;
    const fullExcess = houseBalance - 0.25 * totalEconomy;
    const expected = Math.floor(fullExcess * 0.5);

    const result = calculateRebate(houseBalance, totalUserBalance);
    expect(result.rebateAmount).toBe(expected);
  });

  test('totalEconomy가 0이면 환원이 발생하지 않는다 (0으로 나누기 방지)', () => {
    const result = calculateRebate(0, 0);
    expect(result.shouldRebate).toBe(false);
    expect(result.rebateAmount).toBe(0);
  });
});

describe('distributeRebate', () => {
  test('정확히 나누어지면 전원 동일하게 분배한다', () => {
    const result = distributeRebate(['c', 'a', 'b'], 300);
    expect(result.get('a')).toBe(100);
    expect(result.get('b')).toBe(100);
    expect(result.get('c')).toBe(100);
  });

  test('나누어지지 않으면 discordId 오름차순으로 나머지를 1포인트씩 분배한다', () => {
    const result = distributeRebate(['c', 'a', 'b'], 301);
    expect(result.get('a')).toBe(101);
    expect(result.get('b')).toBe(100);
    expect(result.get('c')).toBe(100);

    const total = [...result.values()].reduce((sum, v) => sum + v, 0);
    expect(total).toBe(301);
  });

  test('유저가 없으면 빈 맵을 반환한다', () => {
    expect(distributeRebate([], 100).size).toBe(0);
  });
});

describe('applyWeeklyRebate', () => {
  test('점유율이 25% 이하면 아무것도 처리하지 않는다', async () => {
    await getOrCreateUser('rebate-u1');
    await setHouseBalance(1_000_000); // 유저 잔액 10,000,000 대비 House 비중이 낮음

    const houseBefore = await prisma.house.findUniqueOrThrow({ where: { id: HOUSE_ID } });

    const result = await applyWeeklyRebate();

    expect(result.rebated).toBe(false);

    const houseAfter = await prisma.house.findUniqueOrThrow({ where: { id: HOUSE_ID } });
    expect(houseAfter.balance).toBe(houseBefore.balance);
  });

  test('점유율이 25%를 초과하면 하우스를 차감하고 전체 유저에게 동일 분배하며, 거래 내역이 함께 기록된다', async () => {
    await getOrCreateUser('rebate-a');
    await getOrCreateUser('rebate-b');
    // 두 유저 합계 20,000,000, 하우스를 크게 키워서 점유율 25% 초과를 유도한다.
    await setHouseBalance(30_000_000);
    // totalEconomy = 30,000,000 + 20,000,000 = 50,000,000, share = 0.6
    // fullExcess = 30,000,000 - 0.25*50,000,000 = 17,500,000, rebateAmount = 8,750,000

    const result = await applyWeeklyRebate();

    expect(result.rebated).toBe(true);
    expect(result.rebateAmount).toBe(8_750_000);

    const house = await prisma.house.findUniqueOrThrow({ where: { id: HOUSE_ID } });
    expect(house.balance).toBe(30_000_000 - 8_750_000);

    const userA = await prisma.user.findUniqueOrThrow({ where: { discordId: 'rebate-a' } });
    const userB = await prisma.user.findUniqueOrThrow({ where: { discordId: 'rebate-b' } });
    expect(userA.balance + userB.balance).toBe(20_000_000 + 8_750_000);

    const houseTxs = await prisma.houseTransaction.findMany({ where: { type: 'REBATE' } });
    expect(houseTxs).toHaveLength(1);
    expect(houseTxs[0].amount).toBe(-8_750_000);

    const userTxs = await prisma.transaction.findMany({ where: { type: 'REBATE' } });
    expect(userTxs).toHaveLength(2);
  });

  test('여러 유저 중 마지막(discordId 기준) 한 명 처리에서 실패하면 앞 사람들 변경분까지 전부 롤백된다', async () => {
    await getOrCreateUser('rebate-x1');
    await getOrCreateUser('rebate-x2');
    await getOrCreateUser('rebate-x3'); // discordId 오름차순으로 가장 마지막에 처리됨

    // x3의 잔액을 Int32 한계까지 채워, 환원 크레딧 시 Int32 오버플로우로 실패를 유도한다.
    await prisma.user.update({
      where: { discordId: 'rebate-x3' },
      data: { balance: 2_147_483_647 },
    });

    // x3의 거대한 잔액 때문에 점유율이 25%를 넘도록 하우스도 충분히 크게 잡는다.
    await setHouseBalance(1_000_000_000);

    const houseBefore = await prisma.house.findUniqueOrThrow({ where: { id: HOUSE_ID } });
    const x1Before = await prisma.user.findUniqueOrThrow({ where: { discordId: 'rebate-x1' } });
    const x2Before = await prisma.user.findUniqueOrThrow({ where: { discordId: 'rebate-x2' } });

    await expect(applyWeeklyRebate()).rejects.toThrow();

    const houseAfter = await prisma.house.findUniqueOrThrow({ where: { id: HOUSE_ID } });
    const x1After = await prisma.user.findUniqueOrThrow({ where: { discordId: 'rebate-x1' } });
    const x2After = await prisma.user.findUniqueOrThrow({ where: { discordId: 'rebate-x2' } });

    expect(houseAfter.balance).toBe(houseBefore.balance); // 롤백됨
    expect(x1After.balance).toBe(x1Before.balance); // 앞서 처리된 x1도 롤백됨
    expect(x2After.balance).toBe(x2Before.balance); // 앞서 처리된 x2도 롤백됨

    const houseTxs = await prisma.houseTransaction.findMany({ where: { type: 'REBATE' } });
    expect(houseTxs).toHaveLength(0);
    const userTxs = await prisma.transaction.findMany({ where: { type: 'REBATE' } });
    expect(userTxs).toHaveLength(0);
  });
});
