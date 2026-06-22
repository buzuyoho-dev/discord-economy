import {
  AlreadyJoinedError,
  BetNotClosedError,
  BetNotFoundError,
  BetNotOpenError,
  InvalidBetOptionsError,
  NotBetCreatorError,
} from '../services/betShared';
import { InsufficientBalanceError } from '../services/ledger';
import { Mode2BetLimitExceededError } from '../services/mode2Bet';
import { formatParticipantsLine } from '../discord/participants';

const STATUS_LABELS: Record<string, string> = {
  OPEN: '참가 가능',
  CLOSED: '마감 (정산 대기)',
  SETTLED: '정산 완료',
};

export function buildMode2BetAnnouncement(
  bet: {
    id: number;
    title: string;
    status: string;
    sideALabel: string;
    sideBLabel: string;
  },
  participantUserIds: string[]
): string {
  return [
    `**[모드2 베팅 #${bet.id}] ${bet.title}**`,
    `상태: ${STATUS_LABELS[bet.status] ?? bet.status}`,
    formatParticipantsLine(participantUserIds),
    '',
    '아래 버튼으로 참가하세요 (금액은 자유, 선택은 비공개):',
    `- ${bet.sideALabel}`,
    `- ${bet.sideBLabel}`,
  ].join('\n');
}

export function mode2BetErrorMessage(error: unknown): string | null {
  if (error instanceof InvalidBetOptionsError) {
    return '입력값이 올바르지 않습니다 (옵션 이름 중복이거나 금액이 0 이하).';
  }
  if (error instanceof BetNotFoundError) {
    return '해당 베팅을 찾을 수 없습니다.';
  }
  if (error instanceof BetNotOpenError) {
    return '이 베팅은 더 이상 참가를 받지 않습니다.';
  }
  if (error instanceof AlreadyJoinedError) {
    return '이미 이 베팅에 참가했습니다.';
  }
  if (error instanceof NotBetCreatorError) {
    return '베팅 개최자만 이 명령을 사용할 수 있습니다.';
  }
  if (error instanceof BetNotClosedError) {
    return '정산하려면 먼저 `/모드2베팅마감`으로 참가를 마감해야 합니다.';
  }
  if (error instanceof Mode2BetLimitExceededError) {
    return '현재 하우스 잔액 기준 베팅 한도(잔액의 10%)를 초과합니다. 금액을 줄여주세요.';
  }
  if (error instanceof InsufficientBalanceError) {
    return '포인트가 부족합니다.';
  }
  return null;
}
