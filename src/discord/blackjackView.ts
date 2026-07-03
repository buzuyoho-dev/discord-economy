// 💡 이 파일은 블랙잭 게임 상태(카드/결과)를 디스코드 임베드(꾸며진 메시지 박스)로
// "그림"으로 바꿔주는 역할만 한다. 실제 게임 규칙이나 DB 처리는 전혀 하지 않는다.
import { EmbedBuilder } from 'discord.js';
import {
  BetTooLargeError,
  BetTooSmallError,
  type BlackjackOutcome,
  type Card,
  calculateHandValue,
  MIN_BET_AMOUNT,
} from '../services/blackjack';
import { DailyPlayLimitExceededError, MAX_PLAYS_PER_DAY } from '../services/blackjackGame';
import { InsufficientBalanceError } from '../services/ledger';

// 💡 카드 한 장을 "10♥"처럼 짧은 글자로 표현한다.
function formatCard(card: Card): string {
  return `${card.rank}${card.suit}`;
}

// 💡 손에 든 카드 전체 + 현재 합계를 "10♥ A♠ (21)" 형태로 표현한다.
function formatHand(hand: Card[]): string {
  return `${hand.map(formatCard).join(' ')}  (합계: ${calculateHandValue(hand)})`;
}

// 💡 아직 게임이 안 끝났을 때 딜러 카드는 한 장만 보여주고 나머지는 뒷면(🂠)으로 가린다.
function formatDealerHandHidden(hand: Card[]): string {
  const [visible, ...hidden] = hand;
  return `${formatCard(visible)} ${hidden.map(() => '🂠').join(' ')}`;
}

// 💡 아직 진행 중인 판(히트/스탠드 선택 대기 중)을 보여주는 임베드.
export function buildInProgressEmbed(params: {
  playerHand: Card[];
  dealerHand: Card[];
  betAmount: number;
}): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle('🂡 블랙잭')
    .setColor(0x2b6cb0)
    .addFields(
      { name: '내 패', value: formatHand(params.playerHand) },
      { name: '딜러 패', value: formatDealerHandHidden(params.dealerHand) },
      { name: '베팅금', value: `${params.betAmount.toLocaleString()}P` }
    )
    .setFooter({ text: '아래 버튼으로 선택하세요 (60초 내 미선택 시 자동 스탠드)' });
}

const OUTCOME_LABELS: Record<BlackjackOutcome, string> = {
  WIN: '🎉 승리!',
  NATURAL_WIN: '🎉 자연블랙잭 승리! (1.5배)',
  LOSE: '😢 패배',
  PUSH: '🤝 무승부 (베팅금 환급)',
};

const OUTCOME_COLORS: Record<BlackjackOutcome, number> = {
  WIN: 0x38a169,
  NATURAL_WIN: 0x38a169,
  LOSE: 0xe53e3e,
  PUSH: 0xa0aec0,
};

// 💡 게임이 끝났을 때(승/패/무승부 확정) 보여주는 최종 결과 임베드.
export function buildResultEmbed(params: {
  playerHand: Card[];
  dealerHand: Card[];
  betAmount: number;
  outcome: BlackjackOutcome;
  payout: number;
  balanceAfter: number;
  playsRemaining: number;
  autoStand: boolean;
}): EmbedBuilder {
  // 💡 최종 손익 = 정산으로 받은 돈 - 원래 베팅금 (얼마나 벌었는지/잃었는지)
  const netChange = params.payout - params.betAmount;
  const netLine = netChange >= 0 ? `+${netChange.toLocaleString()}P` : `${netChange.toLocaleString()}P`;

  const embed = new EmbedBuilder()
    .setTitle(`🂡 블랙잭 - ${OUTCOME_LABELS[params.outcome]}`)
    .setColor(OUTCOME_COLORS[params.outcome])
    .addFields(
      { name: '내 패', value: formatHand(params.playerHand) },
      { name: '딜러 패', value: formatHand(params.dealerHand) },
      { name: '손익', value: `${netLine} (현재 잔액: ${params.balanceAfter.toLocaleString()}P)` },
      { name: '오늘 남은 횟수', value: `${params.playsRemaining}/${MAX_PLAYS_PER_DAY}` }
    );

  if (params.autoStand) {
    embed.setFooter({ text: '⏱️ 60초 동안 응답이 없어 자동으로 스탠드 처리되었습니다.' });
  }

  return embed;
}

// 💡 에러 종류에 맞는 한글 안내 문구를 돌려준다. 모르는 에러면 null을 줘서, 호출한 쪽이
// "이건 내가 처리할 수 없는 에러구나"하고 그대로 다시 던지게(throw) 한다.
export function blackjackErrorMessage(error: unknown): string | null {
  if (error instanceof BetTooSmallError) {
    return `최소 베팅금은 ${MIN_BET_AMOUNT.toLocaleString()}P입니다.`;
  }
  if (error instanceof BetTooLargeError) {
    return '베팅금은 보유 포인트의 25%를 넘을 수 없습니다.';
  }
  if (error instanceof DailyPlayLimitExceededError) {
    return `블랙잭은 하루 최대 ${MAX_PLAYS_PER_DAY}회까지만 플레이할 수 있습니다. 내일 다시 시도해주세요.`;
  }
  if (error instanceof InsufficientBalanceError) {
    return '포인트가 부족합니다.';
  }
  return null;
}
