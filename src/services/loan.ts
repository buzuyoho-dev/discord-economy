import { TransactionType } from '@prisma/client';
import { prisma } from '../db/client';
import { CreditBannedError, isCreditBanned } from './creditBan';
import { assertNotBotTarget } from './discordTargetGuard';
import { applyHouseTransaction } from './house';
import { applyTransaction, getOrCreateUser } from './ledger';

export const MAX_LOAN_AMOUNT = 30_000_000;
export const DEFAULT_DUE_DAYS = 7;

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
export const LOAN_ORIGINATION_FEE_RATE = 0.02;
const DAILY_INTEREST_RATE = 0.05;
const MAX_INTEREST_DAYS = 10;

export class InvalidLoanAmountError extends Error {}
export class LoanAmountTooLargeError extends Error {}
export class CannotLoanToSelfError extends Error {}
export class LoanNotFoundError extends Error {}
export class LoanNotActiveError extends Error {}
export class NotBorrowerError extends Error {}
export class NotLenderError extends Error {}
export class InvalidDueDateError extends Error {}
export class InvalidDueDaysError extends Error {}
export class LoanNotPendingError extends Error {}
export class LoanRequestExpiredError extends Error {}

export const LOAN_REQUEST_EXPIRY_HOURS = 24;

export function calculateOverdueDays(dueAt: Date, now: Date): number {
  if (now.getTime() <= dueAt.getTime()) {
    return 0;
  }
  const elapsedDays = Math.floor((now.getTime() - dueAt.getTime()) / ONE_DAY_MS);
  return Math.min(elapsedDays, MAX_INTEREST_DAYS);
}

export function calculateInterest(principal: number, overdueDays: number): number {
  return Math.floor(principal * DAILY_INTEREST_RATE * overdueDays);
}

// 즉시 이체 없이 PENDING 상태 요청만 생성한다. 실제 포인트 이동은 lender가
// 수락할 때(acceptLoan) 일어난다.
export async function requestLoan(params: {
  lenderId: string;
  borrowerId: string;
  lenderIsBot?: boolean;
  principal: number;
  dueDays?: number;
  now?: Date;
}) {
  if (!Number.isInteger(params.principal) || params.principal <= 0) {
    throw new InvalidLoanAmountError('principal must be a positive integer');
  }
  if (params.principal > MAX_LOAN_AMOUNT) {
    throw new LoanAmountTooLargeError(
      `principal ${params.principal} exceeds the max loan amount ${MAX_LOAN_AMOUNT}`
    );
  }
  if (params.lenderId === params.borrowerId) {
    throw new CannotLoanToSelfError(`${params.lenderId} cannot loan to self`);
  }
  // 💡 봇 계정에게는 대출을 요청할 수 없다 (상대방 파라미터 = lender).
  assertNotBotTarget(params.lenderIsBot, params.lenderId);

  const dueDays = params.dueDays ?? DEFAULT_DUE_DAYS;
  if (!Number.isInteger(dueDays) || dueDays <= 0) {
    throw new InvalidDueDaysError('dueDays must be a positive integer');
  }

  const now = params.now ?? new Date();
  if (await isCreditBanned(params.borrowerId, now)) {
    throw new CreditBannedError(`${params.borrowerId} is credit banned`);
  }

  return prisma.loan.create({
    data: {
      lenderId: params.lenderId,
      borrowerId: params.borrowerId,
      principal: params.principal,
      dueDays,
      status: 'PENDING',
      createdAt: now,
    },
  });
}

// lender가 대출 요청을 수락했을 때 실제 이체를 실행한다 (예전 createLoan의 이체 로직을
// 그대로 옮겨온 것). 요청 시각(createdAt)으로부터 24시간이 지났으면 만료로 거부한다 -
// isCreditBanned와 같은 방식으로 cron 없이 호출되는 순간 계산한다.
export async function acceptLoan(params: { loanId: number; acceptedBy: string; now?: Date }) {
  const now = params.now ?? new Date();

  return prisma.$transaction(async (tx) => {
    const loan = await tx.loan.findUnique({ where: { id: params.loanId } });
    if (!loan) {
      throw new LoanNotFoundError(`loan ${params.loanId} not found`);
    }
    if (loan.lenderId !== params.acceptedBy) {
      throw new NotLenderError(`${params.acceptedBy} is not the lender of loan ${params.loanId}`);
    }
    if (loan.status !== 'PENDING') {
      throw new LoanNotPendingError(`loan ${params.loanId} is not pending`);
    }
    if (!loan.dueDays) {
      throw new Error(`loan ${params.loanId} is PENDING but has no dueDays`);
    }

    const expiresAt = loan.createdAt.getTime() + LOAN_REQUEST_EXPIRY_HOURS * 60 * 60 * 1000;
    if (now.getTime() >= expiresAt) {
      throw new LoanRequestExpiredError(`loan request ${params.loanId} expired`);
    }

    await getOrCreateUser(loan.lenderId);
    await getOrCreateUser(loan.borrowerId);

    const fee = Math.floor(loan.principal * LOAN_ORIGINATION_FEE_RATE);
    const netToBorrower = loan.principal - fee;
    const dueAt = new Date(now.getTime() + loan.dueDays * ONE_DAY_MS);

    await applyTransaction(tx, {
      discordId: loan.lenderId,
      type: TransactionType.LOAN,
      amount: -loan.principal,
      description: `대출 실행: ${loan.borrowerId}에게`,
      occurredAt: now,
    });

    await applyTransaction(tx, {
      discordId: loan.borrowerId,
      type: TransactionType.LOAN,
      amount: netToBorrower,
      description: `대출 수령: ${loan.lenderId}으로부터 (개설 수수료 2% 제외)`,
      occurredAt: now,
    });

    if (fee > 0) {
      await applyHouseTransaction(tx, {
        type: TransactionType.LOAN,
        amount: fee,
        description: `대출 개설 수수료: ${loan.lenderId} → ${loan.borrowerId}`,
        occurredAt: now,
      });
    }

    return tx.loan.update({
      where: { id: loan.id },
      data: { status: 'ACTIVE', dueAt },
    });
  });
}

export async function declineLoan(params: { loanId: number; declinedBy: string }) {
  return prisma.$transaction(async (tx) => {
    const loan = await tx.loan.findUnique({ where: { id: params.loanId } });
    if (!loan) {
      throw new LoanNotFoundError(`loan ${params.loanId} not found`);
    }
    if (loan.lenderId !== params.declinedBy) {
      throw new NotLenderError(`${params.declinedBy} is not the lender of loan ${params.loanId}`);
    }
    if (loan.status !== 'PENDING') {
      throw new LoanNotPendingError(`loan ${params.loanId} is not pending`);
    }

    return tx.loan.update({
      where: { id: loan.id },
      data: { status: 'DECLINED' },
    });
  });
}

export async function repayLoan(params: { loanId: number; repaidBy: string; now?: Date }) {
  const now = params.now ?? new Date();

  return prisma.$transaction(async (tx) => {
    const loan = await tx.loan.findUnique({ where: { id: params.loanId } });
    if (!loan) {
      throw new LoanNotFoundError(`loan ${params.loanId} not found`);
    }
    if (loan.borrowerId !== params.repaidBy) {
      throw new NotBorrowerError(`${params.repaidBy} is not the borrower of loan ${params.loanId}`);
    }
    if (loan.status !== 'ACTIVE') {
      throw new LoanNotActiveError(`loan ${params.loanId} is not active`);
    }
    if (!loan.dueAt) {
      throw new Error(`loan ${params.loanId} is ACTIVE but has no dueAt`);
    }

    const overdueDays = calculateOverdueDays(loan.dueAt, now);
    const interest = calculateInterest(loan.principal, overdueDays);
    const totalRepaid = loan.principal + interest;

    await applyTransaction(tx, {
      discordId: loan.borrowerId,
      type: TransactionType.LOAN,
      amount: -totalRepaid,
      description: `대출 상환 (대출 #${loan.id}, 연체 ${overdueDays}일)`,
      occurredAt: now,
    });

    await applyTransaction(tx, {
      discordId: loan.lenderId,
      type: TransactionType.LOAN,
      amount: totalRepaid,
      description: `대출 상환 수령 (대출 #${loan.id}, 연체 ${overdueDays}일)`,
      occurredAt: now,
    });

    const updatedLoan = await tx.loan.update({
      where: { id: params.loanId },
      data: { status: 'REPAID', repaidAt: now },
    });

    return { loan: updatedLoan, interest, totalRepaid, overdueDays };
  });
}

// /내대출에서 쓰인다. lender/borrower 두 역할을 분리해서 각각 최신순으로 돌려준다.
export async function getUserLoans(userId: string) {
  const [asLender, asBorrower] = await Promise.all([
    prisma.loan.findMany({ where: { lenderId: userId }, orderBy: { createdAt: 'desc' } }),
    prisma.loan.findMany({ where: { borrowerId: userId }, orderBy: { createdAt: 'desc' } }),
  ]);
  return { asLender, asBorrower };
}
