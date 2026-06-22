import { prisma } from '../db/client';

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const CREDIT_BAN_THRESHOLD_DAYS = 10;
const CREDIT_BAN_DURATION_DAYS = 7;

export class CreditBannedError extends Error {}

export async function isCreditBanned(userId: string, now: Date = new Date()): Promise<boolean> {
  const loans = await prisma.loan.findMany({ where: { borrowerId: userId } });

  return loans.some((loan) => {
    const banStart = loan.dueAt.getTime() + CREDIT_BAN_THRESHOLD_DAYS * ONE_DAY_MS;
    const banEnd = banStart + CREDIT_BAN_DURATION_DAYS * ONE_DAY_MS;
    return now.getTime() >= banStart && now.getTime() < banEnd;
  });
}
