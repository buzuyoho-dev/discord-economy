// 💡 이 파일은 블랙잭 카드 게임의 "규칙"만 담당해요. 디스코드나 DB는 전혀 몰라도 되고,
// 그냥 "카드 배열을 주면 결과를 계산해주는" 순수한 계산기라고 생각하면 됩니다.
// 그래서 테스트하기도 쉽고(가짜 카드만 만들어서 넣어보면 됨), 재사용하기도 쉬워요.

export type Suit = '♠' | '♥' | '♦' | '♣';
export type Rank = 'A' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | '10' | 'J' | 'Q' | 'K';

// 💡 카드 한 장 = 무늬(suit) + 숫자(rank). 예: { rank: 'A', suit: '♠' } = 스페이드 에이스
export interface Card {
  rank: Rank;
  suit: Suit;
}

// 💡 게임이 끝났을 때 나올 수 있는 4가지 결과.
// WIN(일반 승리) / LOSE(패배) / PUSH(무승부, 베팅금 환급) / NATURAL_WIN(처음 2장으로 21, 1.5배 보너스)
export type BlackjackOutcome = 'WIN' | 'LOSE' | 'PUSH' | 'NATURAL_WIN';

export const MIN_BET_AMOUNT = 100_000; // 💡 최소 베팅금 (스펙 고정값)
export const MAX_BET_RATIO = 0.25; // 💡 최대 베팅금 = 보유 포인트의 25%
const NATURAL_WIN_PROFIT_RATE = 1.5; // 💡 자연승 시 순수익 배율 (1000 베팅 -> 순이익 1500)
const DEALER_STAND_THRESHOLD = 17; // 💡 딜러는 이 숫자 이상이면 더 이상 카드를 안 받는다
const BLACKJACK_VALUE = 21;

const SUITS: Suit[] = ['♠', '♥', '♦', '♣'];
const RANKS: Rank[] = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

export class BetTooSmallError extends Error {}
export class BetTooLargeError extends Error {}

// 💡 카드 한 장의 "기본" 점수. 숫자 카드는 숫자 그대로, J/Q/K는 10, 에이스는 일단 11로 계산해둔다
// (나중에 21이 넘으면 calculateHandValue에서 1로 낮춰준다).
function baseCardValue(rank: Rank): number {
  if (rank === 'A') {
    return 11;
  }
  if (rank === 'J' || rank === 'Q' || rank === 'K') {
    return 10;
  }
  return Number(rank);
}

// 💡 손에 든 카드들의 총점을 계산한다. 블랙잭에서 제일 헷갈리는 부분이 "에이스는 11이야 1이야?"
// 인데, 규칙은 간단하다: "일단 11로 쳐보고, 21을 넘으면 하나씩 1로 낮춰서 다시 계산"이다.
export function calculateHandValue(hand: Card[]): number {
  let total = hand.reduce((sum, c) => sum + baseCardValue(c.rank), 0);
  let acesCountedAsEleven = hand.filter((c) => c.rank === 'A').length;

  // 💡 21을 넘었고, 아직 11로 세고 있는 에이스가 있으면 그 에이스를 1로 낮춘다(총점에서 10을 뺌).
  // 에이스가 여러 장이면 필요한 만큼 반복해서 낮춘다.
  while (total > BLACKJACK_VALUE && acesCountedAsEleven > 0) {
    total -= 10;
    acesCountedAsEleven -= 1;
  }

  return total;
}

// 💡 21을 넘었으면 "버스트"(bust) - 무조건 패배.
export function isBust(hand: Card[]): boolean {
  return calculateHandValue(hand) > BLACKJACK_VALUE;
}

// 💡 "자연블랙잭"은 처음 받은 카드 딱 2장으로 21을 만든 경우만 인정한다.
// (카드를 더 받아서 나중에 21이 되는 건 자연블랙잭이 아니다)
export function isNaturalBlackjack(hand: Card[]): boolean {
  return hand.length === 2 && calculateHandValue(hand) === BLACKJACK_VALUE;
}

// 💡 딜러는 사람처럼 판단하지 않고 정해진 규칙만 따른다: 17 미만이면 무조건 히트, 17 이상이면
// 무조건 스탠드. (소프트 17 예외 규칙은 이 게임에 없음 - 스펙 확정사항)
export function dealerShouldHit(dealerHand: Card[]): boolean {
  return calculateHandValue(dealerHand) < DEALER_STAND_THRESHOLD;
}

// 💡 플레이어와 딜러의 최종 패를 비교해서 승패를 정한다.
// 이 함수는 "플레이어가 버스트하지 않은 상태"에서만 호출된다고 가정한다
// (버스트는 딜러가 카드를 더 받기도 전에 바로 LOSE로 확정되기 때문에 더 이를 확인할 필요가 없다).
export function determineOutcome(playerHand: Card[], dealerHand: Card[]): BlackjackOutcome {
  const playerNatural = isNaturalBlackjack(playerHand);
  const dealerNatural = isNaturalBlackjack(dealerHand);

  // 💡 둘 다 처음 2장으로 21이면 무승부(둘 다 "자연"이라 비길 뿐, 누구도 보너스를 못 받는다).
  if (playerNatural && dealerNatural) {
    return 'PUSH';
  }
  if (playerNatural) {
    return 'NATURAL_WIN';
  }
  if (dealerNatural) {
    return 'LOSE';
  }

  if (isBust(dealerHand)) {
    return 'WIN';
  }

  const playerValue = calculateHandValue(playerHand);
  const dealerValue = calculateHandValue(dealerHand);

  if (playerValue > dealerValue) {
    return 'WIN';
  }
  if (playerValue < dealerValue) {
    return 'LOSE';
  }
  return 'PUSH';
}

// 💡 결과에 따라 "플레이어에게 최종적으로 지급할 금액"을 계산한다.
// 이미 베팅 시점에 원금을 차감했다는 전제 하에, 여기 계산된 금액을 그대로 돌려주면 된다.
// - LOSE: 0원 (원금은 이미 하우스로 귀속됨)
// - PUSH: 원금 그대로 환급
// - WIN: 원금 + 원금만큼(1배) 추가 = 총 2배
// - NATURAL_WIN: 원금 + 원금의 1.5배(내림 처리) 추가
export function calculatePayout(betAmount: number, outcome: BlackjackOutcome): number {
  if (outcome === 'LOSE') {
    return 0;
  }
  if (outcome === 'PUSH') {
    return betAmount;
  }
  if (outcome === 'NATURAL_WIN') {
    const profit = Math.floor(betAmount * NATURAL_WIN_PROFIT_RATE);
    return betAmount + profit;
  }
  // WIN
  return betAmount * 2;
}

// 💡 베팅금이 규칙(최소 10만 / 최대 보유포인트의 25%, 내림 처리)에 맞는지 확인한다.
// 문제가 있으면 에러를 던지고, 문제 없으면 그냥 조용히 끝난다(반환값 없음).
export function validateBetAmount(betAmount: number, userBalance: number): void {
  if (betAmount < MIN_BET_AMOUNT) {
    throw new BetTooSmallError(
      `bet amount ${betAmount} is below the minimum ${MIN_BET_AMOUNT}`
    );
  }

  const maxBet = Math.floor(userBalance * MAX_BET_RATIO);
  if (betAmount > maxBet) {
    throw new BetTooLargeError(
      `bet amount ${betAmount} exceeds the maximum ${maxBet} (25% of balance ${userBalance})`
    );
  }
}

// 💡 카드 52장을 순서대로(셔플 안 한 상태로) 만든다. 실전에서는 이걸 바로 shuffleDeck에 넣어서 쓴다.
export function createOrderedDeck(): Card[] {
  const deck: Card[] = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({ rank, suit });
    }
  }
  return deck;
}

// 💡 카드를 무작위로 섞는다(피셔-예이츠 셔플 알고리즘). random 함수를 직접 넣을 수 있게 해둬서,
// 테스트할 때는 "항상 똑같이 섞이는 가짜 난수"를 넣어 결과를 예측 가능하게 만들 수 있다.
export function shuffleDeck(deck: Card[], random: () => number = Math.random): Card[] {
  const shuffled = [...deck];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}
