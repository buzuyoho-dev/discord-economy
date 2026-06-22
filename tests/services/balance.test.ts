import { describe, expect, test } from 'vitest';
import { prisma } from '../../src/db/client';
import { getBalanceSummary } from '../../src/services/balance';
import { applyTransaction, getOrCreateUser } from '../../src/services/ledger';

describe('getBalanceSummary', () => {
  test('처음 조회하는 유저는 시작 포인트로 생성되고 INITIAL 거래 1건이 함께 반환된다', async () => {
    const summary = await getBalanceSummary('discord-1');

    expect(summary.balance).toBe(10_000_000);
    expect(summary.recentTransactions).toHaveLength(1);
    expect(summary.recentTransactions[0].type).toBe('INITIAL');
  });

  test('최근 거래 내역을 최신순으로, 최대 5건까지만 반환한다', async () => {
    await getOrCreateUser('discord-2');

    for (let i = 0; i < 6; i++) {
      await prisma.$transaction((tx) =>
        applyTransaction(tx, {
          discordId: 'discord-2',
          type: 'ATTENDANCE',
          amount: 1,
          description: `tx-${i}`,
        })
      );
    }

    const summary = await getBalanceSummary('discord-2');

    expect(summary.recentTransactions).toHaveLength(5);
    // 가장 최근(tx-5)이 먼저 와야 함
    expect(summary.recentTransactions[0].description).toBe('tx-5');
    expect(summary.recentTransactions[4].description).toBe('tx-1');
  });
});
