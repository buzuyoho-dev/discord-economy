import { describe, expect, test } from 'vitest';
import { prisma } from '../../src/db/client';
import {
  applyTransaction,
  getOrCreateUser,
  InsufficientBalanceError,
} from '../../src/services/ledger';

describe('getOrCreateUser', () => {
  test('새 유저는 시작 포인트(1000만)를 받고 INITIAL 거래 내역이 기록된다', async () => {
    const user = await getOrCreateUser('discord-1');

    expect(user.balance).toBe(10_000_000);

    const transactions = await prisma.transaction.findMany({
      where: { userId: 'discord-1' },
    });
    expect(transactions).toHaveLength(1);
    expect(transactions[0].type).toBe('INITIAL');
    expect(transactions[0].amount).toBe(10_000_000);
    expect(transactions[0].balanceAfter).toBe(10_000_000);
  });

  test('이미 존재하는 유저를 다시 조회하면 추가 지급 없이 그대로 반환한다', async () => {
    await getOrCreateUser('discord-2');
    const second = await getOrCreateUser('discord-2');

    expect(second.balance).toBe(10_000_000);

    const transactions = await prisma.transaction.findMany({
      where: { userId: 'discord-2' },
    });
    expect(transactions).toHaveLength(1);
  });
});

describe('applyTransaction', () => {
  test('잔액을 증감시키고 같은 트랜잭션 안에서 거래 내역을 함께 기록한다', async () => {
    await getOrCreateUser('discord-3');

    const result = await prisma.$transaction((tx) =>
      applyTransaction(tx, {
        discordId: 'discord-3',
        type: 'ATTENDANCE',
        amount: 1_000_000,
        description: '출석 보상',
      })
    );

    expect(result.balance).toBe(11_000_000);

    const transactions = await prisma.transaction.findMany({
      where: { userId: 'discord-3' },
      orderBy: { createdAt: 'asc' },
    });
    expect(transactions).toHaveLength(2);
    expect(transactions[1].type).toBe('ATTENDANCE');
    expect(transactions[1].amount).toBe(1_000_000);
    expect(transactions[1].balanceAfter).toBe(11_000_000);
    expect(transactions[1].description).toBe('출석 보상');
  });

  test('음수 amount를 넘기면 잔액이 감소하고 거래 내역에도 음수로 기록된다', async () => {
    await getOrCreateUser('discord-4');

    const result = await prisma.$transaction((tx) =>
      applyTransaction(tx, {
        discordId: 'discord-4',
        type: 'TAX',
        amount: -50_000,
        description: '베팅세',
      })
    );

    expect(result.balance).toBe(9_950_000);

    const transactions = await prisma.transaction.findMany({
      where: { userId: 'discord-4' },
      orderBy: { createdAt: 'asc' },
    });
    expect(transactions[1].amount).toBe(-50_000);
    expect(transactions[1].balanceAfter).toBe(9_950_000);
  });

  test('두 쓰기 중 하나가 실패하면 트랜잭션 전체가 롤백되어 잔액과 거래 내역 모두 변경되지 않는다', async () => {
    await getOrCreateUser('discord-5');

    await expect(
      prisma.$transaction((tx) =>
        applyTransaction(tx, {
          discordId: 'discord-5',
          // @ts-expect-error 잘못된 타입 값으로 두 번째 쓰기(Transaction.create)를 실패시켜 롤백을 검증한다
          type: 'NOT_A_REAL_TYPE',
          amount: 500_000,
        })
      )
    ).rejects.toThrow();

    const user = await prisma.user.findUniqueOrThrow({
      where: { discordId: 'discord-5' },
    });
    expect(user.balance).toBe(10_000_000);

    const transactions = await prisma.transaction.findMany({
      where: { userId: 'discord-5' },
    });
    expect(transactions).toHaveLength(1);
  });

  test('보유 잔액보다 큰 금액을 차감하면 InsufficientBalanceError를 던지고 잔액·거래 내역이 그대로 유지된다', async () => {
    await getOrCreateUser('discord-6');

    await expect(
      prisma.$transaction((tx) =>
        applyTransaction(tx, {
          discordId: 'discord-6',
          type: 'BET',
          amount: -10_000_001,
        })
      )
    ).rejects.toThrow(InsufficientBalanceError);

    const user = await prisma.user.findUniqueOrThrow({
      where: { discordId: 'discord-6' },
    });
    expect(user.balance).toBe(10_000_000);

    const transactions = await prisma.transaction.findMany({
      where: { userId: 'discord-6' },
    });
    expect(transactions).toHaveLength(1);
  });

  test('정확히 0이 되는 차감(올인)은 허용된다', async () => {
    await getOrCreateUser('discord-7');

    const result = await prisma.$transaction((tx) =>
      applyTransaction(tx, {
        discordId: 'discord-7',
        type: 'BET',
        amount: -10_000_000,
      })
    );

    expect(result.balance).toBe(0);
  });
});

describe('applyTransaction 여러 건을 하나의 트랜잭션으로 묶기 (모드1 베팅 정산 전제 조건)', () => {
  test('패자 2명·승자 2명 정산 중 마지막(4번째) 쓰기가 실패하면 앞의 3건까지 전부 롤백된다', async () => {
    await getOrCreateUser('settle-1');
    await getOrCreateUser('settle-2');
    await getOrCreateUser('settle-3');
    await getOrCreateUser('settle-4');

    await expect(
      prisma.$transaction(async (tx) => {
        await applyTransaction(tx, { discordId: 'settle-1', type: 'BET', amount: -1_000_000 });
        await applyTransaction(tx, { discordId: 'settle-2', type: 'BET', amount: -1_000_000 });
        await applyTransaction(tx, { discordId: 'settle-3', type: 'BET', amount: 1_000_000 });
        await applyTransaction(tx, {
          discordId: 'settle-4',
          // @ts-expect-error 네 번째(마지막) 쓰기를 의도적으로 실패시켜 앞의 세 건까지 롤백되는지 검증
          type: 'NOT_A_REAL_TYPE',
          amount: 1_000_000,
        });
      })
    ).rejects.toThrow();

    for (const discordId of ['settle-1', 'settle-2', 'settle-3', 'settle-4']) {
      const user = await prisma.user.findUniqueOrThrow({ where: { discordId } });
      expect(user.balance).toBe(10_000_000);

      const transactions = await prisma.transaction.findMany({ where: { userId: discordId } });
      expect(transactions).toHaveLength(1);
      expect(transactions[0].type).toBe('INITIAL');
    }
  });
});
