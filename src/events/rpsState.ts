// 💡 아직 상대가 응답하지 않은 가위바위보 도전을 서버 메모리에 잠깐 기억해두는 저장소.
// 블랙잭의 activeBlackjackGames와 완전히 같은 방식: 서버가 재시작되면 사라지는 걸 감수하고,
// DB에는 절대 저장하지 않는다. 특히 challengerChoice(챌린저가 낸 것)는 여기에만 있고,
// 디스코드 메시지/버튼 customId 등 "메시지를 조회하면 누구나 볼 수 있는 곳"에는 절대 넣지 않는다.
import type { RpsChoice } from '../services/rps';

export interface PendingRpsChallenge {
  challengerId: string;
  opponentId: string;
  betAmount: number;
  challengerChoice: RpsChoice; // 💡 절대 노출되면 안 되는 값 - 메모리에만 존재
  timeout: NodeJS.Timeout;
}

// 💡 key = challengeId (crypto.randomUUID()로 만든, 그 자체로는 아무 정보도 유추할 수 없는
// 무작위 문자열). 이 challengeId는 버튼 customId에 넣어도 안전하다 - 챌린저의 선택과는
// 무관한 "이 도전을 가리키는 이름표"일 뿐이기 때문이다.
export const pendingRpsChallenges = new Map<string, PendingRpsChallenge>();
