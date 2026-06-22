import { describe, expect, test } from 'vitest';
import { prisma } from '../../src/db/client';
import { InvalidBetOptionsError } from '../../src/services/betShared';
import { applyHouseTransaction, getOrCreateHouse, HOUSE_ID } from '../../src/services/house';
import {
  AlreadyJoinedError,
  BetNotOpenError,
  closeMode2Bet,
  createMode2Bet,
  Mode2BetLimitExceededError,
  placeMode2Bet,
  settleMode2Bet,
} from '../../src/services/mode2Bet';

async function setHouseBalance(amount: number) {
  await getOrCreateHouse();
  await prisma.$transaction((tx) =>
    applyHouseTransaction(tx, { type: 'TAX', amount, description: 'test setup' })
  );
}

describe('createMode2Bet', () => {
  test('제목/양쪽 옵션으로 OPEN 상태 베팅을 생성한다', async () => {
    const bet = await createMode2Bet({
      creatorId: 'creator-1',
      title: '오늘 이길까',
      sideALabel: '성공',
      sideBLabel: '실패',
    });

    expect(bet.status).toBe('OPEN');
    expect(bet.sideALabel).toBe('성공');
    expect(bet.sideBLabel).toBe('실패');
  });

  test('양쪽 옵션 라벨이 대소문자/공백만 다르고 같으면 거부한다', async () => {
    await expect(
      createMode2Bet({
        creatorId: 'creator-2',
        title: 'x',
        sideALabel: '성공',
        sideBLabel: ' 성공 ',
      })
    ).rejects.toThrow(InvalidBetOptionsError);
  });
});

describe('closeMode2Bet', () => {
  test('개최자가 닫으면 OPEN에서 CLOSED로 바뀐다', async () => {
    const bet = await createMode2Bet({
      creatorId: 'creator-3',
      title: 'x',
      sideALabel: 'A',
      sideBLabel: 'B',
    });

    const closed = await closeMode2Bet({ betId: bet.id, requestedBy: 'creator-3' });
    expect(closed.status).toBe('CLOSED');
  });
});

describe('placeMode2Bet', () => {
  test('하우스 잔액의 10% 이하 금액은 참가 가능하고 즉시 차감된다', async () => {
    await setHouseBalance(10_000_000); // 한도 1,000,000
    const bet = await createMode2Bet({
      creatorId: 'creator-4',
      title: 'x',
      sideALabel: 'A',
      sideBLabel: 'B',
    });

    const entry = await placeMode2Bet({ betId: bet.id, userId: 'p1', side: 'A', amount: 1_000_000 });
    expect(entry.amount).toBe(1_000_000);

    const user = await prisma.user.findUniqueOrThrow({ where: { discordId: 'p1' } });
    expect(user.balance).toBe(9_000_000);
  });

  test.each([NaN, -5, 0, 1.5, Infinity, -Infinity])(
    '비정상 금액(%s)은 모달 검증을 우회해 직접 들어와도 서비스 레이어에서 거부하고 잔액이 변하지 않는다',
    async (amount) => {
      await setHouseBalance(10_000_000);
      const bet = await createMode2Bet({
        creatorId: 'creator-invalid-amount',
        title: 'x',
        sideALabel: 'A',
        sideBLabel: 'B',
      });

      await expect(
        placeMode2Bet({ betId: bet.id, userId: 'p-invalid', side: 'A', amount })
      ).rejects.toThrow(InvalidBetOptionsError);

      const entries = await prisma.mode2Entry.findMany({ where: { betId: bet.id } });
      expect(entries).toHaveLength(0);
    }
  );

  test('한도(하우스 잔액 ×10%)를 초과하면 거부되고 잔액은 변하지 않는다', async () => {
    await setHouseBalance(10_000_000); // 한도 1,000,000
    const bet = await createMode2Bet({
      creatorId: 'creator-5',
      title: 'x',
      sideALabel: 'A',
      sideBLabel: 'B',
    });

    await expect(
      placeMode2Bet({ betId: bet.id, userId: 'p2', side: 'A', amount: 1_000_001 })
    ).rejects.toThrow(Mode2BetLimitExceededError);

    const user = await prisma.user.findUniqueOrThrow({ where: { discordId: 'p2' } });
    expect(user.balance).toBe(10_000_000);
  });

  test('OPEN 상태가 아니면 참가할 수 없다', async () => {
    await setHouseBalance(10_000_000);
    const bet = await createMode2Bet({
      creatorId: 'creator-6',
      title: 'x',
      sideALabel: 'A',
      sideBLabel: 'B',
    });
    await closeMode2Bet({ betId: bet.id, requestedBy: 'creator-6' });

    await expect(
      placeMode2Bet({ betId: bet.id, userId: 'p3', side: 'A', amount: 100 })
    ).rejects.toThrow(BetNotOpenError);
  });

  test('같은 유저가 같은 베팅에 두 번 참가하면 거부된다', async () => {
    await setHouseBalance(10_000_000);
    const bet = await createMode2Bet({
      creatorId: 'creator-7',
      title: 'x',
      sideALabel: 'A',
      sideBLabel: 'B',
    });
    await placeMode2Bet({ betId: bet.id, userId: 'p4', side: 'A', amount: 100 });

    await expect(
      placeMode2Bet({ betId: bet.id, userId: 'p4', side: 'B', amount: 100 })
    ).rejects.toThrow(AlreadyJoinedError);
  });

  test('한도 체크는 항상 최신 하우스 잔액을 기준으로 한다 (동시에 하우스 잔액이 줄어드는 상황 시뮬레이션)', async () => {
    await setHouseBalance(10_000_000); // 초기 한도 1,000,000
    const bet = await createMode2Bet({
      creatorId: 'creator-8',
      title: 'x',
      sideALabel: 'A',
      sideBLabel: 'B',
    });

    const results = await Promise.allSettled([
      placeMode2Bet({ betId: bet.id, userId: 'racer-1', side: 'A', amount: 1_000_000 }),
      prisma.$transaction((tx) =>
        applyHouseTransaction(tx, {
          type: 'BET',
          amount: -9_000_000,
          description: '하우스 손실 시뮬레이션 (동시성 테스트)',
        })
      ),
    ]);

    const houseAfter = await prisma.house.findUniqueOrThrow({ where: { id: HOUSE_ID } });
    expect(houseAfter.balance).toBe(1_000_000);

    const betResult = results[0];
    const racer1 = await prisma.user.findUniqueOrThrow({ where: { discordId: 'racer-1' } });

    if (betResult.status === 'fulfilled') {
      // 베팅 트랜잭션이 하우스 차감보다 먼저 커밋된 경우: 그 시점 잔액(10,000,000) 기준 유효
      expect(racer1.balance).toBe(9_000_000);
    } else {
      // 베팅 트랜잭션이 하우스 차감보다 나중에 커밋된 경우: 줄어든 잔액(1,000,000, 한도 100,000) 기준 거부
      expect(betResult.reason).toBeInstanceOf(Mode2BetLimitExceededError);
      expect(racer1.balance).toBe(10_000_000);
    }
  });
});

describe('settleMode2Bet', () => {
  test('(a) 반대편 자금이 충분하면 하우스는 세금만 받고 부족분 충당은 없다', async () => {
    await setHouseBalance(50_000_000); // 한도 5,000,000
    const bet = await createMode2Bet({
      creatorId: 'creator-9',
      title: '베팅A',
      sideALabel: '성공',
      sideBLabel: '실패',
    });
    await placeMode2Bet({ betId: bet.id, userId: 'winnerA', side: 'A', amount: 1_000_000 });
    await placeMode2Bet({ betId: bet.id, userId: 'loserA', side: 'B', amount: 2_000_000 });
    await closeMode2Bet({ betId: bet.id, requestedBy: 'creator-9' });

    const houseBefore = await prisma.house.findUniqueOrThrow({ where: { id: HOUSE_ID } });

    const settled = await settleMode2Bet({ betId: bet.id, requestedBy: 'creator-9', winningSide: 'A' });
    expect(settled.status).toBe('SETTLED');

    const winner = await prisma.user.findUniqueOrThrow({ where: { discordId: 'winnerA' } });
    // 1,000,000(원금) + 950,000(순수익, 5% 세금 제외) = 1,950,000 추가 / 시작 10,000,000 - 1,000,000(참가비) + 1,950,000
    expect(winner.balance).toBe(10_000_000 - 1_000_000 + 1_950_000);

    const loser = await prisma.user.findUniqueOrThrow({ where: { discordId: 'loserA' } });
    expect(loser.balance).toBe(10_000_000 - 2_000_000); // 변동 없음

    const houseAfter = await prisma.house.findUniqueOrThrow({ where: { id: HOUSE_ID } });
    expect(houseAfter.balance - houseBefore.balance).toBe(50_000); // 세금만 +50,000

    const houseTxs = await prisma.houseTransaction.findMany({ where: { description: { contains: '베팅A' } } });
    expect(houseTxs).toHaveLength(1);
    expect(houseTxs[0].type).toBe('TAX');
    expect(houseTxs[0].amount).toBe(50_000);

    // 베팅 기록 로그에 쓰일 entryResults: 승자는 지급액, 패자는 0
    const winnerResult = settled.entryResults.find((r) => r.userId === 'winnerA');
    const loserResult = settled.entryResults.find((r) => r.userId === 'loserA');
    expect(winnerResult?.creditedAmount).toBe(1_950_000);
    expect(loserResult?.creditedAmount).toBe(0);
  });

  test('(b) 반대편 자금이 부족하면 하우스가 부족분을 메우면서 동시에 세금도 받는다', async () => {
    await setHouseBalance(50_000_000); // 한도 5,000,000
    const bet = await createMode2Bet({
      creatorId: 'creator-10',
      title: '베팅B',
      sideALabel: '성공',
      sideBLabel: '실패',
    });
    await placeMode2Bet({ betId: bet.id, userId: 'winnerB', side: 'A', amount: 2_000_000 });
    await placeMode2Bet({ betId: bet.id, userId: 'loserB', side: 'B', amount: 500_000 });
    await closeMode2Bet({ betId: bet.id, requestedBy: 'creator-10' });

    const houseBefore = await prisma.house.findUniqueOrThrow({ where: { id: HOUSE_ID } });

    const settled = await settleMode2Bet({ betId: bet.id, requestedBy: 'creator-10', winningSide: 'A' });
    expect(settled.status).toBe('SETTLED');

    const winner = await prisma.user.findUniqueOrThrow({ where: { discordId: 'winnerB' } });
    // 순수익 2,000,000의 5%=100,000 세금, 순수익 1,900,000 + 원금 2,000,000 = 3,900,000 수령
    expect(winner.balance).toBe(10_000_000 - 2_000_000 + 3_900_000);

    const houseAfter = await prisma.house.findUniqueOrThrow({ where: { id: HOUSE_ID } });
    // 부족분 1,500,000(=2,000,000-500,000) 차감 + 세금 100,000 수취 = 순변동 -1,400,000
    expect(houseAfter.balance - houseBefore.balance).toBe(-1_400_000);

    const houseTxs = await prisma.houseTransaction.findMany({
      where: { description: { contains: '베팅B' } },
      orderBy: { id: 'asc' },
    });
    expect(houseTxs).toHaveLength(2);
    expect(houseTxs[0].type).toBe('BET');
    expect(houseTxs[0].amount).toBe(-1_500_000);
    expect(houseTxs[1].type).toBe('TAX');
    expect(houseTxs[1].amount).toBe(100_000);
  });

  test('(c) 승자가 여러 명일 때 마지막 한 명 처리 중 실패하면 앞의 변경분까지 전부 롤백된다', async () => {
    await setHouseBalance(50_000_000);
    const bet = await createMode2Bet({
      creatorId: 'creator-11',
      title: '베팅C',
      sideALabel: '성공',
      sideBLabel: '실패',
    });
    await placeMode2Bet({ betId: bet.id, userId: 'winnerC1', side: 'A', amount: 1_000_000 });
    await placeMode2Bet({ betId: bet.id, userId: 'winnerC2', side: 'A', amount: 1_000_000 });
    // winnerC3-ghost는 User로 등록된 적이 없는 상태로 Mode2Entry만 직접 만들어
    // (joinedAt이 가장 늦으므로 정산 시 마지막으로 처리됨) 처리 중 실패를 강제로 유도한다.
    await prisma.mode2Entry.create({
      data: { betId: bet.id, userId: 'winnerC3-ghost', side: 'A', amount: 1_000_000 },
    });
    await placeMode2Bet({ betId: bet.id, userId: 'loserC', side: 'B', amount: 4_000_000 });
    await closeMode2Bet({ betId: bet.id, requestedBy: 'creator-11' });

    const houseBefore = await prisma.house.findUniqueOrThrow({ where: { id: HOUSE_ID } });

    await expect(
      settleMode2Bet({ betId: bet.id, requestedBy: 'creator-11', winningSide: 'A' })
    ).rejects.toThrow();

    const winner1 = await prisma.user.findUniqueOrThrow({ where: { discordId: 'winnerC1' } });
    const winner2 = await prisma.user.findUniqueOrThrow({ where: { discordId: 'winnerC2' } });
    expect(winner1.balance).toBe(10_000_000 - 1_000_000); // 정산 전 그대로
    expect(winner2.balance).toBe(10_000_000 - 1_000_000); // 정산 전 그대로

    const houseAfter = await prisma.house.findUniqueOrThrow({ where: { id: HOUSE_ID } });
    expect(houseAfter.balance).toBe(houseBefore.balance); // 세금도 걷히지 않음

    const betAfter = await prisma.mode2Bet.findUniqueOrThrow({ where: { id: bet.id } });
    expect(betAfter.status).toBe('CLOSED'); // SETTLED로 바뀌지 않음
  });
});
