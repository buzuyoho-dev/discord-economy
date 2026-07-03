import { describe, expect, test } from 'vitest';
import {
  BotChallengeError,
  calculateRpsPayout,
  determineRpsResult,
  RPS_WINNER_PROFIT_RATE,
  SelfChallengeError,
  validateOpponent,
} from '../../src/services/rps';

describe('determineRpsResult', () => {
  test('가위는 보를 이긴다 -> CHALLENGER_WIN', () => {
    expect(determineRpsResult('가위', '보')).toBe('CHALLENGER_WIN');
  });

  test('바위는 가위를 이긴다 -> CHALLENGER_WIN', () => {
    expect(determineRpsResult('바위', '가위')).toBe('CHALLENGER_WIN');
  });

  test('보는 바위를 이긴다 -> CHALLENGER_WIN', () => {
    expect(determineRpsResult('보', '바위')).toBe('CHALLENGER_WIN');
  });

  test('보는 가위에게 진다 -> OPPONENT_WIN', () => {
    expect(determineRpsResult('보', '가위')).toBe('OPPONENT_WIN');
  });

  test('가위는 바위에게 진다 -> OPPONENT_WIN', () => {
    expect(determineRpsResult('가위', '바위')).toBe('OPPONENT_WIN');
  });

  test('바위는 보에게 진다 -> OPPONENT_WIN', () => {
    expect(determineRpsResult('바위', '보')).toBe('OPPONENT_WIN');
  });

  test('같은 것을 내면 DRAW', () => {
    expect(determineRpsResult('가위', '가위')).toBe('DRAW');
    expect(determineRpsResult('바위', '바위')).toBe('DRAW');
    expect(determineRpsResult('보', '보')).toBe('DRAW');
  });
});

describe('calculateRpsPayout', () => {
  test('승자는 원금+0.95배 순수익을 받고, 하우스는 0.05배를 가져간다', () => {
    // 원금 1,000,000 -> 순수익 950,000 -> 승자 지급액 1,950,000 / 하우스 50,000
    const { winnerPayout, housePayout } = calculateRpsPayout(1_000_000);
    expect(winnerPayout).toBe(1_950_000);
    expect(housePayout).toBe(50_000);
  });

  test('승자 지급액 + 하우스 몫 = 베팅금의 2배 (돈이 새거나 생기지 않는다)', () => {
    for (const betAmount of [100_000, 250_000, 1_000_001, 3_333_333]) {
      const { winnerPayout, housePayout } = calculateRpsPayout(betAmount);
      expect(winnerPayout + housePayout).toBe(betAmount * 2);
    }
  });

  test('소수점이 생기는 베팅금은 내림 처리한다', () => {
    // 100,001 * 0.95 = 95,000.95 -> floor로 95,000
    const { winnerPayout, housePayout } = calculateRpsPayout(100_001);
    expect(winnerPayout).toBe(100_001 + 95_000);
    expect(housePayout).toBe(100_001 - 95_000);
  });

  test('RPS_WINNER_PROFIT_RATE 상수가 0.95인지 확인 (스펙 고정값)', () => {
    expect(RPS_WINNER_PROFIT_RATE).toBe(0.95);
  });
});

describe('validateOpponent', () => {
  test('정상적인 사람을 상대로 지목하면 통과한다', () => {
    expect(() =>
      validateOpponent('challenger-1', { id: 'opponent-1', bot: false })
    ).not.toThrow();
  });

  test('자기 자신을 지목하면 거부한다', () => {
    expect(() =>
      validateOpponent('challenger-1', { id: 'challenger-1', bot: false })
    ).toThrow(SelfChallengeError);
  });

  test('봇을 지목하면 거부한다', () => {
    expect(() =>
      validateOpponent('challenger-1', { id: 'some-bot', bot: true })
    ).toThrow(BotChallengeError);
  });
});
