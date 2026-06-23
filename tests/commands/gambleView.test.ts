import { describe, expect, test } from 'vitest';
import { gambleErrorMessage } from '../../src/commands/gambleView';
import { DailyGambleLimitExceededError } from '../../src/services/gamble';

describe('gambleErrorMessage - 일일 한도 초과', () => {
  test('기본 한도(2회) 초과 시 메시지에 2회로 표시한다', () => {
    const message = gambleErrorMessage(new DailyGambleLimitExceededError('u1', 2));
    expect(message).toContain('2회');
  });

  test('도박추가 구매로 늘어난 한도(3회) 초과 시 메시지에 3회로 표시한다', () => {
    const message = gambleErrorMessage(new DailyGambleLimitExceededError('u1', 3));
    expect(message).toContain('3회');
  });
});
