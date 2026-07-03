import { describe, expect, test } from 'vitest';
import { formatTransactionLine, formatTransactionLineWithUser } from '../../src/discord/transactionView';

describe('formatTransactionLine', () => {
  test('증가 거래는 +부호와 함께 종류/금액/잔액/설명을 한 줄로 보여준다', () => {
    const line = formatTransactionLine({
      type: 'BLACKJACK_WIN',
      amount: 2_000_000,
      balanceAfter: 12_000_000,
      description: '블랙잭 승리 정산',
      createdAt: new Date('2026-07-06T03:00:00.000Z'),
    });

    expect(line).toContain('블랙잭 승리');
    expect(line).toContain('+2,000,000');
    expect(line).toContain('잔액 12,000,000');
    expect(line).toContain('블랙잭 승리 정산');
  });

  test('감소 거래는 이미 -가 붙어있어 부호를 중복으로 붙이지 않는다', () => {
    const line = formatTransactionLine({
      type: 'RPS_BET',
      amount: -1_000_000,
      balanceAfter: 9_000_000,
      description: null,
      createdAt: new Date('2026-07-06T03:00:00.000Z'),
    });

    expect(line).toContain('가위바위보 베팅');
    expect(line).toContain('-1,000,000');
    expect(line).not.toContain('+-');
  });

  test('설명이 없으면 설명 부분을 생략한다', () => {
    const line = formatTransactionLine({
      type: 'INITIAL',
      amount: 10_000_000,
      balanceAfter: 10_000_000,
      description: null,
      createdAt: new Date('2026-07-06T03:00:00.000Z'),
    });

    expect(line).not.toContain(' - null');
    expect(line).not.toContain(' - undefined');
  });

  test('모르는 타입이면 원래 문자열을 그대로 라벨로 쓴다', () => {
    const line = formatTransactionLine({
      type: 'SOME_FUTURE_TYPE',
      amount: 1,
      balanceAfter: 1,
      description: null,
      createdAt: new Date('2026-07-06T03:00:00.000Z'),
    });

    expect(line).toContain('SOME_FUTURE_TYPE');
  });
});

describe('formatTransactionLineWithUser', () => {
  test('유저 멘션을 줄 맨 앞에 붙인다', () => {
    const line = formatTransactionLineWithUser({
      userId: 'user-123',
      type: 'REBATE',
      amount: 100_000,
      balanceAfter: 5_000_000,
      description: '환급',
      createdAt: new Date('2026-07-06T03:00:00.000Z'),
    });

    expect(line.startsWith('<@user-123>')).toBe(true);
    expect(line).toContain('환급');
  });
});
