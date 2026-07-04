import { CreditBannedError } from '../services/creditBan';
import { BotTargetError } from '../services/discordTargetGuard';
import { InsufficientBalanceError } from '../services/ledger';
import {
  CannotLoanToSelfError,
  InvalidDueDateError,
  InvalidDueDaysError,
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
  if (error instanceof BotTargetError) {
    return '봇에게는 대출을 개설할 수 없습니다.';
  }
  if (error instanceof InvalidDueDateError) {
    return '상환일은 현재 시점보다 미래여야 합니다.';
  }
  if (error instanceof InvalidDueDaysError) {
    return '상환일수는 1 이상의 정수여야 합니다.';
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

export interface MyLoansViewLoan {
  id: number;
  lenderId: string;
  borrowerId: string;
  principal: number;
  status: string;
  dueAt: Date | null;
  dueDays: number | null;
}

const STATUS_LABEL: Record<string, string> = {
  PENDING: '대기중',
  ACTIVE: '진행중',
  REPAID: '상환완료',
  DECLINED: '거절됨',
  VOIDED: '무효화됨',
};

const FINISHED_STATUSES = new Set(['REPAID', 'DECLINED', 'VOIDED']);
const RECENT_FINISHED_LOANS_LIMIT = 3;

function formatDue(loan: MyLoansViewLoan): string {
  if (loan.dueAt) {
    return loan.dueAt.toLocaleDateString('ko-KR');
  }
  // dueDays 힌트는 아직 수락될 가능성이 있는 PENDING일 때만 의미가 있다 -
  // DECLINED/VOIDED는 이미 끝났으므로 "수락 시 N일 후" 안내가 오해를 부른다.
  if (loan.status === 'PENDING' && loan.dueDays) {
    return `수락 시 ${loan.dueDays}일 후 확정`;
  }
  return '-';
}

function formatLoanEntry(
  loan: MyLoansViewLoan,
  counterpartyLabel: string,
  counterpartyId: string,
  emphasizeId: boolean
): string {
  const idText = emphasizeId ? `**대출 #${loan.id}**` : `대출 #${loan.id}`;
  const statusText = STATUS_LABEL[loan.status] ?? loan.status;
  return `${idText} · ${counterpartyLabel} <@${counterpartyId}> · ${loan.principal.toLocaleString()}P · 상환기한 ${formatDue(loan)} · ${statusText}`;
}

// 활성(ACTIVE)/finished 항목을 함께 렌더링한다. ACTIVE는 대출ID를 굵게 강조해서
// /대출상환에 쓸 ID를 바로 찾을 수 있게 하고, finished(REPAID/DECLINED/VOIDED)는
// 기본적으로 최근 N건만 보여주고 나머지는 "전체보기" 안내로 요약한다.
function formatLoanGroup(
  loans: MyLoansViewLoan[],
  counterpartyLabel: string,
  getCounterpartyId: (loan: MyLoansViewLoan) => string,
  showAll: boolean
): string {
  const active = loans.filter((l) => l.status === 'ACTIVE');
  const finished = loans.filter((l) => FINISHED_STATUSES.has(l.status));

  if (active.length === 0 && finished.length === 0) {
    return '없음';
  }

  const parts: string[] = [];
  if (active.length > 0) {
    parts.push(active.map((l) => formatLoanEntry(l, counterpartyLabel, getCounterpartyId(l), true)).join('\n'));
  }
  if (finished.length > 0) {
    const shown = showAll ? finished : finished.slice(0, RECENT_FINISHED_LOANS_LIMIT);
    parts.push(shown.map((l) => formatLoanEntry(l, counterpartyLabel, getCounterpartyId(l), false)).join('\n'));
    if (!showAll && finished.length > RECENT_FINISHED_LOANS_LIMIT) {
      parts.push(`...외 ${finished.length - RECENT_FINISHED_LOANS_LIMIT}건 더 있음 (전체보기 옵션으로 확인)`);
    }
  }
  return parts.join('\n');
}

export function formatMyLoans(params: {
  asLender: MyLoansViewLoan[];
  asBorrower: MyLoansViewLoan[];
  showAll: boolean;
}): string {
  const sentRequests = params.asLender.filter((l) => l.status === 'PENDING');
  const receivedRequests = params.asBorrower.filter((l) => l.status === 'PENDING');

  const sections: string[] = [];

  sections.push(
    [
      '📤 **내가 보낸 요청 (응답 대기중)**',
      sentRequests.length === 0
        ? '없음'
        : sentRequests.map((l) => formatLoanEntry(l, '차입자', l.borrowerId, false)).join('\n'),
    ].join('\n')
  );

  sections.push(
    [
      '📥 **내가 받은 요청 (응답 대기중)**',
      receivedRequests.length === 0
        ? '없음'
        : receivedRequests.map((l) => formatLoanEntry(l, '대출자', l.lenderId, false)).join('\n'),
    ].join('\n')
  );

  sections.push(
    [
      '💰 **내가 빌려준 대출**',
      formatLoanGroup(params.asLender, '차입자', (l) => l.borrowerId, params.showAll),
    ].join('\n')
  );

  sections.push(
    [
      '💳 **내가 빌린 대출**',
      formatLoanGroup(params.asBorrower, '대출자', (l) => l.lenderId, params.showAll),
    ].join('\n')
  );

  return sections.join('\n\n');
}
