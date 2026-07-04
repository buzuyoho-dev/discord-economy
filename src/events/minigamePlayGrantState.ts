// 💡 "/횟수지급"을 전체 유저 대상으로 실행하면, 확인 버튼을 누르기 전까지 게임/횟수/사유를
// 잠깐 기억해둬야 한다. 버튼 customId는 100자 제한이 있어서 사유 같은 자유 텍스트를 못 넣으므로,
// RPS의 pendingRpsChallenges(src/events/rpsState.ts)와 완전히 동일한 방식으로 서버 메모리
// Map에 저장하고 customId에는 무작위 id만 싣는다. 봇이 재시작되면 사라지는 것도 감수한다
// (다른 in-memory 상태들과 동일한 트레이드오프).
import type { MinigameChoice } from '../services/minigamePlayGrant';

export interface PendingPlayGrant {
  game: MinigameChoice;
  count: number;
  reason?: string;
  requestedBy: string;
}

// 💡 key = crypto.randomUUID()로 만든, 그 자체로는 아무 정보도 유추할 수 없는 id.
export const pendingPlayGrants = new Map<string, PendingPlayGrant>();
