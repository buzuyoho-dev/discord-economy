import { TransactionType } from '@prisma/client';
import { prisma } from '../db/client';
import { isSameKstDay } from './kst';
import { applyTransaction, getOrCreateUser } from './ledger';

export { isSameKstDay } from './kst';
export const ATTENDANCE_REWARD = 1_000_000;

export class AlreadyCheckedInError extends Error {
  constructor(discordId: string) {
    super(`${discordId} already checked in today (KST)`);
    this.name = 'AlreadyCheckedInError';
  }
}

export async function checkIn(discordId: string, now: Date = new Date()) {
  await getOrCreateUser(discordId);

  return prisma.$transaction(async (tx) => {
    const lastAttendance = await tx.transaction.findFirst({
      where: { userId: discordId, type: TransactionType.ATTENDANCE },
      orderBy: { createdAt: 'desc' },
    });

    if (lastAttendance && isSameKstDay(lastAttendance.createdAt, now)) {
      throw new AlreadyCheckedInError(discordId);
    }

    return applyTransaction(tx, {
      discordId,
      type: TransactionType.ATTENDANCE,
      amount: ATTENDANCE_REWARD,
      description: '출석체크 보상',
      occurredAt: now,
    });
  });
}
