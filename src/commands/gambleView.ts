import { DailyGambleLimitExceededError, InsufficientBalanceForGambleError } from '../services/gamble';

export function gambleErrorMessage(error: unknown): string | null {
  if (error instanceof DailyGambleLimitExceededError) {
    return `오늘 도박 횟수(${error.limit}회)를 모두 사용했습니다. 내일 다시 시도해주세요.`;
  }
  if (error instanceof InsufficientBalanceForGambleError) {
    return '포인트가 부족하여 도박할 수 없습니다.';
  }
  return null;
}
