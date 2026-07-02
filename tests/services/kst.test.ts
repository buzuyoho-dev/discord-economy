import { describe, expect, test } from 'vitest';
import { kstMidnightUtc } from '../../src/services/kst';

describe('kstMidnightUtc', () => {
  test('정오 이전 시각은 같은 날짜(KST)의 자정(UTC)을 반환한다', () => {
    const result = kstMidnightUtc(new Date('2026-07-02T02:00:00.000Z')); // KST 11:00
    expect(result.toISOString()).toBe('2026-07-02T00:00:00.000Z');
  });

  test('정확히 KST 낮 12시 00분 00초에도 같은 날짜(오늘)의 자정을 반환한다 - 추첨 잡이 이 순간에 실행되므로 중요', () => {
    const result = kstMidnightUtc(new Date('2026-07-02T03:00:00.000Z')); // KST 정확히 12:00:00
    expect(result.toISOString()).toBe('2026-07-02T00:00:00.000Z');
  });

  test('정오 이후 시각도 정오/자정과 무관하게 그 날짜(KST) 자체의 자정을 반환한다 - 분기가 없다', () => {
    const result = kstMidnightUtc(new Date('2026-07-02T10:00:00.000Z')); // KST 19:00
    expect(result.toISOString()).toBe('2026-07-02T00:00:00.000Z');
  });
});
