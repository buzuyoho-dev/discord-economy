import { describe, expect, test } from 'vitest';
import { LOTTERY_MAX_NUMBER, LOTTERY_MIN_NUMBER } from '../../src/services/lottery';
import { cryptoPickNumber } from '../../src/services/lotteryDraw';

describe('cryptoPickNumber - 균등분포 검증', () => {
  test(
    '10,000회 시뮬레이션 시 1~20 각 숫자가 고르게(기대값 500 근처) 나온다',
    () => {
      const TRIALS = 10_000;
      const counts = new Map<number, number>();
      for (let n = LOTTERY_MIN_NUMBER; n <= LOTTERY_MAX_NUMBER; n++) counts.set(n, 0);

      for (let i = 0; i < TRIALS; i++) {
        const picked = cryptoPickNumber();
        expect(picked).toBeGreaterThanOrEqual(LOTTERY_MIN_NUMBER);
        expect(picked).toBeLessThanOrEqual(LOTTERY_MAX_NUMBER);
        counts.set(picked, (counts.get(picked) ?? 0) + 1);
      }

      const expected = TRIALS / (LOTTERY_MAX_NUMBER - LOTTERY_MIN_NUMBER + 1); // 500

      console.log(`\n[복권 난수 빈도표] ${TRIALS}회 시뮬레이션 (숫자: 횟수)`);
      for (let n = LOTTERY_MIN_NUMBER; n <= LOTTERY_MAX_NUMBER; n++) {
        console.log(`  ${String(n).padStart(2, ' ')}: ${counts.get(n)}`);
      }

      // 모든 숫자가 최소 한 번은 나와야 한다 (특정 구간에만 쏠리는 버그가 있다면 여기서 걸린다)
      for (let n = LOTTERY_MIN_NUMBER; n <= LOTTERY_MAX_NUMBER; n++) {
        expect(counts.get(n)).toBeGreaterThan(0);
      }

      // 기대값(500) ±150 이내 (약 ±6.9 표준편차) — 우연히 실패할 확률은 사실상 0에 가깝고,
      // 실제 편향 버그(예: 특정 6개 구간에만 쏠림)는 이 범위를 크게 벗어난다.
      for (let n = LOTTERY_MIN_NUMBER; n <= LOTTERY_MAX_NUMBER; n++) {
        const count = counts.get(n) ?? 0;
        expect(count).toBeGreaterThanOrEqual(expected - 150);
        expect(count).toBeLessThanOrEqual(expected + 150);
      }
    },
    30_000
  );
});
