import { TransactionType } from '@prisma/client';
import { describe, expect, test } from 'vitest';
import { prisma } from '../../src/db/client';
import { getOrCreateUser } from '../../src/services/ledger';
import {
  AlreadyPurchasedLotteryError,
  InsufficientBalanceForLotteryError,
  InvalidLotteryNumberError,
  LOTTERY_TICKET_PRICE,
  purchaseLottery,
} from '../../src/services/lottery';

// 2026-07-01T02:00:00Z = 2026-07-01 11:00 KST (정오 이전)
const BEFORE_NOON_KST = new Date('2026-07-01T02:00:00.000Z');
// 2026-07-01T03:01:00Z = 2026-07-01 12:01 KST (정오 이후)
const AFTER_NOON_KST = new Date('2026-07-01T03:01:00.000Z');

describe('purchaseLottery - 정상 구매', () => {
  test('구매 성공 시 잔액이 차감되고 티켓이 생성되며 거래 기록이 남는다', async () => {
    await getOrCreateUser('l-buy-1');

    const result = await purchaseLottery({
      discordId: 'l-buy-1',
      chosenNumber: 7,
      now: BEFORE_NOON_KST,
    });

    expect(result.balanceAfter).toBe(10_000_000 - LOTTERY_TICKET_PRICE);

    const user = await prisma.user.findUniqueOrThrow({ where: { discordId: 'l-buy-1' } });
    expect(user.balance).toBe(10_000_000 - LOTTERY_TICKET_PRICE);

    const txs = await prisma.transaction.findMany({
      where: { userId: 'l-buy-1', type: TransactionType.LOTTERY_PURCHASE },
    });
    expect(txs).toHaveLength(1);
    expect(txs[0].amount).toBe(-LOTTERY_TICKET_PRICE);
    expect(txs[0].balanceAfter).toBe(10_000_000 - LOTTERY_TICKET_PRICE);

    const tickets = await prisma.lotteryTicket.findMany({ where: { userId: 'l-buy-1' } });
    expect(tickets).toHaveLength(1);
    expect(tickets[0].chosenNumber).toBe(7);
    expect(tickets[0].amount).toBe(LOTTERY_TICKET_PRICE);
    expect(tickets[0].settled).toBe(false);
  });

  test('경계 숫자 1과 20도 정상 구매된다', async () => {
    await getOrCreateUser('l-boundary-1');
    await getOrCreateUser('l-boundary-2');

    await expect(
      purchaseLottery({ discordId: 'l-boundary-1', chosenNumber: 1, now: BEFORE_NOON_KST })
    ).resolves.toBeDefined();

    await expect(
      purchaseLottery({ discordId: 'l-boundary-2', chosenNumber: 20, now: BEFORE_NOON_KST })
    ).resolves.toBeDefined();
  });
});

describe('purchaseLottery - drawDate 계산', () => {
  test('정오 이전(KST) 구매 시 drawDate는 오늘 날짜(KST)', async () => {
    await getOrCreateUser('l-draw-1');

    await purchaseLottery({ discordId: 'l-draw-1', chosenNumber: 5, now: BEFORE_NOON_KST });

    const ticket = await prisma.lotteryTicket.findFirstOrThrow({ where: { userId: 'l-draw-1' } });
    expect(ticket.drawDate.toISOString()).toBe('2026-07-01T00:00:00.000Z');
  });

  test('정오 이후(KST) 구매 시 drawDate는 내일 날짜(KST)', async () => {
    await getOrCreateUser('l-draw-2');

    await purchaseLottery({ discordId: 'l-draw-2', chosenNumber: 5, now: AFTER_NOON_KST });

    const ticket = await prisma.lotteryTicket.findFirstOrThrow({ where: { userId: 'l-draw-2' } });
    expect(ticket.drawDate.toISOString()).toBe('2026-07-02T00:00:00.000Z');
  });
});

describe('purchaseLottery - 숫자 범위 검증', () => {
  test('숫자가 0이면 거부되고 티켓이 생성되지 않는다', async () => {
    await getOrCreateUser('l-range-1');

    await expect(
      purchaseLottery({ discordId: 'l-range-1', chosenNumber: 0, now: BEFORE_NOON_KST })
    ).rejects.toThrow(InvalidLotteryNumberError);

    const tickets = await prisma.lotteryTicket.findMany({ where: { userId: 'l-range-1' } });
    expect(tickets).toHaveLength(0);
  });

  test('숫자가 21이면 거부된다', async () => {
    await getOrCreateUser('l-range-2');

    await expect(
      purchaseLottery({ discordId: 'l-range-2', chosenNumber: 21, now: BEFORE_NOON_KST })
    ).rejects.toThrow(InvalidLotteryNumberError);
  });
});

describe('purchaseLottery - 잔액 부족', () => {
  test('보유 포인트가 100만 미만이면 거부되고 잔액·티켓·거래가 변하지 않는다', async () => {
    await getOrCreateUser('l-poor-1');
    await prisma.user.update({
      where: { discordId: 'l-poor-1' },
      data: { balance: LOTTERY_TICKET_PRICE - 1 },
    });

    await expect(
      purchaseLottery({ discordId: 'l-poor-1', chosenNumber: 7, now: BEFORE_NOON_KST })
    ).rejects.toThrow(InsufficientBalanceForLotteryError);

    const user = await prisma.user.findUniqueOrThrow({ where: { discordId: 'l-poor-1' } });
    expect(user.balance).toBe(LOTTERY_TICKET_PRICE - 1);

    const tickets = await prisma.lotteryTicket.findMany({ where: { userId: 'l-poor-1' } });
    expect(tickets).toHaveLength(0);
  });

  test('정확히 100만 보유 시 구매 허용 (구매 후 잔액 0)', async () => {
    await getOrCreateUser('l-exact-1');
    await prisma.user.update({
      where: { discordId: 'l-exact-1' },
      data: { balance: LOTTERY_TICKET_PRICE },
    });

    const result = await purchaseLottery({
      discordId: 'l-exact-1',
      chosenNumber: 7,
      now: BEFORE_NOON_KST,
    });

    expect(result.balanceAfter).toBe(0);
  });
});

describe('purchaseLottery - 중복 구매 방지', () => {
  test('같은 회차에 두 번 구매하면 거부되고 첫 티켓만 남는다', async () => {
    await getOrCreateUser('l-dup-1');

    await purchaseLottery({ discordId: 'l-dup-1', chosenNumber: 7, now: BEFORE_NOON_KST });

    await expect(
      purchaseLottery({ discordId: 'l-dup-1', chosenNumber: 13, now: BEFORE_NOON_KST })
    ).rejects.toThrow(AlreadyPurchasedLotteryError);

    const tickets = await prisma.lotteryTicket.findMany({ where: { userId: 'l-dup-1' } });
    expect(tickets).toHaveLength(1);
    expect(tickets[0].chosenNumber).toBe(7);
  });

  test('다른 회차(다음 날)에는 재구매가 허용된다', async () => {
    await getOrCreateUser('l-dup-2');

    await purchaseLottery({
      discordId: 'l-dup-2',
      chosenNumber: 7,
      now: new Date('2026-07-01T02:00:00.000Z'), // Day 1, 11:00 KST
    });

    await purchaseLottery({
      discordId: 'l-dup-2',
      chosenNumber: 13,
      now: new Date('2026-07-02T02:00:00.000Z'), // Day 2, 11:00 KST
    });

    const tickets = await prisma.lotteryTicket.findMany({ where: { userId: 'l-dup-2' } });
    expect(tickets).toHaveLength(2);
  });

  test('정오 이후 구매 후 다음 날 정오 이전에 재구매하면 거부된다 (같은 회차)', async () => {
    await getOrCreateUser('l-dup-3');

    // Day 1 12:01 KST → drawDate = Day 2
    await purchaseLottery({
      discordId: 'l-dup-3',
      chosenNumber: 7,
      now: new Date('2026-07-01T03:01:00.000Z'),
    });

    // Day 2 11:00 KST → drawDate = Day 2 (같은 회차!)
    await expect(
      purchaseLottery({
        discordId: 'l-dup-3',
        chosenNumber: 13,
        now: new Date('2026-07-02T02:00:00.000Z'),
      })
    ).rejects.toThrow(AlreadyPurchasedLotteryError);

    const tickets = await prisma.lotteryTicket.findMany({ where: { userId: 'l-dup-3' } });
    expect(tickets).toHaveLength(1);
  });
});
