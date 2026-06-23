import { TransactionType } from '@prisma/client';
import { describe, expect, test } from 'vitest';
import { prisma } from '../../src/db/client';
import { getOrCreateHouse, HOUSE_ID } from '../../src/services/house';
import { getOrCreateUser } from '../../src/services/ledger';
import {
  AlreadyPurchasedGambleExtraError,
  DailyGambleLimitExceededError,
  gamble,
  GAMBLE_EXTRA_PURCHASE_PRICE,
  InsufficientBalanceForGambleExtraPurchaseError,
  purchaseGambleExtra,
} from '../../src/services/gamble';

const forceWin = () => 0;

describe('purchaseGambleExtra - 정상 구매', () => {
  test('구매 성공 시 잔액이 차감되고 하우스로 귀속되며 거래 기록이 남는다', async () => {
    await getOrCreateUser('p-buy-1');
    await getOrCreateHouse();

    const result = await purchaseGambleExtra({ discordId: 'p-buy-1' });

    expect(result.balanceAfter).toBe(10_000_000 - GAMBLE_EXTRA_PURCHASE_PRICE);

    const user = await prisma.user.findUniqueOrThrow({ where: { discordId: 'p-buy-1' } });
    expect(user.balance).toBe(10_000_000 - GAMBLE_EXTRA_PURCHASE_PRICE);

    const txs = await prisma.transaction.findMany({
      where: { userId: 'p-buy-1', type: TransactionType.GAMBLE_EXTRA_PURCHASE },
    });
    expect(txs).toHaveLength(1);
    expect(txs[0].amount).toBe(-GAMBLE_EXTRA_PURCHASE_PRICE);
    expect(txs[0].balanceAfter).toBe(10_000_000 - GAMBLE_EXTRA_PURCHASE_PRICE);

    const house = await prisma.house.findUniqueOrThrow({ where: { id: HOUSE_ID } });
    expect(house.balance).toBe(GAMBLE_EXTRA_PURCHASE_PRICE);

    const houseTxs = await prisma.houseTransaction.findMany({
      where: { type: TransactionType.GAMBLE_EXTRA_PURCHASE },
    });
    expect(houseTxs).toHaveLength(1);
    expect(houseTxs[0].amount).toBe(GAMBLE_EXTRA_PURCHASE_PRICE);
    expect(houseTxs[0].balanceAfter).toBe(GAMBLE_EXTRA_PURCHASE_PRICE);
  });

  test('House row가 없는 상태에서도 구매가 정상 동작한다 (지연 생성)', async () => {
    await getOrCreateUser('p-buy-2');

    const result = await purchaseGambleExtra({ discordId: 'p-buy-2' });
    expect(result.balanceAfter).toBe(10_000_000 - GAMBLE_EXTRA_PURCHASE_PRICE);

    const house = await prisma.house.findUniqueOrThrow({ where: { id: HOUSE_ID } });
    expect(house.balance).toBe(GAMBLE_EXTRA_PURCHASE_PRICE);
  });
});

describe('purchaseGambleExtra - 하루 1회 제한', () => {
  test('같은 날 두 번째 구매는 거부된다', async () => {
    await getOrCreateUser('p-twice-1');

    await purchaseGambleExtra({ discordId: 'p-twice-1', now: new Date('2026-06-21T01:00:00.000Z') });

    await expect(
      purchaseGambleExtra({ discordId: 'p-twice-1', now: new Date('2026-06-21T10:00:00.000Z') })
    ).rejects.toThrow(AlreadyPurchasedGambleExtraError);

    const txs = await prisma.transaction.findMany({
      where: { userId: 'p-twice-1', type: TransactionType.GAMBLE_EXTRA_PURCHASE },
    });
    expect(txs).toHaveLength(1);
  });

  test('다음 날(KST)이 되면 다시 구매할 수 있다', async () => {
    await getOrCreateUser('p-twice-2');

    await purchaseGambleExtra({ discordId: 'p-twice-2', now: new Date('2026-06-21T01:00:00.000Z') });

    const result = await purchaseGambleExtra({
      discordId: 'p-twice-2',
      now: new Date('2026-06-22T01:00:00.000Z'),
    });

    expect(result.balanceAfter).toBe(10_000_000 - GAMBLE_EXTRA_PURCHASE_PRICE * 2);
  });
});

describe('purchaseGambleExtra - 잔액 부족', () => {
  test('보유 포인트가 가격보다 적으면 구매가 거부되고 잔액·거래·하우스가 변하지 않는다', async () => {
    await getOrCreateUser('p-poor-1');
    await getOrCreateHouse();
    await prisma.user.update({
      where: { discordId: 'p-poor-1' },
      data: { balance: GAMBLE_EXTRA_PURCHASE_PRICE - 1 },
    });

    await expect(purchaseGambleExtra({ discordId: 'p-poor-1' })).rejects.toThrow(
      InsufficientBalanceForGambleExtraPurchaseError
    );

    const user = await prisma.user.findUniqueOrThrow({ where: { discordId: 'p-poor-1' } });
    expect(user.balance).toBe(GAMBLE_EXTRA_PURCHASE_PRICE - 1);

    const txs = await prisma.transaction.findMany({
      where: { userId: 'p-poor-1', type: TransactionType.GAMBLE_EXTRA_PURCHASE },
    });
    expect(txs).toHaveLength(0);

    const house = await prisma.house.findUniqueOrThrow({ where: { id: HOUSE_ID } });
    expect(house.balance).toBe(0);
  });

  test('정확히 가격만큼 보유하면 구매가 허용된다 (구매 후 잔액 0)', async () => {
    await getOrCreateUser('p-exact-1');
    await getOrCreateHouse();
    await prisma.user.update({
      where: { discordId: 'p-exact-1' },
      data: { balance: GAMBLE_EXTRA_PURCHASE_PRICE },
    });

    const result = await purchaseGambleExtra({ discordId: 'p-exact-1' });
    expect(result.balanceAfter).toBe(0);
  });
});

describe('도박추가 구매 - 도박 한도 연동', () => {
  test('구매 후 3번째 도박 시도가 정상 처리된다 (한도가 2 -> 3으로 늘어남)', async () => {
    await getOrCreateUser('p-extra-gamble-1');
    await getOrCreateHouse();

    await purchaseGambleExtra({
      discordId: 'p-extra-gamble-1',
      now: new Date('2026-06-21T00:30:00.000Z'),
    });

    await gamble({ discordId: 'p-extra-gamble-1', random: forceWin, now: new Date('2026-06-21T01:00:00.000Z') });
    await gamble({ discordId: 'p-extra-gamble-1', random: forceWin, now: new Date('2026-06-21T02:00:00.000Z') });
    const third = await gamble({
      discordId: 'p-extra-gamble-1',
      random: forceWin,
      now: new Date('2026-06-21T03:00:00.000Z'),
    });

    expect(third.won).toBe(true);

    await expect(
      gamble({ discordId: 'p-extra-gamble-1', random: forceWin, now: new Date('2026-06-21T04:00:00.000Z') })
    ).rejects.toThrow(DailyGambleLimitExceededError);
  });

  test('구매하지 않은 유저는 여전히 2회까지만 도박할 수 있다 (3번째는 거부)', async () => {
    await getOrCreateUser('p-no-extra-1');
    await getOrCreateHouse();

    await gamble({ discordId: 'p-no-extra-1', random: forceWin, now: new Date('2026-06-21T01:00:00.000Z') });
    await gamble({ discordId: 'p-no-extra-1', random: forceWin, now: new Date('2026-06-21T02:00:00.000Z') });

    await expect(
      gamble({ discordId: 'p-no-extra-1', random: forceWin, now: new Date('2026-06-21T03:00:00.000Z') })
    ).rejects.toThrow(DailyGambleLimitExceededError);
  });
});
