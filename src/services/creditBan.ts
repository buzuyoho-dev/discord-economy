import { prisma } from '../db/client';

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const CREDIT_BAN_THRESHOLD_DAYS = 10;
const CREDIT_BAN_DURATION_DAYS = 7;

export class CreditBannedError extends Error {}

export async function isCreditBanned(userId: string, now: Date = new Date()): Promise<boolean> {
  const loans = await prisma.loan.findMany({ where: { borrowerId: userId } });

  return loans.some((loan) => {
    if (!loan.dueAt) {
      return false; // 아직 실행되지 않은(PENDING/DECLINED) 요청은 연체 대상이 아니다
    }
    const banStart = loan.dueAt.getTime() + CREDIT_BAN_THRESHOLD_DAYS * ONE_DAY_MS;
    const banEnd = banStart + CREDIT_BAN_DURATION_DAYS * ONE_DAY_MS;
    return now.getTime() >= banStart && now.getTime() < banEnd;
  });
}
