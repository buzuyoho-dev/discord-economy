import { describe, expect, test } from 'vitest';
import { prisma } from '../../src/db/client';
import { getOrCreateUser, InsufficientBalanceError } from '../../src/services/ledger';
import {
  applyHouseTransaction,
  computeHouseCapExcess,
  getEconomySnapshot,
  getHouseStatus,
  getOrCreateHouse,
  HOUSE_ID,
} from '../../src/services/house';

describe('getOrCreateHouse', () => {
  test('하우스 레코드가 없으면 잔액 0으로 생성한다', async () => {
    const house = await getOrCreateHouse();

    expect(house.id).toBe(HOUSE_ID);
    expect(house.balance).toBe(0);
  });

  test('이미 존재하면 그대로 반환하고 중복 생성하지 않는다', async () => {
    await getOrCreateHouse();
    const second = await getOrCreateHouse();

    expect(second.id).toBe(HOUSE_ID);

    const count = await prisma.house.count();
    expect(count).toBe(1);
  });
});

describe('getEconomySnapshot', () => {
  test('하우스/유저가 모두 없으면 전부 0이다', async () => {
    const snapshot = await getEconomySnapshot();

    expect(snapshot.house.balance).toBe(0);
    expect(snapshot.totalUserBalance).toBe(0);
    expect(snapshot.totalEconomy).toBe(0);
  });

  test('유저 잔액 합 + 하우스 잔액을 totalEconomy로 반환한다', async () => {
    await getOrCreateUser('snapshot-1'); // 10,000,000
    await getOrCreateUser('snapshot-2'); // 10,000,000
    await getOrCreateHouse();
    await prisma.$transaction((tx) =>
      applyHouseTransaction(tx, { type: 'TAX', amount: 5_000_000, description: 'test setup' })
    );

    const snapshot = await getEconomySnapshot();

    expect(snapshot.house.balance).toBe(5_000_000);
    expect(snapshot.totalUserBalance).toBe(20_000_000);
    expect(snapshot.totalEconomy).toBe(25_000_000);
  });
});

describe('computeHouseCapExcess', () => {
  test('하우스 잔액이 캡을 초과하면 초과분을 양수로 반환한다', () => {
    const result = computeHouseCapExcess({
      totalEconomy: 100_000,
      houseBalance: 80_000,
      capRatio: 0.5,
    });

    expect(result.capAmount).toBe(50_000);
    expect(result.excessAmount).toBe(30_000);
  });

  test('하우스 잔액이 캡 미만이면 초과분은 0이다(음수 아님)', () => {
    const result = computeHouseCapExcess({
      totalEconomy: 100_000,
      houseBalance: 30_000,
      capRatio: 0.5,
    });

    expect(result.capAmount).toBe(50_000);
    expect(result.excessAmount).toBe(0);
  });

  test('하우스 잔액이 캡과 정확히 같으면 초과분은 정확히 0이다', () => {
    const result = computeHouseCapExcess({
      totalEconomy: 100_000,
      houseBalance: 50_000,
      capRatio: 0.5,
    });

    expect(result.capAmount).toBe(50_000);
    expect(result.excessAmount).toBe(0);
  });
});

describe('getHouseStatus', () => {
  test('하우스/유저가 없으면 잔액과 점유율 모두 0이다', async () => {
    const status = await getHouseStatus();

    expect(status.balance).toBe(0);
    expect(status.totalUserBalance).toBe(0);
    expect(status.share).toBe(0);
  });

  test('하우스 잔액과 전체 유저 잔액 합을 기준으로 점유율을 계산한다', async () => {
    await getOrCreateUser('house-status-1'); // 10,000,000
    await getOrCreateUser('house-status-2'); // 10,000,000
    await getOrCreateHouse();
    await prisma.$transaction((tx) =>
      applyHouseTransaction(tx, { type: 'TAX', amount: 5_000_000, description: 'test setup' })
    );

    const status = await getHouseStatus();

    expect(status.balance).toBe(5_000_000);
    expect(status.totalUserBalance).toBe(20_000_000);
    expect(status.share).toBeCloseTo(0.2);
  });
});

describe('applyHouseTransaction', () => {
  test('잔액을 증가시키고 같은 트랜잭션 안에서 HouseTransaction을 함께 기록한다', async () => {
    await getOrCreateHouse();

    const result = await prisma.$transaction((tx) =>
      applyHouseTransaction(tx, {
        type: 'TAX',
        amount: 50_000,
        description: '베팅세 수취',
      })
    );

    expect(result.balance).toBe(50_000);

    const txs = await prisma.houseTransaction.findMany();
    expect(txs).toHaveLength(1);
    expect(txs[0].type).toBe('TAX');
    expect(txs[0].amount).toBe(50_000);
    expect(txs[0].balanceAfter).toBe(50_000);
    expect(txs[0].description).toBe('베팅세 수취');
  });

  test('잔액보다 큰 금액을 차감하면 InsufficientBalanceError를 던지고 잔액·거래 내역이 그대로 유지된다', async () => {
    await getOrCreateHouse();
    await prisma.$transaction((tx) => applyHouseTransaction(tx, { type: 'TAX', amount: 100_000 }));

    await expect(
      prisma.$transaction((tx) =>
        applyHouseTransaction(tx, { type: 'BET', amount: -100_001, description: '모드2 충당' })
      )
    ).rejects.toThrow(InsufficientBalanceError);

    const house = await prisma.house.findUniqueOrThrow({ where: { id: HOUSE_ID } });
    expect(house.balance).toBe(100_000);

    const txs = await prisma.houseTransaction.findMany();
    expect(txs).toHaveLength(1);
  });

  test('정확히 0이 되는 차감은 허용된다', async () => {
    await getOrCreateHouse();
    await prisma.$transaction((tx) => applyHouseTransaction(tx, { type: 'TAX', amount: 100_000 }));

    const result = await prisma.$transaction((tx) =>
      applyHouseTransaction(tx, { type: 'BET', amount: -100_000 })
    );

    expect(result.balance).toBe(0);
  });

  test('두 쓰기 중 하나가 실패하면 트랜잭션 전체가 롤백되어 잔액과 거래 내역 모두 변경되지 않는다', async () => {
    await getOrCreateHouse();

    await expect(
      prisma.$transaction((tx) =>
        applyHouseTransaction(tx, {
          // @ts-expect-error 잘못된 타입 값으로 두 번째 쓰기(HouseTransaction.create)를 실패시켜 롤백을 검증한다
          type: 'NOT_A_REAL_TYPE',
          amount: 10_000,
        })
      )
    ).rejects.toThrow();

    const house = await prisma.house.findUniqueOrThrow({ where: { id: HOUSE_ID } });
    expect(house.balance).toBe(0);

    const txs = await prisma.houseTransaction.findMany();
    expect(txs).toHaveLength(0);
  });
});
