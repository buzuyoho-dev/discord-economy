// 💡 이 파일은 가위바위보 게임의 "규칙"만 담당한다. 디스코드나 DB는 전혀 몰라도 되는 순수한
// 계산기라서 테스트하기 쉽고, blackjack.ts와 같은 방식으로 다른 곳에서도 재사용할 수 있다.

export type RpsChoice = '가위' | '바위' | '보';

export const RPS_CHOICES: RpsChoice[] = ['가위', '바위', '보'];

// 💡 대결 결과는 챌린저(도전자) 기준으로 표현한다. CHALLENGER_WIN=챌린저 승, OPPONENT_WIN=상대 승.
export type RpsResult = 'CHALLENGER_WIN' | 'OPPONENT_WIN' | 'DRAW';

export class SelfChallengeError extends Error {}
export class BotChallengeError extends Error {}

// 💡 "무엇이 무엇을 이기는지"를 표로 만들어둔다. 예: BEATS['가위'] === '보' -> 가위는 보를 이긴다.
const BEATS: Record<RpsChoice, RpsChoice> = {
  가위: '보',
  바위: '가위',
  보: '바위',
};

// 💡 챌린저와 상대가 낸 것을 비교해서 승패를 정한다.
// 같은 걸 냈으면 DRAW, 챌린저가 낸 게 상대가 낸 걸 이기는 조합이면 CHALLENGER_WIN, 아니면 OPPONENT_WIN.
export function determineRpsResult(challengerChoice: RpsChoice, opponentChoice: RpsChoice): RpsResult {
  if (challengerChoice === opponentChoice) {
    return 'DRAW';
  }
  return BEATS[challengerChoice] === opponentChoice ? 'CHALLENGER_WIN' : 'OPPONENT_WIN';
}

// 💡 승자가 가져가는 순수익의 비율 (스펙 고정값: 베팅금의 95%가 순수익, 나머지 5%는 하우스 수수료)
export const RPS_WINNER_PROFIT_RATE = 0.95;

export interface RpsPayout {
  winnerPayout: number; // 💡 승자에게 "최종적으로" 지급할 총액 (이미 차감된 원금을 되돌려주는 것 포함)
  housePayout: number; // 💡 하우스가 수수료로 가져가는 금액
}

// 💡 정산 공식을 계산한다. 베팅 수락 시점에 챌린저와 상대 양쪽에서 베팅금(B)을 이미 차감했다고
// 가정하고, "승자에게 얼마를 돌려줘야 최종 순수익이 +0.95B가 되는지"를 계산한다.
// - 순수익(profit) = floor(B * 0.95)
// - 승자 지급액 = B(원금 환급) + profit  -> 승자 최종 순손익 = -B(차감분) + (B+profit) = +profit
// - 하우스 몫 = B - profit (패자가 잃은 B 중 승자에게 안 간 나머지 전부)
// 검산: 승자 지급액 + 하우스 몫 = 2B = 처음에 두 사람에게서 차감한 총액. 돈이 새거나 생기지 않는다.
export function calculateRpsPayout(betAmount: number): RpsPayout {
  const profit = Math.floor(betAmount * RPS_WINNER_PROFIT_RATE);
  return {
    winnerPayout: betAmount + profit,
    housePayout: betAmount - profit,
  };
}

// 💡 상대로 지목한 사람이 유효한지 확인한다: 봇이면 안 되고, 자기 자신이면 안 된다.
// 문제가 있으면 에러를 던지고, 문제 없으면 그냥 조용히 끝난다(반환값 없음).
export function validateOpponent(
  challengerId: string,
  opponent: { id: string; bot: boolean }
): void {
  if (opponent.bot) {
    throw new BotChallengeError(`opponent ${opponent.id} is a bot`);
  }
  if (opponent.id === challengerId) {
    throw new SelfChallengeError(`challenger ${challengerId} cannot challenge themselves`);
  }
}
