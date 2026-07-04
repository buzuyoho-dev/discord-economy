// 💡 여러 커맨드(양도/포인트지급/대출요청 등)가 "상대방으로 봇을 고르면 안 된다"를
// 전부 똑같은 방식으로 검사해야 해서 한 곳에 모아뒀다. 새 커맨드가 다른 유저를 상대로
// 지목하게 만들 때도 이 함수 하나만 호출하면 된다.
export class BotTargetError extends Error {
  constructor(targetId: string) {
    super(`${targetId} is a bot and cannot be targeted by this command`);
    this.name = 'BotTargetError';
  }
}

// 💡 isBot이 true면 에러를 던진다. isBot이 false거나 알 수 없으면(undefined) 그냥 통과시킨다
// (커맨드에서 discord.js User 객체의 .bot 값을 그대로 넘기면 되고, 값을 못 구하는 상황이어도
// 안전하게 "봇 아님"으로 취급한다).
export function assertNotBotTarget(isBot: boolean | undefined, targetId: string): void {
  if (isBot) {
    throw new BotTargetError(targetId);
  }
}
