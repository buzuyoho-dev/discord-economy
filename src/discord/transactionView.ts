// 💡 이 파일은 Transaction(거래 기록) 한 건을 사람이 읽기 좋은 한 줄짜리 텍스트로
// 바꿔주는 역할만 한다. /잔액과 /포인트내역이 똑같은 표시 형식을 공유하기 위해 여기 모아뒀다.

// 💡 TransactionType(enum 값)을 한글 라벨로 바꿔주는 표. 새 타입이 추가됐는데 여기 없으면
// formatTransactionLine이 원래 영문 타입명을 그대로 보여준다(에러는 안 남).
export const TRANSACTION_TYPE_LABELS: Record<string, string> = {
  INITIAL: '시작 지급',
  ATTENDANCE: '출석',
  BET: '베팅',
  TRANSFER: '양도',
  LOAN: '대출',
  TAX: '세금',
  REBATE: '환급',
  GAMBLE_WIN: '도박 승리',
  GAMBLE_LOSE: '도박 패배',
  ADMIN_GRANT: '관리자 지급',
  GAMBLE_ROLLBACK: '도박 롤백',
  ADMIN_RESET: '관리자 초기화',
  GAMBLE_EXTRA_PURCHASE: '도박 추가횟수 구매',
  LOTTERY_PURCHASE: '복권 구매',
  LOTTERY_WIN: '복권 당첨',
  LOTTERY_TAX: '복권 세금',
  SETTLEMENT_CORRECTION: '정산 정정',
  BLACKJACK_BET: '블랙잭 베팅',
  BLACKJACK_WIN: '블랙잭 승리',
  BLACKJACK_LOSE: '블랙잭 패배',
  BLACKJACK_PUSH: '블랙잭 무승부',
  RPS_BET: '가위바위보 베팅',
  RPS_WIN: '가위바위보 승리',
  RPS_LOSE: '가위바위보 패배',
  RPS_VOID: '가위바위보 무효',
  MINIGAME_PLAY_GRANT: '미니게임 횟수 지급',
};

export interface TransactionLike {
  type: string;
  amount: number;
  balanceAfter: number;
  description: string | null;
  createdAt: Date;
}

// 💡 거래 한 건을 "`날짜` 종류 +금액 (잔액 N) - 설명" 형태의 한 줄로 만든다.
export function formatTransactionLine(tx: TransactionLike): string {
  const sign = tx.amount >= 0 ? '+' : ''; // 💡 음수는 이미 "-"가 붙어있어서 양수일 때만 "+" 추가
  const date = tx.createdAt.toISOString().slice(0, 19).replace('T', ' ');
  const label = TRANSACTION_TYPE_LABELS[tx.type] ?? tx.type;
  const desc = tx.description ? ` - ${tx.description}` : '';
  return `\`${date}\` ${label} ${sign}${tx.amount.toLocaleString()} (잔액 ${tx.balanceAfter.toLocaleString()})${desc}`;
}

// 💡 여러 유저의 거래가 섞여서 나올 때(예: /포인트내역에서 특정 유저를 지정하지 않은 경우)
// 누구의 거래인지 알 수 있게 맨 앞에 유저 멘션을 붙인 버전.
export function formatTransactionLineWithUser(tx: TransactionLike & { userId: string }): string {
  return `<@${tx.userId}> ${formatTransactionLine(tx)}`;
}
