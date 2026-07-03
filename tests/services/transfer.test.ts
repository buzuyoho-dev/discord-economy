import { describe, expect, test } from 'vitest';
import { prisma } from '../../src/db/client';
import { CreditBannedError } from '../../src/services/creditBan';
import { BotTargetError } from '../../src/services/discordTargetGuard';
import { getOrCreateHouse, HOUSE_ID } from '../../src/services/house';
import { getOrCreateUser } from '../../src/services/ledger';
import { createLoan } from '../../src/services/loan';
import {
  AlreadyTransferredTodayError,
  CannotTransferToSelfError,
  InvalidTransferAmountError,
  MAX_TRANSFER_AMOUNT,
  TransferAmountTooLargeError,
  transferPoints,
} from '../../src/services/transfer';

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

describe('transferPoints', () => {
  test('정상 양도: 보낸 사람은 전액 차감, 받는 사람은 수수료 제외 수령, 하우스는 수수료만큼 증가', async () => {
    await getOrCreateUser('sender-1');
    await getOrCreateUser('receiver-1');
    await getOrCreateHouse();

    const result = await transferPoints({
      senderId: 'sender-1',
      recipientId: 'receiver-1',
      amount: 1_000_000,
    });

    expect(result.fee).toBe(50_000);
    expect(result.netAmount).toBe(950_000);

    const sender = await prisma.user.findUniqueOrThrow({ where: { discordId: 'sender-1' } });
    const receiver = await prisma.user.findUniqueOrThrow({ where: { discordId: 'receiver-1' } });
    const house = await prisma.house.findUniqueOrThrow({ where: { id: HOUSE_ID } });

    expect(sender.balance).toBe(10_000_000 - 1_000_000);
    expect(receiver.balance).toBe(10_000_000 + 950_000);
    expect(house.balance).toBe(50_000);
  });

  test('수수료가 정수로 나누어지지 않아도 보낸 금액 = 받는 금액 + 수수료가 항상 정확히 일치한다', async () => {
    await getOrCreateUser('sender-2');
    await getOrCreateUser('receiver-2');
    await getOrCreateHouse();

    const amount = 1_000_001; // 5%가 50,000.05로 깔끔히 안 나뉘는 금액
    const result = await transferPoints({ senderId: 'sender-2', recipientId: 'receiver-2', amount });

    expect(result.fee + result.netAmount).toBe(amount);
    expect(result.fee).toBe(Math.floor(amount * 0.05)); // 내림 처리

    const house = await prisma.house.findUniqueOrThrow({ where: { id: HOUSE_ID } });
    expect(house.balance).toBe(result.fee);
  });

  test('5,000만 포인트는 한도 내에서 허용된다', async () => {
    await getOrCreateUser('sender-3');
    await getOrCreateUser('receiver-3');
    await getOrCreateHouse();

    // 한도 검증을 위해 충분한 잔액을 먼저 마련한다.
    await prisma.user.update({ where: { discordId: 'sender-3' }, data: { balance: 100_000_000 } });

    const result = await transferPoints({
      senderId: 'sender-3',
      recipientId: 'receiver-3',
      amount: MAX_TRANSFER_AMOUNT,
    });
    expect(result.fee + result.netAmount).toBe(MAX_TRANSFER_AMOUNT);
  });

  test('5,000만 포인트를 초과하면 거부된다', async () => {
    await getOrCreateUser('sender-4');
    await getOrCreateUser('receiver-4');

    await expect(
      transferPoints({ senderId: 'sender-4', recipientId: 'receiver-4', amount: MAX_TRANSFER_AMOUNT + 1 })
    ).rejects.toThrow(TransferAmountTooLargeError);
  });

  test('본인을 받는 사람으로 지정하면 거부된다', async () => {
    await getOrCreateUser('sender-5');

    await expect(
      transferPoints({ senderId: 'sender-5', recipientId: 'sender-5', amount: 1_000 })
    ).rejects.toThrow(CannotTransferToSelfError);
  });

  test('받는 사람이 봇이면 거부되고 잔액이 변하지 않는다', async () => {
    await getOrCreateUser('sender-bot-1');

    await expect(
      transferPoints({
        senderId: 'sender-bot-1',
        recipientId: 'bot-1',
        recipientIsBot: true,
        amount: 1_000_000,
      })
    ).rejects.toThrow(BotTargetError);

    const sender = await prisma.user.findUniqueOrThrow({ where: { discordId: 'sender-bot-1' } });
    expect(sender.balance).toBe(10_000_000); // 차감 없음

    const botUser = await prisma.user.findUnique({ where: { discordId: 'bot-1' } });
    expect(botUser).toBeNull(); // 봇 계정으로 User row가 생성되지 않는다
  });

  test.each([NaN, -5, 0, 1.5, Infinity, -Infinity])('금액이 %s이면 거부된다', async (amount) => {
    await getOrCreateUser('sender-6');
    await getOrCreateUser('receiver-6');

    await expect(
      transferPoints({ senderId: 'sender-6', recipientId: 'receiver-6', amount })
    ).rejects.toThrow(InvalidTransferAmountError);
  });

  test('같은 날 두 번째 양도를 시도하면 거부되고 잔액이 변하지 않는다', async () => {
    await getOrCreateUser('sender-7');
    await getOrCreateUser('receiver-7a');
    await getOrCreateUser('receiver-7b');
    await getOrCreateHouse();

    await transferPoints({
      senderId: 'sender-7',
      recipientId: 'receiver-7a',
      amount: 1_000_000,
      now: new Date('2026-06-21T01:00:00.000Z'),
    });

    await expect(
      transferPoints({
        senderId: 'sender-7',
        recipientId: 'receiver-7b',
        amount: 500_000,
        now: new Date('2026-06-21T13:00:00.000Z'),
      })
    ).rejects.toThrow(AlreadyTransferredTodayError);

    const sender = await prisma.user.findUniqueOrThrow({ where: { discordId: 'sender-7' } });
    expect(sender.balance).toBe(10_000_000 - 1_000_000); // 두 번째 시도분은 반영 안 됨
  });

  test('다음 날(KST)에는 다시 양도할 수 있다', async () => {
    await getOrCreateUser('sender-8');
    await getOrCreateUser('receiver-8a');
    await getOrCreateUser('receiver-8b');
    await getOrCreateHouse();

    await transferPoints({
      senderId: 'sender-8',
      recipientId: 'receiver-8a',
      amount: 1_000_000,
      now: new Date('2026-06-21T01:00:00.000Z'),
    });

    const result = await transferPoints({
      senderId: 'sender-8',
      recipientId: 'receiver-8b',
      amount: 1_000_000,
      now: new Date('2026-06-22T01:00:00.000Z'),
    });

    expect(result.netAmount).toBe(950_000);

    const sender = await prisma.user.findUniqueOrThrow({ where: { discordId: 'sender-8' } });
    expect(sender.balance).toBe(10_000_000 - 2_000_000);
  });

  test('동시에 두 번 양도를 시도해도 차감은 정확히 한 번만 일어난다', async () => {
    await getOrCreateUser('sender-9');
    await getOrCreateUser('receiver-9a');
    await getOrCreateUser('receiver-9b');
    await getOrCreateHouse();

    const results = await Promise.allSettled([
      transferPoints({ senderId: 'sender-9', recipientId: 'receiver-9a', amount: 1_000_000 }),
      transferPoints({ senderId: 'sender-9', recipientId: 'receiver-9b', amount: 1_000_000 }),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(AlreadyTransferredTodayError);

    const sender = await prisma.user.findUniqueOrThrow({ where: { discordId: 'sender-9' } });
    expect(sender.balance).toBe(10_000_000 - 1_000_000); // 한 번만 차감됨
  });

  test('보내는 사람이 신용불량 상태면 양도가 거부된다', async () => {
    await getOrCreateUser('lender-cb-t1');
    await getOrCreateUser('sender-cb-t1');
    await getOrCreateUser('receiver-cb-t1');
    await getOrCreateHouse();

    const loan = await createLoan({
      lenderId: 'lender-cb-t1',
      borrowerId: 'sender-cb-t1',
      principal: 1_000_000,
      now: new Date('2026-06-01T00:00:00.000Z'),
      dueAt: new Date('2026-06-08T00:00:00.000Z'),
    });

    const elevenDaysLate = new Date(loan.dueAt.getTime() + 11 * ONE_DAY_MS);

    await expect(
      transferPoints({
        senderId: 'sender-cb-t1',
        recipientId: 'receiver-cb-t1',
        amount: 100_000,
        now: elevenDaysLate,
      })
    ).rejects.toThrow(CreditBannedError);
  });
});
