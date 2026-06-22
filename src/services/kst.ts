const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

export function isSameKstDay(a: Date, b: Date): boolean {
  return toKstDateString(a) === toKstDateString(b);
}

function toKstDateString(date: Date): string {
  return new Date(date.getTime() + KST_OFFSET_MS).toISOString().slice(0, 10);
}
