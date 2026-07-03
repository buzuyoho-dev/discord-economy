// 💡 이 파일은 "미니게임 오늘 잔여 플레이 횟수를 지급한다"는 로직을 담당한다.
// 코어 함수(buildMinigamePlayGrantPlan/applyMinigamePlayGrant)는 "누가 대상인지"를 모른다 -
// targetUserIds 배열을 그대로 받아서 처리만 한다. "대상을 누구로 정할지"(특정 유저 1명?
// 전체 유저? 최근 활동 유저?)는 호출하는 쪽(슬래시 커맨드, 1회성 스크립트)이 결정한다.
// distributionBatch.ts가 대상 결정(getLowerTierUserIds)과 실행(issueCouponsForUsers)을
// 나눠둔 것과 같은 이유다.
import { Prisma, TransactionType } from '@prisma/client';
import { prisma } from '../db/client';
import { NotAdminError } from './adminGrant';
import { BLACKJACK_GAME_TYPE, MAX_PLAYS_PER_DAY } from './blackjackGame';
import { kstMidnightUtc } from './kst';
import { applyTransaction, getOrCreateUser } from './ledger';

type Db = Prisma.TransactionClient | typeof prisma;

// 💡 "게임 이름 -> MinigamePlayLog의 gameType 문자열 / 하루 최대 횟수 / 화면에 보여줄 한글 이름"
// 매핑표. 앞으로 같은 방식(MinigamePlayLog)으로 일일 횟수를 관리하는 게임이 추가되면
// 여기 한 줄만 추가하면 /횟수지급이 그 게임도 바로 지원하게 된다. 지금은 블랙잭만 이 방식을
// 쓴다 (RPS는 일부러 일일 제한이 없고, 복권은 완전히 다른 모델이라 대상 아님).
export const MINIGAME_REGISTRY = {
  BLACKJACK: { label: '블랙잭', gameType: BLACKJACK_GAME_TYPE, maxPlaysPerDay: MAX_PLAYS_PER_DAY },
} as const;

export type MinigameChoice = keyof typeof MINIGAME_REGISTRY;

export class InvalidPlayGrantCountError extends Error {}

// 💡 count가 1 이상의 정수인지 확인한다. Discord 슬래시 커맨드 옵션에도 setMinValue(1)을
// 걸어두지만, 이 서비스 함수를 스크립트나 테스트에서 직접 호출할 수도 있으므로 여기서도 검증한다.
function assertValidCount(count: number): void {
  if (!Number.isInteger(count) || count < 1) {
    throw new InvalidPlayGrantCountError('count must be a positive integer');
  }
}

function assertAdmin(requestedBy: string, adminDiscordId: string | undefined): void {
  if (!adminDiscordId || requestedBy !== adminDiscordId) {
    throw new NotAdminError(requestedBy);
  }
}

// 💡 MinigamePlayLog.count(오늘 플레이한 횟수)로부터 "오늘 남은 횟수"를 계산한다.
function playsRemainingFromCount(maxPlaysPerDay: number, count: number): number {
  return maxPlaysPerDay - count;
}

export interface MinigamePlayGrantPlanItem {
  userId: string;
  playsRemainingBefore: number;
  playsRemainingAfter: number;
}

export interface MinigamePlayGrantPlan {
  targetUserIds: string[];
  plan: MinigamePlayGrantPlanItem[];
}

// 💡 실제로 DB를 바꾸지 않고 "지급하면 어떻게 될지"만 계산하는 읽기 전용 함수.
// db는 prisma 그 자체여도, $transaction 안의 tx여도 상관없이 받는다.
export async function buildMinigamePlayGrantPlan(
  db: Db,
  params: { game: MinigameChoice; targetUserIds: string[]; count: number; now?: Date }
): Promise<MinigamePlayGrantPlan> {
  assertValidCount(params.count);
  const now = params.now ?? new Date();
  const playDate = kstMidnightUtc(now);
  const config = MINIGAME_REGISTRY[params.game];

  const existingLogs = await db.minigamePlayLog.findMany({
    where: { userId: { in: params.targetUserIds }, gameType: config.gameType, playDate },
  });
  const countByUserId = new Map(existingLogs.map((log) => [log.userId, log.count]));

  const plan: MinigamePlayGrantPlanItem[] = params.targetUserIds.map((userId) => {
    const countBefore = countByUserId.get(userId) ?? 0;
    return {
      userId,
      playsRemainingBefore: playsRemainingFromCount(config.maxPlaysPerDay, countBefore),
      // 💡 "잔여 횟수 +N"은 곧 "오늘 플레이 횟수(count) -N"과 같다 (count가 낮을수록 남은 횟수가 많아짐).
      playsRemainingAfter: playsRemainingFromCount(config.maxPlaysPerDay, countBefore - params.count),
    };
  });

  return { targetUserIds: params.targetUserIds, plan };
}

// 💡 실제로 DB에 반영하는 함수. 반드시 prisma.$transaction 안에서 받은 tx로 호출해야 한다 -
// 이 함수 스스로는 트랜잭션을 열지 않는다(호출하는 쪽이 트랜잭션 범위를 결정한다).
export async function applyMinigamePlayGrant(
  tx: Prisma.TransactionClient,
  params: { game: MinigameChoice; targetUserIds: string[]; count: number; reason?: string; now?: Date }
): Promise<MinigamePlayGrantPlan> {
  assertValidCount(params.count);
  const now = params.now ?? new Date();
  const playDate = kstMidnightUtc(now);
  const config = MINIGAME_REGISTRY[params.game];

  const { plan } = await buildMinigamePlayGrantPlan(tx, {
    game: params.game,
    targetUserIds: params.targetUserIds,
    count: params.count,
    now,
  });

  const description = `${config.label} 잔여 횟수 +${params.count} 지급${params.reason ? ` (${params.reason})` : ''}`;

  for (const userId of params.targetUserIds) {
    // 💡 오늘 기록이 아예 없던 유저는 count: -N으로 새로 만든다.
    // (예: -2로 시작하면 나중에 실제로 2번 플레이해도 count는 0이 되어 기본 회수를 꽉 채워 쓸 수 있다.)
    await tx.minigamePlayLog.upsert({
      where: { userId_gameType_playDate: { userId, gameType: config.gameType, playDate } },
      create: { userId, gameType: config.gameType, playDate, count: -params.count },
      update: { count: { decrement: params.count } },
    });

    // 💡 포인트 잔액은 안 바뀌지만(amount: 0), 몇 회를 왜 지급했는지는 Transaction에 남겨서
    // 나중에 /포인트내역으로 조회할 수 있게 한다.
    await applyTransaction(tx, {
      discordId: userId,
      type: TransactionType.MINIGAME_PLAY_GRANT,
      amount: 0,
      description,
      occurredAt: now,
    });
  }

  return { targetUserIds: params.targetUserIds, plan };
}

// 💡 targetUserId를 지정하면 그 유저 1명, 안 하면 DB에 있는 모든 유저를 대상으로 삼는다.
async function resolveTargetUserIds(db: Db, targetUserId: string | undefined): Promise<string[]> {
  if (targetUserId) {
    return [targetUserId];
  }
  const users = await db.user.findMany({ select: { discordId: true } });
  return users.map((u) => u.discordId);
}

export interface MinigamePlayGrantParams {
  game: MinigameChoice;
  targetUserId?: string;
  count: number;
  requestedBy: string;
  adminDiscordId: string | undefined;
  now?: Date;
}

// 💡 슬래시 커맨드가 "전체 대상" 확인 버튼을 보여주기 전에 쓰는 함수.
// 관리자 인증 -> 대상 결정 -> 미리보기 계산까지 한 번에 처리한다. DB는 바꾸지 않는다.
export async function previewMinigamePlayGrant(
  params: MinigamePlayGrantParams
): Promise<MinigamePlayGrantPlan> {
  assertAdmin(params.requestedBy, params.adminDiscordId);
  assertValidCount(params.count);

  const targetUserIds = await resolveTargetUserIds(prisma, params.targetUserId);
  return buildMinigamePlayGrantPlan(prisma, {
    game: params.game,
    targetUserIds,
    count: params.count,
    now: params.now,
  });
}

export interface GrantMinigamePlaysParams extends MinigamePlayGrantParams {
  reason?: string;
}

// 💡 실제로 지급하는 함수. 유저 1명이 지정됐는데 아직 User row가 없을 수 있으므로
// (adminGrant.ts의 grantPoints와 동일한 패턴으로) 트랜잭션 진입 전에 먼저 만들어둔다.
export async function grantMinigamePlays(
  params: GrantMinigamePlaysParams
): Promise<MinigamePlayGrantPlan> {
  assertAdmin(params.requestedBy, params.adminDiscordId);
  assertValidCount(params.count);

  if (params.targetUserId) {
    await getOrCreateUser(params.targetUserId);
  }

  const now = params.now ?? new Date();

  return prisma.$transaction(async (tx) => {
    const targetUserIds = await resolveTargetUserIds(tx, params.targetUserId);
    return applyMinigamePlayGrant(tx, {
      game: params.game,
      targetUserIds,
      count: params.count,
      reason: params.reason,
      now,
    });
  });
}
