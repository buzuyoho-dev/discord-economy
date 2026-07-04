import { describe, expect, test } from 'vitest';
import { prisma } from '../../src/db/client';
import { assignTier, getRankings } from '../../src/services/ranking';
import { getOrCreateHouse } from '../../src/services/house';
import { getOrCreateUser } from '../../src/services/ledger';
import { acceptLoan, requestLoan } from '../../src/services/loan';

describe('assignTier', () => {
  test('인원이 1명이면 1위가 신이다 (최하위보다 1위 규칙이 우선)', () => {
    expect(assignTier(1, 1)).toBe('신');
  });

  test('인원이 2명이면 1위는 신, 2위는 (동시에 최하위라) 노비다', () => {
    expect(assignTier(1, 2)).toBe('신');
    expect(assignTier(2, 2)).toBe('노비');
  });

  test('인원이 3명이면 1위 신, 2위 신하, 3위(최하위) 노비, 평민 없음', () => {
    expect(assignTier(1, 3)).toBe('신');
    expect(assignTier(2, 3)).toBe('신하');
    expect(assignTier(3, 3)).toBe('노비');
  });

  test('인원이 4명 이상이면 3위~끝에서 두 번째는 평민이다', () => {
    expect(assignTier(1, 4)).toBe('신');
    expect(assignTier(2, 4)).toBe('신하');
    expect(assignTier(3, 4)).toBe('평민');
    expect(assignTier(4, 4)).toBe('노비');

    expect(assignTier(1, 5)).toBe('신');
    expect(assignTier(2, 5)).toBe('신하');
    expect(assignTier(3, 5)).toBe('평민');
    expect(assignTier(4, 5)).toBe('평민');
    expect(assignTier(5, 5)).toBe('노비');
  });
});

describe('getRankings', () => {
  test('유저가 없으면 빈 배열을 반환한다', async () => {
    expect(await getRankings()).toEqual([]);
  });

  test('보유 포인트(balance) 내림차순으로 순위를 매긴다', async () => {
    await getOrCreateUser('rank-a');
    await getOrCreateUser('rank-b');
    await getOrCreateUser('rank-c');

    await prisma.user.update({ where: { discordId: 'rank-a' }, data: { balance: 5_000_000 } });
    await prisma.user.update({ where: { discordId: 'rank-b' }, data: { balance: 20_000_000 } });
    await prisma.user.update({ where: { discordId: 'rank-c' }, data: { balance: 10_000_000 } });

    const rankings = await getRankings();

    expect(rankings.map((r) => r.discordId)).toEqual(['rank-b', 'rank-c', 'rank-a']);
    expect(rankings.map((r) => r.rank)).toEqual([1, 2, 3]);
    expect(rankings.map((r) => r.tier)).toEqual(['신', '신하', '노비']);
  });

  test('잔액이 동일하면 discordId 오름차순으로 안정적인 순위를 매긴다', async () => {
    await getOrCreateUser('tie-z');
    await getOrCreateUser('tie-a');

    await prisma.user.update({ where: { discordId: 'tie-z' }, data: { balance: 1_000_000 } });
    await prisma.user.update({ where: { discordId: 'tie-a' }, data: { balance: 1_000_000 } });

    const rankings = await getRankings();
    expect(rankings.map((r) => r.discordId)).toEqual(['tie-a', 'tie-z']);
  });

  test('House는 순위 집계에 포함되지 않는다', async () => {
    await getOrCreateUser('rank-with-house');
    await getOrCreateHouse();
    await prisma.house.update({ where: { id: 'singleton' }, data: { balance: 999_999_999 } });

    const rankings = await getRankings();
    expect(rankings.some((r) => r.discordId === 'singleton')).toBe(false);
    expect(rankings).toHaveLength(1);
  });

  test('excludeUserId를 지정하면 User row가 실제로 있어도(예: 봇 계정) 순위 집계에서 제외된다', async () => {
    await getOrCreateUser('rank-real-user');
    await getOrCreateUser('rank-bot-user');
    await prisma.user.update({ where: { discordId: 'rank-bot-user' }, data: { balance: 999_999_999 } });

    const rankings = await getRankings({ excludeUserId: 'rank-bot-user' });

    expect(rankings.some((r) => r.discordId === 'rank-bot-user')).toBe(false);
    expect(rankings).toHaveLength(1);
    expect(rankings[0].discordId).toBe('rank-real-user');
    expect(rankings[0].rank).toBe(1); // 봇이 빠졌으니 유일한 유저가 1위
  });

  test('대출 채권/채무는 별도로 보정되지 않고, balance 컬럼에 이미 반영된 값 그대로 순위에 쓰인다', async () => {
    await getOrCreateUser('rank-lender');
    await getOrCreateUser('rank-borrower');
    await getOrCreateHouse();

    // 대출자는 원금만큼 즉시 차감되고, 차입자는 수수료를 뗀 만큼 즉시 증가한다 (6단계에서 구현된 그대로).
    const requested = await requestLoan({
      lenderId: 'rank-lender',
      borrowerId: 'rank-borrower',
      principal: 9_000_000,
    });
    await acceptLoan({ loanId: requested.id, acceptedBy: 'rank-borrower' });

    const rankings = await getRankings();
    const lender = rankings.find((r) => r.discordId === 'rank-lender');
    const borrower = rankings.find((r) => r.discordId === 'rank-borrower');

    // 대출자 채권(받을 돈)은 가산되지 않으므로 balance 그대로(10,000,000 - 9,000,000)
    expect(lender?.balance).toBe(10_000_000 - 9_000_000);
    // 차입자 채무(갚을 돈)는 차감되지 않으므로 balance 그대로(10,000,000 + 9,000,000 - 2% 수수료)
    expect(borrower?.balance).toBe(10_000_000 + 9_000_000 - 180_000);
    // 차입자가 채무를 안 갚았는데도 잔액이 더 많아 더 높은 순위를 받는다 (채무 미반영을 직접 증명)
    expect(borrower?.rank).toBeLessThan(lender?.rank ?? Infinity);
  });
});
