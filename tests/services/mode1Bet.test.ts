import { describe, expect, test } from 'vitest';
import { prisma } from '../../src/db/client';
import { HOUSE_ID } from '../../src/services/house';
import { getOrCreateUser } from '../../src/services/ledger';
import {
  AlreadyJoinedError,
  BetNotClosedError,
  BetNotOpenError,
  closeBet,
  createBet,
  DuplicateOptionLabelError,
  InvalidBetOptionsError,
  InvalidOptionError,
  joinBet,
  NotBetCreatorError,
  settleBet,
} from '../../src/services/mode1Bet';

describe('createBet', () => {
  test('제목/금액/옵션으로 베팅을 OPEN 상태로 생성한다', async () => {
    const bet = await createBet({
      creatorId: 'creator-1',
      title: '오늘 1킬 이상이냐',
      amount: 1_000_000,
      options: ['1킬 이상', '0킬'],
    });

    expect(bet.status).toBe('OPEN');
    expect(bet.amount).toBe(1_000_000);
    expect(bet.options).toHaveLength(2);
    expect(bet.options.map((o) => o.label)).toEqual(['1킬 이상', '0킬']);
  });

  test('옵션이 1개 이하면 거부한다', async () => {
    await expect(
      createBet({ creatorId: 'creator-2', title: 'x', amount: 1_000, options: ['단일옵션'] })
    ).rejects.toThrow(InvalidBetOptionsError);
  });

  test('금액이 0 이하면 거부한다', async () => {
    await expect(
      createBet({ creatorId: 'creator-3', title: 'x', amount: 0, options: ['A', 'B'] })
    ).rejects.toThrow(InvalidBetOptionsError);
  });

  test.each([NaN, 1.5, Infinity, -Infinity])('금액이 %s이면 거부한다', async (amount) => {
    await expect(
      createBet({ creatorId: 'creator-invalid-amount', title: 'x', amount, options: ['A', 'B'] })
    ).rejects.toThrow(InvalidBetOptionsError);
  });

  test('대소문자/공백만 다른 중복 옵션 라벨은 거부한다', async () => {
    await expect(
      createBet({
        creatorId: 'creator-4',
        title: 'x',
        amount: 1_000,
        options: ['팀A', ' 팀a '],
      })
    ).rejects.toThrow(DuplicateOptionLabelError);
  });
});

describe('joinBet', () => {
  test('참가 시 베팅액만큼 즉시 차감되고 BetEntry가 생성된다', async () => {
    const bet = await createBet({
      creatorId: 'creator-5',
      title: '베팅5',
      amount: 1_000_000,
      options: ['A', 'B'],
    });

    const entry = await joinBet({
      betId: bet.id,
      userId: 'joiner-1',
      optionId: bet.options[0].id,
    });

    expect(entry.optionId).toBe(bet.options[0].id);

    const user = await prisma.user.findUniqueOrThrow({ where: { discordId: 'joiner-1' } });
    expect(user.balance).toBe(9_000_000);

    const entries = await prisma.betEntry.findMany({ where: { betId: bet.id } });
    expect(entries).toHaveLength(1);
  });

  test('OPEN 상태가 아닌 베팅에는 참가할 수 없다', async () => {
    const bet = await createBet({
      creatorId: 'creator-6',
      title: '베팅6',
      amount: 1_000_000,
      options: ['A', 'B'],
    });
    await prisma.bet.update({ where: { id: bet.id }, data: { status: 'CLOSED' } });

    await expect(
      joinBet({ betId: bet.id, userId: 'joiner-2', optionId: bet.options[0].id })
    ).rejects.toThrow(BetNotOpenError);
  });

  test('해당 베팅에 속하지 않은 옵션ID로 참가하면 거부한다', async () => {
    const betA = await createBet({
      creatorId: 'creator-7',
      title: '베팅7',
      amount: 1_000_000,
      options: ['A', 'B'],
    });
    const betB = await createBet({
      creatorId: 'creator-8',
      title: '베팅8',
      amount: 1_000_000,
      options: ['C', 'D'],
    });

    await expect(
      joinBet({ betId: betA.id, userId: 'joiner-3', optionId: betB.options[0].id })
    ).rejects.toThrow(InvalidOptionError);
  });

  test('같은 유저가 같은 베팅에 두 번 참가하면 거부하고 잔액·기록은 한 번만 반영된다', async () => {
    const bet = await createBet({
      creatorId: 'creator-9',
      title: '베팅9',
      amount: 1_000_000,
      options: ['A', 'B'],
    });

    await joinBet({ betId: bet.id, userId: 'joiner-4', optionId: bet.options[0].id });

    await expect(
      joinBet({ betId: bet.id, userId: 'joiner-4', optionId: bet.options[1].id })
    ).rejects.toThrow(AlreadyJoinedError);

    const user = await prisma.user.findUniqueOrThrow({ where: { discordId: 'joiner-4' } });
    expect(user.balance).toBe(9_000_000);

    const entries = await prisma.betEntry.findMany({ where: { betId: bet.id } });
    expect(entries).toHaveLength(1);
  });

  test('동시에 중복 참가를 시도해도 차감과 BetEntry 생성은 정확히 한 번만 일어난다', async () => {
    await getOrCreateUser('joiner-5');
    const bet = await createBet({
      creatorId: 'creator-10',
      title: '베팅10',
      amount: 1_000_000,
      options: ['A', 'B'],
    });

    const results = await Promise.allSettled([
      joinBet({ betId: bet.id, userId: 'joiner-5', optionId: bet.options[0].id }),
      joinBet({ betId: bet.id, userId: 'joiner-5', optionId: bet.options[1].id }),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(AlreadyJoinedError);

    const user = await prisma.user.findUniqueOrThrow({ where: { discordId: 'joiner-5' } });
    expect(user.balance).toBe(9_000_000);

    const entries = await prisma.betEntry.findMany({ where: { betId: bet.id, userId: 'joiner-5' } });
    expect(entries).toHaveLength(1);
  });
});

describe('closeBet', () => {
  test('개최자가 닫으면 OPEN에서 CLOSED로 바뀐다', async () => {
    const bet = await createBet({
      creatorId: 'creator-11',
      title: '베팅11',
      amount: 1_000_000,
      options: ['A', 'B'],
    });

    const closed = await closeBet({ betId: bet.id, requestedBy: 'creator-11' });

    expect(closed.status).toBe('CLOSED');
    expect(closed.closedAt).not.toBeNull();
  });

  test('개최자가 아니면 닫을 수 없다', async () => {
    const bet = await createBet({
      creatorId: 'creator-12',
      title: '베팅12',
      amount: 1_000_000,
      options: ['A', 'B'],
    });

    await expect(
      closeBet({ betId: bet.id, requestedBy: 'not-the-creator' })
    ).rejects.toThrow(NotBetCreatorError);

    const bet2 = await prisma.bet.findUniqueOrThrow({ where: { id: bet.id } });
    expect(bet2.status).toBe('OPEN');
  });

  test('이미 CLOSED인 베팅은 다시 닫을 수 없다', async () => {
    const bet = await createBet({
      creatorId: 'creator-13',
      title: '베팅13',
      amount: 1_000_000,
      options: ['A', 'B'],
    });
    await closeBet({ betId: bet.id, requestedBy: 'creator-13' });

    await expect(
      closeBet({ betId: bet.id, requestedBy: 'creator-13' })
    ).rejects.toThrow(BetNotOpenError);
  });
});

describe('settleBet', () => {
  test('CLOSED 상태가 아니면 정산할 수 없다', async () => {
    const bet = await createBet({
      creatorId: 'creator-20',
      title: '베팅20',
      amount: 1_000_000,
      options: ['A', 'B'],
    });

    await expect(
      settleBet({ betId: bet.id, requestedBy: 'creator-20', winningOptionId: bet.options[0].id })
    ).rejects.toThrow(BetNotClosedError);
  });

  test('개최자가 아니면 정산할 수 없다', async () => {
    const bet = await createBet({
      creatorId: 'creator-21',
      title: '베팅21',
      amount: 1_000_000,
      options: ['A', 'B'],
    });
    await closeBet({ betId: bet.id, requestedBy: 'creator-21' });

    await expect(
      settleBet({ betId: bet.id, requestedBy: 'imposter', winningOptionId: bet.options[0].id })
    ).rejects.toThrow(NotBetCreatorError);
  });

  test('베팅에 속하지 않은 옵션ID로 정산하면 거부한다', async () => {
    const betA = await createBet({
      creatorId: 'creator-22',
      title: '베팅22',
      amount: 1_000_000,
      options: ['A', 'B'],
    });
    const betB = await createBet({
      creatorId: 'creator-23',
      title: '베팅23',
      amount: 1_000_000,
      options: ['C', 'D'],
    });
    await closeBet({ betId: betA.id, requestedBy: 'creator-22' });

    await expect(
      settleBet({ betId: betA.id, requestedBy: 'creator-22', winningOptionId: betB.options[0].id })
    ).rejects.toThrow(InvalidOptionError);
  });

  test('전원이 같은 옵션을 선택하면 전원 환불되고 VOID 처리된다', async () => {
    const bet = await createBet({
      creatorId: 'creator-24',
      title: '베팅24',
      amount: 1_000_000,
      options: ['A', 'B'],
    });
    await joinBet({ betId: bet.id, userId: 'p1', optionId: bet.options[0].id });
    await joinBet({ betId: bet.id, userId: 'p2', optionId: bet.options[0].id });
    await closeBet({ betId: bet.id, requestedBy: 'creator-24' });

    const settled = await settleBet({
      betId: bet.id,
      requestedBy: 'creator-24',
      winningOptionId: bet.options[0].id,
    });

    expect(settled.status).toBe('VOID');

    for (const id of ['p1', 'p2']) {
      const user = await prisma.user.findUniqueOrThrow({ where: { discordId: id } });
      expect(user.balance).toBe(10_000_000);
    }

    // 베팅 기록 로그에 쓰일 entryResults: 무효 시 전원 환불액이 기록됨
    expect(settled.entryResults).toHaveLength(2);
    expect(settled.entryResults.every((r) => r.creditedAmount === 1_000_000)).toBe(true);
  });

  test('참가자가 0명이면 환불할 대상 없이 VOID 처리된다', async () => {
    const bet = await createBet({
      creatorId: 'creator-25',
      title: '베팅25',
      amount: 1_000_000,
      options: ['A', 'B'],
    });
    await closeBet({ betId: bet.id, requestedBy: 'creator-25' });

    const settled = await settleBet({
      betId: bet.id,
      requestedBy: 'creator-25',
      winningOptionId: bet.options[0].id,
    });

    expect(settled.status).toBe('VOID');
  });

  test('정답을 고른 사람이 한 명도 없으면(3개 이상 옵션) 전원 환불된다', async () => {
    const bet = await createBet({
      creatorId: 'creator-26',
      title: '베팅26',
      amount: 1_000_000,
      options: ['A', 'B', 'C'],
    });
    await joinBet({ betId: bet.id, userId: 'p3', optionId: bet.options[0].id });
    await joinBet({ betId: bet.id, userId: 'p4', optionId: bet.options[1].id });
    await closeBet({ betId: bet.id, requestedBy: 'creator-26' });

    const settled = await settleBet({
      betId: bet.id,
      requestedBy: 'creator-26',
      winningOptionId: bet.options[2].id, // 아무도 고르지 않은 옵션이 실제 결과
    });

    expect(settled.status).toBe('VOID');
    for (const id of ['p3', 'p4']) {
      const user = await prisma.user.findUniqueOrThrow({ where: { discordId: id } });
      expect(user.balance).toBe(10_000_000);
    }
  });

  test('정답자가 있으면 전체 풀을 정답자 수로 나눠 분배하고, 오답자는 변동이 없다', async () => {
    const bet = await createBet({
      creatorId: 'creator-27',
      title: '베팅27',
      amount: 1_000_000,
      options: ['A', 'B'],
    });
    await joinBet({ betId: bet.id, userId: 'winner1', optionId: bet.options[0].id });
    await joinBet({ betId: bet.id, userId: 'winner2', optionId: bet.options[0].id });
    await joinBet({ betId: bet.id, userId: 'loser1', optionId: bet.options[1].id });
    await joinBet({ betId: bet.id, userId: 'loser2', optionId: bet.options[1].id });
    await closeBet({ betId: bet.id, requestedBy: 'creator-27' });

    const settled = await settleBet({
      betId: bet.id,
      requestedBy: 'creator-27',
      winningOptionId: bet.options[0].id,
    });

    expect(settled.status).toBe('SETTLED');

    // 풀 4,000,000을 승자 2명이 나눔 = 각 2,000,000(원금 1,000,000 + 순수익 1,000,000).
    // 순수익의 5%(50,000)는 세금으로 빠지므로 실수령은 1,950,000.
    // 참가 시 이미 -1,000,000 했으므로 9,000,000 + 1,950,000
    for (const id of ['winner1', 'winner2']) {
      const user = await prisma.user.findUniqueOrThrow({ where: { discordId: id } });
      expect(user.balance).toBe(10_950_000);
    }
    // 오답자는 참가 시 차감된 9,000,000에서 추가 변동 없음
    for (const id of ['loser1', 'loser2']) {
      const user = await prisma.user.findUniqueOrThrow({ where: { discordId: id } });
      expect(user.balance).toBe(9_000_000);
    }

    // 베팅 기록 로그에 쓰일 entryResults: 승자는 세후 실수령액, 패자는 0
    const winner1Result = settled.entryResults.find((r) => r.userId === 'winner1');
    const loser1Result = settled.entryResults.find((r) => r.userId === 'loser1');
    expect(winner1Result?.creditedAmount).toBe(1_950_000);
    expect(loser1Result?.creditedAmount).toBe(0);
    expect(settled.entryResults).toHaveLength(4);

    const house = await prisma.house.findUniqueOrThrow({ where: { id: HOUSE_ID } });
    expect(house.balance).toBe(100_000); // 승자 2명 x 순수익 1,000,000 x 5%
  });

  test('정확히 나누어지지 않으면 나머지를 참가 순서가 빠른 정답자부터 1포인트씩 분배해 풀을 정확히 소진한다', async () => {
    const bet = await createBet({
      creatorId: 'creator-28',
      title: '베팅28',
      amount: 1_000_001, // 의도적으로 홀수
      options: ['A', 'B'],
    });
    await joinBet({ betId: bet.id, userId: 'loser3', optionId: bet.options[0].id });
    await joinBet({ betId: bet.id, userId: 'early-winner', optionId: bet.options[1].id });
    await joinBet({ betId: bet.id, userId: 'late-winner', optionId: bet.options[1].id });
    await closeBet({ betId: bet.id, requestedBy: 'creator-28' });

    await settleBet({
      betId: bet.id,
      requestedBy: 'creator-28',
      winningOptionId: bet.options[1].id,
    });

    // totalPool = 3,000,003, winners 2명 => base 1,500,001, remainder 1
    // 먼저 참가한 승자가 나머지 1포인트를 더 받는다 (세전 지급액: 1,500,002 / 1,500,001)
    // 세전 순수익 = 세전지급액 - 원금(1,000,001) => 500,001 / 500,000, 각 5% 세금 = 25,000 (round)
    // 세후 실수령 = 1,475,002 / 1,475,001
    const earlyWinner = await prisma.user.findUniqueOrThrow({ where: { discordId: 'early-winner' } });
    const lateWinner = await prisma.user.findUniqueOrThrow({ where: { discordId: 'late-winner' } });

    expect(earlyWinner.balance).toBe(10_000_000 - 1_000_001 + 1_475_002);
    expect(lateWinner.balance).toBe(10_000_000 - 1_000_001 + 1_475_001);

    // 지급액 합계 + 세금 합계 = 원래 풀 전체 (포인트 누수/생성 없음)
    const totalPaidToWinners =
      (earlyWinner.balance - (10_000_000 - 1_000_001)) +
      (lateWinner.balance - (10_000_000 - 1_000_001));
    const house = await prisma.house.findUniqueOrThrow({ where: { id: HOUSE_ID } });
    expect(totalPaidToWinners + house.balance).toBe(3_000_003);
    expect(house.balance).toBe(50_000);
  });
});

describe('settleBet - 모드1 베팅세 (5%, 순수익 기준)', () => {
  function sumCreditedAmounts(entryResults: { creditedAmount: number }[]): number {
    return entryResults.reduce((sum, entry) => sum + entry.creditedAmount, 0);
  }

  test('승자 1명: 순수익의 5%만 세금으로 빠지고 나머지를 실수령한다', async () => {
    const bet = await createBet({
      creatorId: 'tax-creator-1',
      title: '세금테스트1',
      amount: 1_000_000,
      options: ['A', 'B'],
    });
    await joinBet({ betId: bet.id, userId: 'tax-winner-1', optionId: bet.options[0].id });
    await joinBet({ betId: bet.id, userId: 'tax-loser-1', optionId: bet.options[1].id });
    await closeBet({ betId: bet.id, requestedBy: 'tax-creator-1' });

    const settled = await settleBet({
      betId: bet.id,
      requestedBy: 'tax-creator-1',
      winningOptionId: bet.options[0].id,
    });

    // totalPool=2,000,000, 승자 1명 => 세전 지급액 2,000,000, 순수익 1,000,000, 세금 50,000
    const winner = await prisma.user.findUniqueOrThrow({ where: { discordId: 'tax-winner-1' } });
    expect(winner.balance).toBe(10_000_000 - 1_000_000 + 1_950_000);

    const house = await prisma.house.findUniqueOrThrow({ where: { id: HOUSE_ID } });
    expect(house.balance).toBe(50_000);

    const winnerResult = settled.entryResults.find((r) => r.userId === 'tax-winner-1');
    expect(winnerResult?.creditedAmount).toBe(1_950_000);

    expect(sumCreditedAmounts(settled.entryResults) + house.balance).toBe(2_000_000);
  });

  test('승자 2명: 각자의 순수익 기준으로 5%씩 세금이 계산된다', async () => {
    const bet = await createBet({
      creatorId: 'tax-creator-2',
      title: '세금테스트2',
      amount: 1_000_000,
      options: ['A', 'B'],
    });
    await joinBet({ betId: bet.id, userId: 'tax-winner-2a', optionId: bet.options[0].id });
    await joinBet({ betId: bet.id, userId: 'tax-winner-2b', optionId: bet.options[0].id });
    await joinBet({ betId: bet.id, userId: 'tax-loser-2a', optionId: bet.options[1].id });
    await joinBet({ betId: bet.id, userId: 'tax-loser-2b', optionId: bet.options[1].id });
    await closeBet({ betId: bet.id, requestedBy: 'tax-creator-2' });

    const settled = await settleBet({
      betId: bet.id,
      requestedBy: 'tax-creator-2',
      winningOptionId: bet.options[0].id,
    });

    // totalPool=4,000,000, 승자 2명 => 세전 지급액 각 2,000,000, 순수익 각 1,000,000, 세금 각 50,000
    for (const id of ['tax-winner-2a', 'tax-winner-2b']) {
      const winner = await prisma.user.findUniqueOrThrow({ where: { discordId: id } });
      expect(winner.balance).toBe(10_000_000 - 1_000_000 + 1_950_000);
    }

    const house = await prisma.house.findUniqueOrThrow({ where: { id: HOUSE_ID } });
    expect(house.balance).toBe(100_000);

    expect(sumCreditedAmounts(settled.entryResults) + house.balance).toBe(4_000_000);
  });

  test('승자 3명: 각자의 순수익 기준으로 5%씩 세금이 계산된다', async () => {
    const bet = await createBet({
      creatorId: 'tax-creator-3',
      title: '세금테스트3',
      amount: 600_000,
      options: ['A', 'B'],
    });
    await joinBet({ betId: bet.id, userId: 'tax-winner-3a', optionId: bet.options[0].id });
    await joinBet({ betId: bet.id, userId: 'tax-winner-3b', optionId: bet.options[0].id });
    await joinBet({ betId: bet.id, userId: 'tax-winner-3c', optionId: bet.options[0].id });
    await joinBet({ betId: bet.id, userId: 'tax-loser-3a', optionId: bet.options[1].id });
    await joinBet({ betId: bet.id, userId: 'tax-loser-3b', optionId: bet.options[1].id });
    await closeBet({ betId: bet.id, requestedBy: 'tax-creator-3' });

    const settled = await settleBet({
      betId: bet.id,
      requestedBy: 'tax-creator-3',
      winningOptionId: bet.options[0].id,
    });

    // totalPool=3,000,000, 승자 3명 => 세전 지급액 각 1,000,000, 순수익 각 400,000, 세금 각 20,000
    for (const id of ['tax-winner-3a', 'tax-winner-3b', 'tax-winner-3c']) {
      const winner = await prisma.user.findUniqueOrThrow({ where: { discordId: id } });
      expect(winner.balance).toBe(10_000_000 - 600_000 + 980_000);
    }

    const house = await prisma.house.findUniqueOrThrow({ where: { id: HOUSE_ID } });
    expect(house.balance).toBe(60_000);

    expect(sumCreditedAmounts(settled.entryResults) + house.balance).toBe(3_000_000);
  });

  test('무효 처리(전원 동일 선택) 시에는 환불일 뿐이라 세금이 발생하지 않는다', async () => {
    const bet = await createBet({
      creatorId: 'tax-void-creator',
      title: '무효세금테스트',
      amount: 1_000_000,
      options: ['A', 'B'],
    });
    await joinBet({ betId: bet.id, userId: 'tax-void-p1', optionId: bet.options[0].id });
    await joinBet({ betId: bet.id, userId: 'tax-void-p2', optionId: bet.options[0].id });
    await closeBet({ betId: bet.id, requestedBy: 'tax-void-creator' });

    const settled = await settleBet({
      betId: bet.id,
      requestedBy: 'tax-void-creator',
      winningOptionId: bet.options[0].id,
    });
    expect(settled.status).toBe('VOID');

    for (const id of ['tax-void-p1', 'tax-void-p2']) {
      const user = await prisma.user.findUniqueOrThrow({ where: { discordId: id } });
      expect(user.balance).toBe(10_000_000); // 환불만, 세금 없음
    }

    const house = await prisma.house.findUnique({ where: { id: HOUSE_ID } });
    expect(house?.balance ?? 0).toBe(0);

    const taxTxs = await prisma.houseTransaction.findMany({ where: { type: 'TAX' } });
    expect(taxTxs).toHaveLength(0);
  });
});
