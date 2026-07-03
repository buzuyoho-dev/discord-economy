import { describe, expect, test } from 'vitest';
import { prisma } from '../../src/db/client';
import { BetTooLargeError, BetTooSmallError } from '../../src/services/blackjack';
import { HOUSE_ID } from '../../src/services/house';
import { getOrCreateUser, STARTING_BALANCE } from '../../src/services/ledger';
import {
  InsufficientOpponentBalanceError,
  resolveRpsChallenge,
  startRpsChallenge,
} from '../../src/services/rpsGame';

const NOW = new Date('2026-07-06T02:00:00.000Z'); // KST 오전 11시

describe('startRpsChallenge', () => {
  test('정상적인 도전이면 차감 없이 두 사람의 잔액을 그대로 반환한다', async () => {
    const result = await startRpsChallenge({
      challengerId: 'rps-start-challenger-1',
      opponentId: 'rps-start-opponent-1',
      betAmount: 1_000_000,
      now: NOW,
    });

    expect(result.challengerBalance).toBe(STARTING_BALANCE);
    expect(result.opponentBalance).toBe(STARTING_BALANCE);

    // 💡 아직 수락 전이므로(getOrCreateUser의 시작 포인트 지급 외에는) 어떤 RPS 관련
    // 거래 기록도 생기면 안 된다.
    const rpsTxCount = await prisma.transaction.count({
      where: { type: { in: ['RPS_BET', 'RPS_WIN', 'RPS_LOSE', 'RPS_VOID'] } },
    });
    expect(rpsTxCount).toBe(0);
  });

  test('챌린저의 베팅금이 10만 미만이면 거부한다', async () => {
    await expect(
      startRpsChallenge({
        challengerId: 'rps-start-challenger-2',
        opponentId: 'rps-start-opponent-2',
        betAmount: 99_999,
        now: NOW,
      })
    ).rejects.toThrow(BetTooSmallError);
  });

  test('챌린저의 베팅금이 본인 보유 포인트의 25%를 초과하면 거부한다', async () => {
    const maxBet = Math.floor(STARTING_BALANCE * 0.25);

    await expect(
      startRpsChallenge({
        challengerId: 'rps-start-challenger-3',
        opponentId: 'rps-start-opponent-3',
        betAmount: maxBet + 1,
        now: NOW,
      })
    ).rejects.toThrow(BetTooLargeError);
  });

  test('상대방의 보유 포인트가 베팅금보다 적으면 무효 처리(에러)한다', async () => {
    const opponentId = 'rps-start-poor-opponent';
    await getOrCreateUser(opponentId);
    // 💡 상대방 잔액을 베팅금보다 적게 만들어둔다 (시작 잔액보다 훨씬 큰 베팅금으로 테스트)
    const betAmount = STARTING_BALANCE + 1_000_000; // 챌린저 잔액(1000만)의 25%를 넘으므로
    // 상한 검증에 걸리지 않도록 챌린저 잔액을 먼저 충분히 올려준다.
    const challengerId = 'rps-start-rich-challenger';
    await getOrCreateUser(challengerId);
    await prisma.user.update({ where: { discordId: challengerId }, data: { balance: 100_000_000 } });

    await expect(
      startRpsChallenge({ challengerId, opponentId, betAmount, now: NOW })
    ).rejects.toThrow(InsufficientOpponentBalanceError);
  });
});

describe('resolveRpsChallenge', () => {
  test('CHALLENGER_WIN이면 챌린저는 +0.95배, 상대는 -1배, 하우스는 +0.05배를 가져간다', async () => {
    const challengerId = 'rps-resolve-cw-challenger';
    const opponentId = 'rps-resolve-cw-opponent';
    await getOrCreateUser(challengerId);
    await getOrCreateUser(opponentId);

    const result = await resolveRpsChallenge({
      challengerId,
      opponentId,
      betAmount: 1_000_000,
      challengerChoice: '바위',
      opponentChoice: '가위',
      now: NOW,
    });

    expect(result.result).toBe('CHALLENGER_WIN');
    expect(result.challengerBalanceAfter).toBe(STARTING_BALANCE + 950_000);
    expect(result.opponentBalanceAfter).toBe(STARTING_BALANCE - 1_000_000);

    const house = await prisma.house.findUniqueOrThrow({ where: { id: HOUSE_ID } });
    expect(house.balance).toBe(50_000);
  });

  test('OPPONENT_WIN이면 상대는 +0.95배, 챌린저는 -1배를 가져간다', async () => {
    const challengerId = 'rps-resolve-ow-challenger';
    const opponentId = 'rps-resolve-ow-opponent';
    await getOrCreateUser(challengerId);
    await getOrCreateUser(opponentId);

    const result = await resolveRpsChallenge({
      challengerId,
      opponentId,
      betAmount: 1_000_000,
      challengerChoice: '가위',
      opponentChoice: '바위',
      now: NOW,
    });

    expect(result.result).toBe('OPPONENT_WIN');
    expect(result.challengerBalanceAfter).toBe(STARTING_BALANCE - 1_000_000);
    expect(result.opponentBalanceAfter).toBe(STARTING_BALANCE + 950_000);
  });

  test('DRAW면 두 사람 다 원금을 그대로 돌려받고 하우스는 건드리지 않는다', async () => {
    const challengerId = 'rps-resolve-draw-challenger';
    const opponentId = 'rps-resolve-draw-opponent';
    await getOrCreateUser(challengerId);
    await getOrCreateUser(opponentId);

    const result = await resolveRpsChallenge({
      challengerId,
      opponentId,
      betAmount: 1_000_000,
      challengerChoice: '보',
      opponentChoice: '보',
      now: NOW,
    });

    expect(result.result).toBe('DRAW');
    expect(result.challengerBalanceAfter).toBe(STARTING_BALANCE);
    expect(result.opponentBalanceAfter).toBe(STARTING_BALANCE);

    const house = await prisma.house.findUnique({ where: { id: HOUSE_ID } });
    expect(house?.balance ?? 0).toBe(0);
  });

  test('정산 시점에 상대 잔액이 부족해졌으면 무효 처리하고 아무도 차감하지 않는다', async () => {
    const challengerId = 'rps-resolve-late-poor-challenger';
    const opponentId = 'rps-resolve-late-poor-opponent';
    await getOrCreateUser(challengerId);
    await getOrCreateUser(opponentId);

    const betAmount = 1_000_000;
    // 💡 도전 이후 상대방이 다른 곳에 포인트를 다 써서 베팅금보다 잔액이 적어진 상황을 재현한다.
    await prisma.user.update({
      where: { discordId: opponentId },
      data: { balance: betAmount - 1 },
    });

    await expect(
      resolveRpsChallenge({
        challengerId,
        opponentId,
        betAmount,
        challengerChoice: '바위',
        opponentChoice: '가위',
        now: NOW,
      })
    ).rejects.toThrow(InsufficientOpponentBalanceError);

    const challenger = await prisma.user.findUniqueOrThrow({ where: { discordId: challengerId } });
    expect(challenger.balance).toBe(STARTING_BALANCE); // 차감 없음
    // 💡 getOrCreateUser가 만든 INITIAL(시작 포인트 지급) 거래는 있을 수 있지만, RPS 관련
    // 거래(베팅/정산)는 하나도 생기면 안 된다.
    const rpsTxCount = await prisma.transaction.count({
      where: { type: { in: ['RPS_BET', 'RPS_WIN', 'RPS_LOSE', 'RPS_VOID'] } },
    });
    expect(rpsTxCount).toBe(0);
  });

  test('정산 시점에 챌린저 잔액이 부족해졌으면 무효 처리하고 아무도 차감하지 않는다', async () => {
    const challengerId = 'rps-resolve-late-poor-challenger-2';
    const opponentId = 'rps-resolve-late-poor-opponent-2';
    await getOrCreateUser(challengerId);
    await getOrCreateUser(opponentId);

    const betAmount = 1_000_000;
    await prisma.user.update({
      where: { discordId: challengerId },
      data: { balance: betAmount - 1 },
    });

    await expect(
      resolveRpsChallenge({
        challengerId,
        opponentId,
        betAmount,
        challengerChoice: '바위',
        opponentChoice: '가위',
        now: NOW,
      })
    ).rejects.toThrow(BetTooLargeError);

    const opponent = await prisma.user.findUniqueOrThrow({ where: { discordId: opponentId } });
    expect(opponent.balance).toBe(STARTING_BALANCE); // 차감 없음
  });

  test('동시에 같은 챌린저로 두 판을 정산해도 정확히 한 번만 잔액이 반영된다 (원자성)', async () => {
    const challengerId = 'rps-resolve-concurrency-challenger';
    const opponentId1 = 'rps-resolve-concurrency-opponent-1';
    const opponentId2 = 'rps-resolve-concurrency-opponent-2';
    await getOrCreateUser(challengerId);
    await getOrCreateUser(opponentId1);
    await getOrCreateUser(opponentId2);

    const bet = Math.floor(STARTING_BALANCE * 0.25); // 정확히 상한값 - 한 번 차감되면 다음은 상한 초과가 된다
    // 💡 챌린저가 "지는" 시나리오로 만든다 - 이겨서 잔액이 오히려 늘어나면 두 번째 시도도
    // 항상 통과해버려서 원자성(동시성) 검증이 안 되기 때문에, 잔액이 줄어드는 경우로 테스트한다.

    const results = await Promise.allSettled([
      resolveRpsChallenge({
        challengerId,
        opponentId: opponentId1,
        betAmount: bet,
        challengerChoice: '가위',
        opponentChoice: '바위',
        now: NOW,
      }),
      resolveRpsChallenge({
        challengerId,
        opponentId: opponentId2,
        betAmount: bet,
        challengerChoice: '가위',
        opponentChoice: '바위',
        now: NOW,
      }),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const challenger = await prisma.user.findUniqueOrThrow({ where: { discordId: challengerId } });
    // 딱 한 번만 패배 차감됨 (승자는 상대방이므로 챌린저는 베팅금만큼만 줄어든다)
    expect(challenger.balance).toBe(STARTING_BALANCE - bet);
  });
});
