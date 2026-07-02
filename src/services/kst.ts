const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

export function isSameKstDay(a: Date, b: Date): boolean {
  return toKstDateString(a) === toKstDateString(b);
}

function toKstDateString(date: Date): string {
  return new Date(date.getTime() + KST_OFFSET_MS).toISOString().slice(0, 10);
}

// 주어진 시각이 속한 KST 날짜의 자정을 UTC로 반환한다 (정오 분기 없음 - 순수하게 "그 날짜"만 계산).
export function kstMidnightUtc(date: Date): Date {
  return new Date(`${toKstDateString(date)}T00:00:00.000Z`);
}
