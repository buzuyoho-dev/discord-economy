import { CreditBannedError } from '../services/creditBan';
import { InsufficientBalanceError } from '../services/ledger';
import {
  CannotLoanToSelfError,
  InvalidDueDateError,
  InvalidLoanAmountError,
  LoanAmountTooLargeError,
  LoanNotActiveError,
  LoanNotFoundError,
  NotBorrowerError,
} from '../services/loan';

export function loanErrorMessage(error: unknown): string | null {
  if (error instanceof InvalidLoanAmountError) {
    return '금액은 1 이상의 정수여야 합니다.';
  }
  if (error instanceof LoanAmountTooLargeError) {
    return '1회 대출 한도(3,000만 포인트)를 초과합니다.';
  }
  if (error instanceof CannotLoanToSelfError) {
    return '본인에게는 대출을 개설할 수 없습니다.';
  }
  if (error instanceof InvalidDueDateError) {
    return '상환일은 현재 시점보다 미래여야 합니다.';
  }
  if (error instanceof CreditBannedError) {
    return '신용불량 상태라 신규 대출을 개설할 수 없습니다.';
  }
  if (error instanceof LoanNotFoundError) {
    return '해당 대출을 찾을 수 없습니다.';
  }
  if (error instanceof LoanNotActiveError) {
    return '이미 상환된 대출입니다.';
  }
  if (error instanceof NotBorrowerError) {
    return '차입자만 대출을 상환할 수 있습니다.';
  }
  if (error instanceof InsufficientBalanceError) {
    return '잔액 부족으로 처리할 수 없습니다.';
  }
  return null;
}
