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
export class InvalidDueDateError extends Error {}

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

export async function createLoan(params: {
  lenderId: string;
  borrowerId: string;
  borrowerIsBot?: boolean;
  principal: number;
  dueAt?: Date;
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
  // 💡 봇 계정에게는 대출해줄 수 없다 - getOrCreateUser를 부르기 전에 먼저 걸러낸다.
  assertNotBotTarget(params.borrowerIsBot, params.borrowerId);

  const now = params.now ?? new Date();
  if (params.dueAt && params.dueAt.getTime() <= now.getTime()) {
    throw new InvalidDueDateError('dueAt must be in the future');
  }
  if (await isCreditBanned(params.borrowerId, now)) {
    throw new CreditBannedError(`${params.borrowerId} is credit banned`);
  }
  const dueAt = params.dueAt ?? new Date(now.getTime() + DEFAULT_DUE_DAYS * ONE_DAY_MS);

  await getOrCreateUser(params.lenderId);
  await getOrCreateUser(params.borrowerId);

  const fee = Math.floor(params.principal * LOAN_ORIGINATION_FEE_RATE);
  const netToBorrower = params.principal - fee;

  return prisma.$transaction(async (tx) => {
    await applyTransaction(tx, {
      discordId: params.lenderId,
      type: TransactionType.LOAN,
      amount: -params.principal,
      description: `대출 실행: ${params.borrowerId}에게`,
      occurredAt: now,
    });

    await applyTransaction(tx, {
      discordId: params.borrowerId,
      type: TransactionType.LOAN,
      amount: netToBorrower,
      description: `대출 수령: ${params.lenderId}으로부터 (개설 수수료 2% 제외)`,
      occurredAt: now,
    });

    if (fee > 0) {
      await applyHouseTransaction(tx, {
        type: TransactionType.LOAN,
        amount: fee,
        description: `대출 개설 수수료: ${params.lenderId} → ${params.borrowerId}`,
        occurredAt: now,
      });
    }

    return tx.loan.create({
      data: {
        lenderId: params.lenderId,
        borrowerId: params.borrowerId,
        principal: params.principal,
        dueAt,
      },
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
