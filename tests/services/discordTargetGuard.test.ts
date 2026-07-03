import { describe, expect, test } from 'vitest';
import { assertNotBotTarget, BotTargetError } from '../../src/services/discordTargetGuard';

describe('assertNotBotTarget', () => {
  test('봇이 아니면 통과한다', () => {
    expect(() => assertNotBotTarget(false, 'user-1')).not.toThrow();
  });

  test('isBot이 undefined면(값을 모르면) 안전하게 통과한다', () => {
    expect(() => assertNotBotTarget(undefined, 'user-1')).not.toThrow();
  });

  test('봇이면 거부한다', () => {
    expect(() => assertNotBotTarget(true, 'bot-1')).toThrow(BotTargetError);
  });
});
