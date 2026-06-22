import { describe, expect, test } from 'vitest';
import { prisma } from '../../src/db/client';
import {
  AlreadyCheckedInError,
  ATTENDANCE_REWARD,
  checkIn,
  isSameKstDay,
} from '../../src/services/attendance';
import { getOrCreateUser } from '../../src/services/ledger';

describe('isSameKstDay', () => {
  test('KST 자정을 넘으면 다른 날로 판정한다', () => {
    // 2026-06-21 23:30 KST == 2026-06-21 14:30 UTC
    const beforeMidnightKst = new Date('2026-06-21T14:30:00.000Z');
    // 2026-06-22 00:30 KST == 2026-06-21 15:30 UTC
    const afterMidnightKst = new Date('2026-06-21T15:30:00.000Z');

    expect(isSameKstDay(beforeMidnightKst, afterMidnightKst)).toBe(false);
  });

  test('KST 기준 같은 날이면 true를 반환한다', () => {
    const morning = new Date('2026-06-21T01:00:00.000Z'); // KST 10:00
    const evening = new Date('2026-06-21T13:00:00.000Z'); // KST 22:00
    expect(isSameKstDay(morning, evening)).toBe(true);
  });
});

describe('checkIn', () => {
  test('첫 출석체크는 보상을 지급하고 ATTENDANCE 거래를 기록한다', async () => {
    await getOrCreateUser('atd-1');

    const user = await checkIn('atd-1', new Date('2026-06-21T01:00:00.000Z'));

    expect(user.balance).toBe(10_000_000 + ATTENDANCE_REWARD);

    const transactions = await prisma.transaction.findMany({
      where: { userId: 'atd-1', type: 'ATTENDANCE' },
    });
    expect(transactions).toHaveLength(1);
    expect(transactions[0].amount).toBe(ATTENDANCE_REWARD);
  });

  test('같은 날 다시 출석체크하면 AlreadyCheckedInError를 던지고 잔액·거래 내역이 그대로 유지된다', async () => {
    await getOrCreateUser('atd-2');
    await checkIn('atd-2', new Date('2026-06-21T01:00:00.000Z'));

    await expect(checkIn('atd-2', new Date('2026-06-21T13:00:00.000Z'))).rejects.toThrow(
      AlreadyCheckedInError
    );

    const user = await prisma.user.findUniqueOrThrow({ where: { discordId: 'atd-2' } });
    expect(user.balance).toBe(10_000_000 + ATTENDANCE_REWARD);

    const transactions = await prisma.transaction.findMany({
      where: { userId: 'atd-2', type: 'ATTENDANCE' },
    });
    expect(transactions).toHaveLength(1);
  });

  test('다음 날(KST)에는 다시 출석체크할 수 있다', async () => {
    await getOrCreateUser('atd-3');
    await checkIn('atd-3', new Date('2026-06-21T01:00:00.000Z'));

    const user = await checkIn('atd-3', new Date('2026-06-22T01:00:00.000Z'));

    expect(user.balance).toBe(10_000_000 + ATTENDANCE_REWARD * 2);

    const transactions = await prisma.transaction.findMany({
      where: { userId: 'atd-3', type: 'ATTENDANCE' },
    });
    expect(transactions).toHaveLength(2);
  });
});
