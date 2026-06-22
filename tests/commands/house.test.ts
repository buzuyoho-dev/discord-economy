import { describe, expect, test } from 'vitest';
import { formatHouseStatusMessage } from '../../src/commands/house';

describe('formatHouseStatusMessage', () => {
  test('잔액과 전체 경제 점유율(%)을 예시 형식대로 보여준다', () => {
    const message = formatHouseStatusMessage(3_200_000, 0.185);

    expect(message).toBe('🏦 하우스 현재 잔액: 3,200,000 포인트 (전체 경제의 18.5%)');
  });

  test('점유율은 소수점 첫째 자리까지 반올림한다', () => {
    const message = formatHouseStatusMessage(2_000_000, 0.1846);

    expect(message).toBe('🏦 하우스 현재 잔액: 2,000,000 포인트 (전체 경제의 18.5%)');
  });

  test('점유율 0%도 정상적으로 표시한다', () => {
    const message = formatHouseStatusMessage(0, 0);

    expect(message).toBe('🏦 하우스 현재 잔액: 0 포인트 (전체 경제의 0.0%)');
  });
});
