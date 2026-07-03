import { describe, expect, test } from 'vitest';
import { prisma } from '../../src/db/client';
import { BetTooLargeError, BetTooSmallError } from '../../src/services/blackjack';
import {
  BLACKJACK_GAME_TYPE,
  DailyPlayLimitExceededError,
  MAX_PLAYS_PER_DAY,
  settleBlackjackGame,
  startBlackjackGame,
} from '../../src/services/blackjackGame';
import { HOUSE_ID } from '../../src/services/house';
import { kstMidnightUtc } from '../../src/services/kst';
import { getOrCreateUser, STARTING_BALANCE } from '../../src/services/ledger';

const NOW = new Date('2026-07-06T02:00:00.000Z'); // KST 오전 11시

describe('startBlackjackGame', () => {
  test('정상 베팅이면 즉시 차감되고 남은 잔액을 반환한다', async () => {
    const result = await startBlackjackGame({
      discordId: 'bj-start-1',
      betAmount: 1_000_000,
      now: NOW,
    });

    expect(result.balanceAfter).toBe(STARTING_BALANCE - 1_000_000);

    const user = await prisma.user.findUniqueOrThrow({ where: { discordId: 'bj-start-1' } });
    expect(user.balance).toBe(STARTING_BALANCE - 1_000_000);

    const txs = await prisma.transaction.findMany({
      where: { userId: 'bj-start-1', type: 'BLACKJACK_BET' },
    });
    expect(txs).toHaveLength(1);
    expect(txs[0].amount).toBe(-1_000_000);
  });

  test('베팅금이 10만 미만이면 거부하고 잔액은 그대로다', async () => {
    await getOrCreateUser('bj-start-2');

    await expect(
      startBlackjackGame({ discordId: 'bj-start-2', betAmount: 99_999, now: NOW })
    ).rejects.toThrow(BetTooSmallError);

    const user = await prisma.user.findUniqueOrThrow({ where: { discordId: 'bj-start-2' } });
    expect(user.balance).toBe(STARTING_BALANCE);
  });

  test('베팅금이 보유 포인트의 25%를 초과하면 거부한다', async () => {
    await getOrCreateUser('bj-start-3');
    const maxBet = Math.floor(STARTING_BALANCE * 0.25);

    await expect(
      startBlackjackGame({ discordId: 'bj-start-3', betAmount: maxBet + 1, now: NOW })
    ).rejects.toThrow(BetTooLargeError);
  });

  test('오늘 이미 5회 플레이했으면 거부한다', async () => {
    await getOrCreateUser('bj-start-4');
    const playDate = kstMidnightUtc(NOW);
    await prisma.minigamePlayLog.create({
      data: { userId: 'bj-start-4', gameType: BLACKJACK_GAME_TYPE, playDate, count: MAX_PLAYS_PER_DAY },
    });

    await expect(
      startBlackjackGame({ discordId: 'bj-start-4', betAmount: 1_000_000, now: NOW })
    ).rejects.toThrow(DailyPlayLimitExceededError);
  });

  test('동시에 두 번 시작을 시도해도 정확히 한 번만 차감된다 (원자성)', async () => {
    await getOrCreateUser('bj-start-5');
    const bet = Math.floor(STARTING_BALANCE * 0.25); // 정확히 상한값 - 한 번 차감되면 다음 베팅은 상한 초과가 된다

    const results = await Promise.allSettled([
      startBlackjackGame({ discordId: 'bj-start-5', betAmount: bet, now: NOW }),
      startBlackjackGame({ discordId: 'bj-start-5', betAmount: bet, now: NOW }),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const user = await prisma.user.findUniqueOrThrow({ where: { discordId: 'bj-start-5' } });
    expect(user.balance).toBe(STARTING_BALANCE - bet); // 딱 한 번만 차감됨
  });
});

describe('settleBlackjackGame', () => {
  test('WIN이면 원금의 2배를 지급하고 하우스는 건드리지 않는다', async () => {
    await getOrCreateUser('bj-settle-win');
    const result = await settleBlackjackGame({
      discordId: 'bj-settle-win',
      betAmount: 1_000_000,
      outcome: 'WIN',
      now: NOW,
    });

    expect(result.balanceAfter).toBe(STARTING_BALANCE + 2_000_000);
    const house = await prisma.house.findUnique({ where: { id: HOUSE_ID } });
    expect(house?.balance ?? 0).toBe(0);
  });

  test('NATURAL_WIN이면 원금 + 1.5배 순수익을 지급한다', async () => {
    await getOrCreateUser('bj-settle-natural');
    const result = await settleBlackjackGame({
      discordId: 'bj-settle-natural',
      betAmount: 1_000_000,
      outcome: 'NATURAL_WIN',
      now: NOW,
    });

    // 원금 1,000,000 + 순수익 floor(1,000,000*1.5)=1,500,000 = 2,500,000 지급
    expect(result.balanceAfter).toBe(STARTING_BALANCE + 2_500_000);
  });

  test('PUSH면 원금을 그대로 환급한다', async () => {
    await getOrCreateUser('bj-settle-push');
    const result = await settleBlackjackGame({
      discordId: 'bj-settle-push',
      betAmount: 1_000_000,
      outcome: 'PUSH',
      now: NOW,
    });

    expect(result.balanceAfter).toBe(STARTING_BALANCE + 1_000_000);
  });

  test('LOSE면 유저는 추가 변동이 없고 베팅금은 하우스로 귀속된다', async () => {
    await getOrCreateUser('bj-settle-lose');
    const result = await settleBlackjackGame({
      discordId: 'bj-settle-lose',
      betAmount: 1_000_000,
      outcome: 'LOSE',
      now: NOW,
    });

    expect(result.balanceAfter).toBe(STARTING_BALANCE); // 이미 베팅 시점에 차감됐으므로 추가 변동 없음
    const house = await prisma.house.findUniqueOrThrow({ where: { id: HOUSE_ID } });
    expect(house.balance).toBe(1_000_000);
  });

  test('정산할 때마다 오늘 플레이 횟수가 1씩 늘어난다', async () => {
    const discordId = 'bj-settle-count';
    await getOrCreateUser(discordId);

    const first = await settleBlackjackGame({ discordId, betAmount: 1_000_000, outcome: 'LOSE', now: NOW });
    expect(first.playsToday).toBe(1);
    expect(first.playsRemaining).toBe(MAX_PLAYS_PER_DAY - 1);

    const second = await settleBlackjackGame({ discordId, betAmount: 1_000_000, outcome: 'LOSE', now: NOW });
    expect(second.playsToday).toBe(2);
    expect(second.playsRemaining).toBe(MAX_PLAYS_PER_DAY - 2);

    const log = await prisma.minigamePlayLog.findUniqueOrThrow({
      where: {
        userId_gameType_playDate: {
          userId: discordId,
          gameType: BLACKJACK_GAME_TYPE,
          playDate: kstMidnightUtc(NOW),
        },
      },
    });
    expect(log.count).toBe(2);
  });

  test('다른 게임 종류(gameType)의 카운트는 블랙잭 카운트와 완전히 분리된다', async () => {
    const discordId = 'bj-settle-isolated';
    await getOrCreateUser(discordId);
    const playDate = kstMidnightUtc(NOW);
    await prisma.minigamePlayLog.create({
      data: { userId: discordId, gameType: 'RPS', playDate, count: 5 },
    });

    const result = await settleBlackjackGame({ discordId, betAmount: 1_000_000, outcome: 'LOSE', now: NOW });

    expect(result.playsToday).toBe(1); // RPS의 5와 무관하게 블랙잭은 1부터 시작

    const rpsLog = await prisma.minigamePlayLog.findUniqueOrThrow({
      where: { userId_gameType_playDate: { userId: discordId, gameType: 'RPS', playDate } },
    });
    expect(rpsLog.count).toBe(5); // 그대로 유지
  });
});
