import {
  AlreadyJoinedError,
  BetNotClosedError,
  BetNotFoundError,
  BetNotOpenError,
  DuplicateOptionLabelError,
  InvalidBetOptionsError,
  InvalidOptionError,
  NotBetCreatorError,
} from '../services/mode1Bet';
import { InsufficientBalanceError } from '../services/ledger';
import { formatParticipantsLine } from '../discord/participants';

const STATUS_LABELS: Record<string, string> = {
  OPEN: '참가 가능',
  CLOSED: '마감 (정산 대기)',
  SETTLED: '정산 완료',
  VOID: '무효 처리됨',
  VOIDED: '무효 처리됨',
};

export function buildBetAnnouncement(
  bet: {
    id: number;
    title: string;
    amount: number | null;
    status: string;
    options: { label: string }[];
  },
  participantUserIds: string[]
): string {
  const optionsText = bet.options.map((option) => `- ${option.label}`).join('\n');
  const amountLine =
    bet.amount === null
      ? '참가 금액: 자유 (진 쪽 총액을 이긴 쪽이 베팅액 비율로 나눠 가짐)'
      : `참가 금액: ${bet.amount.toLocaleString()} 포인트 (전원 동일, 레거시)`;
  const joinHint =
    bet.amount === null
      ? '아래 버튼으로 참가하세요 (금액은 자유, 선택은 비공개):'
      : '아래 버튼으로 참가하세요 (선택은 비공개):';

  return [
    `**[베팅 #${bet.id}] ${bet.title}**`,
    amountLine,
    `상태: ${STATUS_LABELS[bet.status] ?? bet.status}`,
    formatParticipantsLine(participantUserIds),
    '',
    joinHint,
    optionsText,
  ].join('\n');
}

export function mode1BetErrorMessage(error: unknown): string | null {
  if (error instanceof InvalidBetOptionsError) {
    return '옵션은 정확히 2개여야 하고, 참가 금액은 1 이상의 정수여야 합니다.';
  }
  if (error instanceof DuplicateOptionLabelError) {
    return '옵션 이름이 서로 겹칩니다 (대소문자/공백 무시). 다른 이름으로 다시 시도해주세요.';
  }
  if (error instanceof BetNotFoundError) {
    return '해당 베팅을 찾을 수 없습니다.';
  }
  if (error instanceof BetNotOpenError) {
    return '이 베팅은 더 이상 참가를 받지 않습니다.';
  }
  if (error instanceof InvalidOptionError) {
    return '유효하지 않은 선택지입니다.';
  }
  if (error instanceof AlreadyJoinedError) {
    return '이미 이 베팅에 참가했습니다.';
  }
  if (error instanceof NotBetCreatorError) {
    return '베팅 개최자만 이 명령을 사용할 수 있습니다.';
  }
  if (error instanceof BetNotClosedError) {
    return '정산하려면 먼저 `/베팅마감`으로 참가를 마감해야 합니다.';
  }
  if (error instanceof InsufficientBalanceError) {
    return '포인트가 부족합니다.';
  }
  return null;
}
