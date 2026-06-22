import { describe, expect, test } from 'vitest';
import { formatParticipantsLine } from '../../src/discord/participants';

describe('formatParticipantsLine', () => {
  test('참가자가 없으면 0명과 없음을 표시한다', () => {
    expect(formatParticipantsLine([])).toBe('참가자 (0명): 없음');
  });

  test('참가자가 있으면 인원수와 멘션 목록을 표시한다', () => {
    expect(formatParticipantsLine(['u1', 'u2', 'u3'])).toBe(
      '참가자 (3명): <@u1> <@u2> <@u3>'
    );
  });

  test('참가 순서를 그대로 유지한다', () => {
    expect(formatParticipantsLine(['late', 'early'])).toBe('참가자 (2명): <@late> <@early>');
  });
});
