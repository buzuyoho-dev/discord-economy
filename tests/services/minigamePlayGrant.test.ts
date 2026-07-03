import { describe, expect, test } from 'vitest';
import { prisma } from '../../src/db/client';
import { NotAdminError } from '../../src/services/adminGrant';
import { BLACKJACK_GAME_TYPE, MAX_PLAYS_PER_DAY } from '../../src/services/blackjackGame';
import { BotTargetError } from '../../src/services/discordTargetGuard';
import { kstMidnightUtc } from '../../src/services/kst';
import { getOrCreateUser, STARTING_BALANCE } from '../../src/services/ledger';
import {
  buildMinigamePlayGrantPlan,
  grantMinigamePlays,
  InvalidPlayGrantCountError,
  previewMinigamePlayGrant,
} from '../../src/services/minigamePlayGrant';

const ADMIN_ID = 'admin-1';
const NOW = new Date('2026-07-06T02:00:00.000Z'); // KST 오전 11시
const PLAY_DATE = kstMidnightUtc(NOW);

describe('previewMinigamePlayGrant / grantMinigamePlays - 권한 및 유효성', () => {
  test('관리자가 아니면 preview/grant 둘 다 거부한다', async () => {
    await expect(
      previewMinigamePlayGrant({
        game: 'BLACKJACK',
        count: 2,
        requestedBy: 'not-admin',
        adminDiscordId: ADMIN_ID,
      })
    ).rejects.toThrow(NotAdminError);

    await expect(
      grantMinigamePlays({
        game: 'BLACKJACK',
        count: 2,
        requestedBy: 'not-admin',
        adminDiscordId: ADMIN_ID,
      })
    ).rejects.toThrow(NotAdminError);
  });

  test('횟수가 0이면 거부한다', async () => {
    await expect(
      grantMinigamePlays({ game: 'BLACKJACK', count: 0, requestedBy: ADMIN_ID, adminDiscordId: ADMIN_ID })
    ).rejects.toThrow(InvalidPlayGrantCountError);
  });

  test('횟수가 음수면 거부한다', async () => {
    await expect(
      grantMinigamePlays({ game: 'BLACKJACK', count: -1, requestedBy: ADMIN_ID, adminDiscordId: ADMIN_ID })
    ).rejects.toThrow(InvalidPlayGrantCountError);
  });

  test('횟수가 정수가 아니면 거부한다', async () => {
    await expect(
      grantMinigamePlays({ game: 'BLACKJACK', count: 1.5, requestedBy: ADMIN_ID, adminDiscordId: ADMIN_ID })
    ).rejects.toThrow(InvalidPlayGrantCountError);
  });
});

describe('grantMinigamePlays - 단일 유저 대상', () => {
  test('오늘 기록이 없던 유저는 count가 음수로 새로 생성되고 잔여 횟수가 +N 된다', async () => {
    await getOrCreateUser('grant-single-1');

    const result = await grantMinigamePlays({
      game: 'BLACKJACK',
      targetUserId: 'grant-single-1',
      count: 2,
      reason: '테스트 지급',
      requestedBy: ADMIN_ID,
      adminDiscordId: ADMIN_ID,
      now: NOW,
    });

    expect(result.targetUserIds).toEqual(['grant-single-1']);
    expect(result.plan).toEqual([
      {
        userId: 'grant-single-1',
        playsRemainingBefore: MAX_PLAYS_PER_DAY,
        playsRemainingAfter: MAX_PLAYS_PER_DAY + 2,
      },
    ]);

    const log = await prisma.minigamePlayLog.findUniqueOrThrow({
      where: {
        userId_gameType_playDate: {
          userId: 'grant-single-1',
          gameType: BLACKJACK_GAME_TYPE,
          playDate: PLAY_DATE,
        },
      },
    });
    expect(log.count).toBe(-2);
  });

  test('오늘 이미 몇 판 플레이한 유저는 count가 그만큼 줄어든다', async () => {
    await getOrCreateUser('grant-single-2');
    await prisma.minigamePlayLog.create({
      data: { userId: 'grant-single-2', gameType: BLACKJACK_GAME_TYPE, playDate: PLAY_DATE, count: 3 },
    });

    const result = await grantMinigamePlays({
      game: 'BLACKJACK',
      targetUserId: 'grant-single-2',
      count: 2,
      requestedBy: ADMIN_ID,
      adminDiscordId: ADMIN_ID,
      now: NOW,
    });

    expect(result.plan).toEqual([
      {
        userId: 'grant-single-2',
        playsRemainingBefore: MAX_PLAYS_PER_DAY - 3,
        playsRemainingAfter: MAX_PLAYS_PER_DAY - 1,
      },
    ]);

    const log = await prisma.minigamePlayLog.findUniqueOrThrow({
      where: {
        userId_gameType_playDate: {
          userId: 'grant-single-2',
          gameType: BLACKJACK_GAME_TYPE,
          playDate: PLAY_DATE,
        },
      },
    });
    expect(log.count).toBe(1);
  });

  test('아직 User row가 없는 유저를 지정해도 자동 생성 후 지급된다', async () => {
    const result = await grantMinigamePlays({
      game: 'BLACKJACK',
      targetUserId: 'grant-single-brand-new',
      count: 1,
      requestedBy: ADMIN_ID,
      adminDiscordId: ADMIN_ID,
      now: NOW,
    });

    expect(result.targetUserIds).toEqual(['grant-single-brand-new']);
    const user = await prisma.user.findUniqueOrThrow({ where: { discordId: 'grant-single-brand-new' } });
    expect(user.balance).toBe(STARTING_BALANCE);
  });

  test('Transaction에 amount 0으로 기록되고 사유가 description에 남는다', async () => {
    await getOrCreateUser('grant-single-3');

    await grantMinigamePlays({
      game: 'BLACKJACK',
      targetUserId: 'grant-single-3',
      count: 2,
      reason: '오픈 기념 이벤트',
      requestedBy: ADMIN_ID,
      adminDiscordId: ADMIN_ID,
      now: NOW,
    });

    const txs = await prisma.transaction.findMany({
      where: { userId: 'grant-single-3', type: 'MINIGAME_PLAY_GRANT' },
    });
    expect(txs).toHaveLength(1);
    expect(txs[0].amount).toBe(0);
    expect(txs[0].balanceAfter).toBe(STARTING_BALANCE);
    expect(txs[0].description).toBe('블랙잭 잔여 횟수 +2 지급 (오픈 기념 이벤트)');
  });

  test('사유를 생략하면 description에 괄호가 붙지 않는다', async () => {
    await getOrCreateUser('grant-single-4');

    await grantMinigamePlays({
      game: 'BLACKJACK',
      targetUserId: 'grant-single-4',
      count: 1,
      requestedBy: ADMIN_ID,
      adminDiscordId: ADMIN_ID,
      now: NOW,
    });

    const txs = await prisma.transaction.findMany({
      where: { userId: 'grant-single-4', type: 'MINIGAME_PLAY_GRANT' },
    });
    expect(txs[0].description).toBe('블랙잭 잔여 횟수 +1 지급');
  });

  test('대상이 봇이면 거부되고 User row 자체가 생성되지 않는다', async () => {
    await expect(
      grantMinigamePlays({
        game: 'BLACKJACK',
        targetUserId: 'grant-single-bot',
        targetIsBot: true,
        count: 1,
        requestedBy: ADMIN_ID,
        adminDiscordId: ADMIN_ID,
        now: NOW,
      })
    ).rejects.toThrow(BotTargetError);

    const botUser = await prisma.user.findUnique({ where: { discordId: 'grant-single-bot' } });
    expect(botUser).toBeNull();
  });
});

describe('grantMinigamePlays - 전체 유저 대상', () => {
  test('targetUserId를 생략하면 DB의 모든 유저에게 각각 지급된다', async () => {
    await getOrCreateUser('grant-all-1');
    await getOrCreateUser('grant-all-2');

    const result = await grantMinigamePlays({
      game: 'BLACKJACK',
      count: 2,
      requestedBy: ADMIN_ID,
      adminDiscordId: ADMIN_ID,
      now: NOW,
    });

    expect(result.targetUserIds.slice().sort()).toEqual(['grant-all-1', 'grant-all-2']);

    const logs = await prisma.minigamePlayLog.findMany({
      where: { gameType: BLACKJACK_GAME_TYPE, playDate: PLAY_DATE },
    });
    expect(logs.map((l) => l.count).sort()).toEqual([-2, -2]);
  });
});

describe('previewMinigamePlayGrant - DB를 바꾸지 않는다', () => {
  test('미리보기 호출 후에도 MinigamePlayLog는 그대로다', async () => {
    await getOrCreateUser('grant-preview-1');

    const preview = await previewMinigamePlayGrant({
      game: 'BLACKJACK',
      targetUserId: 'grant-preview-1',
      count: 2,
      requestedBy: ADMIN_ID,
      adminDiscordId: ADMIN_ID,
      now: NOW,
    });

    expect(preview.plan).toEqual([
      {
        userId: 'grant-preview-1',
        playsRemainingBefore: MAX_PLAYS_PER_DAY,
        playsRemainingAfter: MAX_PLAYS_PER_DAY + 2,
      },
    ]);

    const log = await prisma.minigamePlayLog.findUnique({
      where: {
        userId_gameType_playDate: {
          userId: 'grant-preview-1',
          gameType: BLACKJACK_GAME_TYPE,
          playDate: PLAY_DATE,
        },
      },
    });
    expect(log).toBeNull();
  });
});

describe('buildMinigamePlayGrantPlan - 코어 함수 (임의의 targetUserIds 배열)', () => {
  test('스크립트처럼 특정 유저 목록만 골라서 미리보기를 계산할 수 있다', async () => {
    await getOrCreateUser('grant-core-1');
    await getOrCreateUser('grant-core-2');
    await getOrCreateUser('grant-core-3'); // 대상에서 제외될 유저

    const result = await buildMinigamePlayGrantPlan(prisma, {
      game: 'BLACKJACK',
      targetUserIds: ['grant-core-1', 'grant-core-2'],
      count: 3,
      now: NOW,
    });

    expect(result.targetUserIds).toEqual(['grant-core-1', 'grant-core-2']);
    expect(result.plan.map((p) => p.userId)).toEqual(['grant-core-1', 'grant-core-2']);
  });
});
