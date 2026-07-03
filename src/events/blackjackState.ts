// 💡 지금 한창 진행 중인 블랙잭 게임들을 잠깐 기억해두는 "메모장"이다. DB가 아니라 그냥 서버
// 메모리(Map)라서, 봇이 재시작되면 진행 중이던 게임은 전부 사라진다 (스펙에서 확정한 대로,
// 이 리스크는 감수하고 별도 복구 로직은 만들지 않는다).
import type { Card } from '../services/blackjack';

export interface ActiveBlackjackGame {
  deck: Card[];
  playerHand: Card[];
  dealerHand: Card[];
  betAmount: number;
  // 💡 60초 동안 히트/스탠드 버튼을 안 누르면 자동으로 스탠드 처리하기 위한 타이머.
  // 유저가 직접 버튼을 눌러서 게임이 끝나면 이 타이머는 꼭 취소해줘야 한다(안 그러면
  // 이미 끝난 게임에 뒤늦게 자동 스탠드가 실행되려고 시도한다).
  timeout: NodeJS.Timeout;
}

// 💡 key = 유저 discordId, value = 그 유저가 지금 진행 중인 게임 상태.
// 한 유저는 동시에 한 판만 할 수 있어서, 이미 Map에 키가 있으면 새 게임 시작을 막는다.
export const activeBlackjackGames = new Map<string, ActiveBlackjackGame>();
