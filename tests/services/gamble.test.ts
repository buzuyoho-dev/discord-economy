import { TransactionType } from '@prisma/client';
import { describe, expect, test } from 'vitest';
import { prisma } from '../../src/db/client';
import { getOrCreateHouse, HOUSE_ID } from '../../src/services/house';
import { applyTransaction, getOrCreateUser } from '../../src/services/ledger';
import {
  buildGambleRollbackDescription,
  DailyGambleLimitExceededError,
  GAMBLE_AMOUNT,
  gamble,
  InsufficientBalanceForGambleError,
  MAX_GAMBLES_PER_DAY,
} from '../../src/services/gamble';

const forceWin = () => 0;
const forceLose = () => 0.99;

describe('gamble - 승리', () => {
  test('승리하면 유저 잔액이 100만 증가하고 GAMBLE_WIN 거래만 기록되며 하우스는 변하지 않는다', async () => {
    await getOrCreateUser('g-win-1');
    await getOrCreateHouse();

    const result = await gamble({ discordId: 'g-win-1', random: forceWin });

    expect(result.won).toBe(true);
    expect(result.amount).toBe(GAMBLE_AMOUNT);
    expect(result.balanceAfter).toBe(10_000_000 + GAMBLE_AMOUNT);

    const user = await prisma.user.findUniqueOrThrow({ where: { discordId: 'g-win-1' } });
    expect(user.balance).toBe(10_000_000 + GAMBLE_AMOUNT);

    const txs = await prisma.transaction.findMany({ where: { userId: 'g-win-1', type: 'GAMBLE_WIN' } });
    expect(txs).toHaveLength(1);
    expect(txs[0].amount).toBe(GAMBLE_AMOUNT);
    expect(txs[0].balanceAfter).toBe(10_000_000 + GAMBLE_AMOUNT);

    const house = await prisma.house.findUniqueOrThrow({ where: { id: HOUSE_ID } });
    expect(house.balance).toBe(0);
    const houseTxs = await prisma.houseTransaction.findMany();
    expect(houseTxs).toHaveLength(0);
  });
});

describe('gamble - 패배', () => {
  test('패배하면 유저 잔액이 100만 감소하고 하우스로 귀속되며 양쪽에 거래가 기록된다', async () => {
    await getOrCreateUser('g-lose-1');
    await getOrCreateHouse();

    const result = await gamble({ discordId: 'g-lose-1', random: forceLose });

    expect(result.won).toBe(false);
    expect(result.amount).toBe(-GAMBLE_AMOUNT);
    expect(result.balanceAfter).toBe(10_000_000 - GAMBLE_AMOUNT);

    const user = await prisma.user.findUniqueOrThrow({ where: { discordId: 'g-lose-1' } });
    expect(user.balance).toBe(10_000_000 - GAMBLE_AMOUNT);

    const txs = await prisma.transaction.findMany({ where: { userId: 'g-lose-1', type: 'GAMBLE_LOSE' } });
    expect(txs).toHaveLength(1);
    expect(txs[0].amount).toBe(-GAMBLE_AMOUNT);

    const house = await prisma.house.findUniqueOrThrow({ where: { id: HOUSE_ID } });
    expect(house.balance).toBe(GAMBLE_AMOUNT);

    const houseTxs = await prisma.houseTransaction.findMany({ where: { type: 'GAMBLE_LOSE' } });
    expect(houseTxs).toHaveLength(1);
    expect(houseTxs[0].amount).toBe(GAMBLE_AMOUNT);
    expect(houseTxs[0].balanceAfter).toBe(GAMBLE_AMOUNT);
  });

  test('잔액이 100만 미만이면 도박이 거부되고 잔액·거래 내역이 변하지 않는다 (승패와 무관하게 거부)', async () => {
    await getOrCreateUser('g-poor-1');
    await getOrCreateHouse();
    await prisma.user.update({ where: { discordId: 'g-poor-1' }, data: { balance: 999_999 } });

    await expect(gamble({ discordId: 'g-poor-1', random: forceWin })).rejects.toThrow(
      InsufficientBalanceForGambleError
    );

    const user = await prisma.user.findUniqueOrThrow({ where: { discordId: 'g-poor-1' } });
    expect(user.balance).toBe(999_999);

    const txs = await prisma.transaction.findMany({
      where: { userId: 'g-poor-1', type: { in: ['GAMBLE_WIN', 'GAMBLE_LOSE'] } },
    });
    expect(txs).toHaveLength(0);

    const house = await prisma.house.findUniqueOrThrow({ where: { id: HOUSE_ID } });
    expect(house.balance).toBe(0);
  });

  test('정확히 100만이면 도박이 허용된다 (패배 시 잔액 0)', async () => {
    await getOrCreateUser('g-exact-1');
    await getOrCreateHouse();
    await prisma.user.update({ where: { discordId: 'g-exact-1' }, data: { balance: GAMBLE_AMOUNT } });

    const result = await gamble({ discordId: 'g-exact-1', random: forceLose });
    expect(result.balanceAfter).toBe(0);
  });
});

describe('gamble - 하루 횟수 제한', () => {
  test(`하루 ${MAX_GAMBLES_PER_DAY}회까지는 허용되고 그 다음 시도는 거부된다`, async () => {
    await getOrCreateUser('g-limit-1');
    await getOrCreateHouse();

    await gamble({ discordId: 'g-limit-1', random: forceWin, now: new Date('2026-06-21T01:00:00.000Z') });
    await gamble({ discordId: 'g-limit-1', random: forceWin, now: new Date('2026-06-21T05:00:00.000Z') });

    await expect(
      gamble({ discordId: 'g-limit-1', random: forceWin, now: new Date('2026-06-21T10:00:00.000Z') })
    ).rejects.toThrow(DailyGambleLimitExceededError);

    const txs = await prisma.transaction.findMany({
      where: { userId: 'g-limit-1', type: { in: ['GAMBLE_WIN', 'GAMBLE_LOSE'] } },
    });
    expect(txs).toHaveLength(MAX_GAMBLES_PER_DAY);
  });

  test('다음 날(KST)이 되면 다시 도박할 수 있다', async () => {
    await getOrCreateUser('g-limit-2');
    await getOrCreateHouse();

    await gamble({ discordId: 'g-limit-2', random: forceWin, now: new Date('2026-06-21T01:00:00.000Z') });
    await gamble({ discordId: 'g-limit-2', random: forceWin, now: new Date('2026-06-21T05:00:00.000Z') });

    const result = await gamble({
      discordId: 'g-limit-2',
      random: forceWin,
      now: new Date('2026-06-22T01:00:00.000Z'),
    });
    expect(result.won).toBe(true);

    const txs = await prisma.transaction.findMany({
      where: { userId: 'g-limit-2', type: { in: ['GAMBLE_WIN', 'GAMBLE_LOSE'] } },
    });
    expect(txs).toHaveLength(3);
  });

  test('동시에 같은 유저가 3번 도박을 시도해도 정확히 2번만 성공한다', async () => {
    await getOrCreateUser('g-concurrent-1');
    await getOrCreateHouse();
    await prisma.user.update({ where: { discordId: 'g-concurrent-1' }, data: { balance: 100_000_000 } });

    const results = await Promise.allSettled([
      gamble({ discordId: 'g-concurrent-1', random: forceWin }),
      gamble({ discordId: 'g-concurrent-1', random: forceWin }),
      gamble({ discordId: 'g-concurrent-1', random: forceWin }),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(MAX_GAMBLES_PER_DAY);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(DailyGambleLimitExceededError);

    const txs = await prisma.transaction.findMany({
      where: { userId: 'g-concurrent-1', type: { in: ['GAMBLE_WIN', 'GAMBLE_LOSE'] } },
    });
    expect(txs).toHaveLength(MAX_GAMBLES_PER_DAY);
  });

  test('GAMBLE_ROLLBACK으로 되돌린 도박은 오늘 횟수에서 제외되어 다시 도박할 수 있다', async () => {
    const discordId = 'g-rollback-1';
    const user = await getOrCreateUser(discordId);
    await getOrCreateHouse();

    const win1 = await gamble({ discordId, random: forceWin });
    const win2 = await gamble({ discordId, random: forceWin });

    await expect(gamble({ discordId, random: forceWin })).rejects.toThrow(DailyGambleLimitExceededError);

    const winTxs = await prisma.transaction.findMany({
      where: { userId: discordId, type: TransactionType.GAMBLE_WIN },
      orderBy: { id: 'asc' },
    });
    expect(winTxs).toHaveLength(2);

    await prisma.$transaction(async (tx) => {
      for (const winTx of winTxs) {
        await applyTransaction(tx, {
          discordId,
          type: TransactionType.GAMBLE_ROLLBACK,
          amount: -winTx.amount,
          description: buildGambleRollbackDescription(winTx.id),
        });
      }
    });

    const restoredUser = await prisma.user.findUniqueOrThrow({ where: { discordId } });
    expect(restoredUser.balance).toBe(user.balance);
    expect(win1.won && win2.won).toBe(true); // 가정 확인: 두 번 다 승리했었다는 전제

    const result3 = await gamble({ discordId, random: forceWin });
    expect(result3.won).toBe(true);
    const result4 = await gamble({ discordId, random: forceWin });
    expect(result4.won).toBe(true);

    await expect(gamble({ discordId, random: forceWin })).rejects.toThrow(DailyGambleLimitExceededError);
  });
});

describe('gamble - 확률 회귀 검증', () => {
  test(
    '실제 난수(Math.random, 미모킹)로 1000회 반복 시 승률이 45~55% 사이여야 한다',
    async () => {
      await getOrCreateHouse();

      const TRIALS = 1000;
      let wins = 0;
      for (let i = 0; i < TRIALS; i++) {
        const result = await gamble({ discordId: `g-prob-${i}` });
        if (result.won) wins++;
      }

      const winRate = wins / TRIALS;
      expect(winRate).toBeGreaterThanOrEqual(0.45);
      expect(winRate).toBeLessThanOrEqual(0.55);
    },
    30_000
  );
});

describe('gamble - 원자성', () => {
  test('패배 처리 중 하우스 갱신이 실패하면 트랜잭션 전체가 롤백되어 유저 잔액도 변하지 않는다', async () => {
    await getOrCreateUser('g-atomic-1');
    // House 레코드를 생성하지 않아 House.update가 실패하도록 강제한다 (다른 서비스 테스트와 동일한 방식).

    await expect(gamble({ discordId: 'g-atomic-1', random: forceLose })).rejects.toThrow();

    const user = await prisma.user.findUniqueOrThrow({ where: { discordId: 'g-atomic-1' } });
    expect(user.balance).toBe(10_000_000);

    const txs = await prisma.transaction.findMany({
      where: { userId: 'g-atomic-1', type: { in: ['GAMBLE_WIN', 'GAMBLE_LOSE'] } },
    });
    expect(txs).toHaveLength(0);
  });
});
