import { describe, expect, test } from 'vitest';
import { prisma } from '../../src/db/client';
import { gamble, GAMBLE_AMOUNT } from '../../src/services/gamble';
import { HOUSE_ID } from '../../src/services/house';
import { getOrCreateUser } from '../../src/services/ledger';
import { createLoan } from '../../src/services/loan';
import { closeBet, joinBet, settleBet } from '../../src/services/mode1Bet';
import {
  createMode2Bet,
  Mode2BetLimitExceededError,
  placeMode2Bet,
  settleMode2Bet,
} from '../../src/services/mode2Bet';
import { distributionBatch } from '../../src/services/distributionBatch';
import { transferPoints } from '../../src/services/transfer';

const forceWin = () => 0;
const forceLose = () => 0.99;

// createBet()은 이제 UNIFIED 베팅만 만들기 때문에, joinBet/closeBet/settleBet(레거시, 변경 없음)
// 테스트용 레거시 모양 픽스처는 Prisma로 직접 만든다.
async function createLegacyBet(params: {
  creatorId: string;
  title: string;
  amount: number;
  options: string[];
}) {
  return prisma.bet.create({
    data: {
      creatorId: params.creatorId,
      title: params.title,
      amount: params.amount,
      mode: 'LEGACY_MODE1',
      options: { create: params.options.map((label) => ({ label })) },
    },
    include: { options: true },
  });
}

// tests/setup.ts의 beforeEach가 House 테이블을 매번 비우기 때문에, 이 파일의 테스트들은
// 별도로 getOrCreateHouse()/setHouseBalance()를 호출하지 않는다 - "House row가 아예 없는
// 빈 DB에서 처음 실행되는 상황"을 의도적으로 그대로 검증한다.

describe('House row 없이 처음 실행 - 도박', () => {
  test('승리는 House를 건드리지 않으므로 House 없이도 정상 처리된다', async () => {
    const result = await gamble({ discordId: 'fresh-win-1', random: forceWin });

    expect(result.won).toBe(true);
    expect(result.balanceAfter).toBe(10_000_000 + GAMBLE_AMOUNT);
  });

  test('패배해도 크래시하지 않고 House가 자동 생성되며 정상 귀속된다', async () => {
    const result = await gamble({ discordId: 'fresh-lose-1', random: forceLose });

    expect(result.won).toBe(false);
    expect(result.balanceAfter).toBe(10_000_000 - GAMBLE_AMOUNT);

    const user = await prisma.user.findUniqueOrThrow({ where: { discordId: 'fresh-lose-1' } });
    expect(user.balance).toBe(10_000_000 - GAMBLE_AMOUNT);

    const house = await prisma.house.findUniqueOrThrow({ where: { id: HOUSE_ID } });
    expect(house.balance).toBe(GAMBLE_AMOUNT);

    const houseTxs = await prisma.houseTransaction.findMany({ where: { type: 'GAMBLE_LOSE' } });
    expect(houseTxs).toHaveLength(1);
    expect(houseTxs[0].amount).toBe(GAMBLE_AMOUNT);
    expect(houseTxs[0].balanceAfter).toBe(GAMBLE_AMOUNT);
  });
});

describe('House row 없이 처음 실행 - 모드1 베팅', () => {
  test('정산 중 세금 귀속이 House 없이도 정상 처리된다', async () => {
    const bet = await createLegacyBet({
      creatorId: 'fresh-creator-m1',
      title: '모드1베팅X',
      amount: 1_000_000,
      options: ['A', 'B'],
    });
    await joinBet({ betId: bet.id, userId: 'fresh-winner-m1', optionId: bet.options[0].id });
    await joinBet({ betId: bet.id, userId: 'fresh-loser-m1', optionId: bet.options[1].id });
    await closeBet({ betId: bet.id, requestedBy: 'fresh-creator-m1' });

    const settled = await settleBet({
      betId: bet.id,
      requestedBy: 'fresh-creator-m1',
      winningOptionId: bet.options[0].id,
    });
    expect(settled.status).toBe('SETTLED');

    const house = await prisma.house.findUniqueOrThrow({ where: { id: HOUSE_ID } });
    expect(house.balance).toBe(50_000); // 순수익 1,000,000의 5% 세금만

    const houseTxs = await prisma.houseTransaction.findMany({
      where: { description: { contains: '모드1베팅X' } },
    });
    expect(houseTxs).toHaveLength(1);
    expect(houseTxs[0].type).toBe('TAX');
    expect(houseTxs[0].amount).toBe(50_000);
  });
});

describe('House row 없이 처음 실행 - 모드2 베팅', () => {
  test('베팅 참가 한도 체크는 House가 없어도 크래시하지 않고, 잔액 0 기준으로 정상 거부한다', async () => {
    const bet = await createMode2Bet({
      creatorId: 'fresh-creator-1',
      title: 'x',
      sideALabel: 'A',
      sideBLabel: 'B',
    });

    // House가 없으면 한도는 0이므로 양수 금액은 항상 거부된다 - 중요한 건 이 거부가
    // 도메인 에러(Mode2BetLimitExceededError)로 끝나야 한다는 것이지, 미존재 레코드 때문에
    // PrismaClientKnownRequestError(P2025)로 크래시하면 안 된다는 점이다.
    await expect(
      placeMode2Bet({ betId: bet.id, userId: 'fresh-p1', side: 'A', amount: 1 })
    ).rejects.toThrow(Mode2BetLimitExceededError);

    const user = await prisma.user.findUniqueOrThrow({ where: { discordId: 'fresh-p1' } });
    expect(user.balance).toBe(10_000_000);
  });

  test('정산 중 세금 귀속이 House 없이도 정상 처리된다 (반대편 자금 충분 - 부족분 충당 없음)', async () => {
    const bet = await createMode2Bet({
      creatorId: 'fresh-creator-2',
      title: '베팅X',
      sideALabel: 'A',
      sideBLabel: 'B',
    });

    await getOrCreateUser('fresh-winner');
    await getOrCreateUser('fresh-loser');
    // placeMode2Bet은 House 잔액 10%를 한도로 쓰므로, House가 0인 상태에서는 통과할 수 없다.
    // 정산(House 세금 귀속)만 검증하기 위해 참가 기록을 직접 만든다 (기존 settleMode2Bet
    // 원자성 테스트(mode2Bet.test.ts (c))와 동일한 방식).
    await prisma.mode2Entry.create({
      data: { betId: bet.id, userId: 'fresh-winner', side: 'A', amount: 1_000_000 },
    });
    await prisma.mode2Entry.create({
      data: { betId: bet.id, userId: 'fresh-loser', side: 'B', amount: 2_000_000 },
    });
    await prisma.mode2Bet.update({ where: { id: bet.id }, data: { status: 'CLOSED' } });

    const settled = await settleMode2Bet({ betId: bet.id, requestedBy: 'fresh-creator-2', winningSide: 'A' });
    expect(settled.status).toBe('SETTLED');

    const house = await prisma.house.findUniqueOrThrow({ where: { id: HOUSE_ID } });
    expect(house.balance).toBe(50_000); // 순수익 1,000,000의 5% 세금만

    const houseTxs = await prisma.houseTransaction.findMany({ where: { description: { contains: '베팅X' } } });
    expect(houseTxs).toHaveLength(1);
    expect(houseTxs[0].type).toBe('TAX');
    expect(houseTxs[0].amount).toBe(50_000);
  });
});

describe('House row 없이 처음 실행 - 대출', () => {
  test('대출 개설 수수료가 House 없이도 정상 귀속된다', async () => {
    await getOrCreateUser('fresh-lender');
    await getOrCreateUser('fresh-borrower');

    await createLoan({ lenderId: 'fresh-lender', borrowerId: 'fresh-borrower', principal: 1_000_000 });

    const house = await prisma.house.findUniqueOrThrow({ where: { id: HOUSE_ID } });
    expect(house.balance).toBe(20_000); // 2% 개설 수수료

    const houseTxs = await prisma.houseTransaction.findMany({ where: { type: 'LOAN' } });
    expect(houseTxs).toHaveLength(1);
    expect(houseTxs[0].amount).toBe(20_000);
  });
});

describe('House row 없이 처음 실행 - 양도', () => {
  test('양도 수수료가 House 없이도 정상 귀속된다', async () => {
    await getOrCreateUser('fresh-sender');
    await getOrCreateUser('fresh-recipient');

    await transferPoints({ senderId: 'fresh-sender', recipientId: 'fresh-recipient', amount: 1_000_000 });

    const house = await prisma.house.findUniqueOrThrow({ where: { id: HOUSE_ID } });
    expect(house.balance).toBe(50_000); // 5% 양도 수수료

    const houseTxs = await prisma.houseTransaction.findMany({ where: { type: 'TRANSFER' } });
    expect(houseTxs).toHaveLength(1);
    expect(houseTxs[0].amount).toBe(50_000);
  });
});

describe('House row 없이 처음 실행 - 환급/쿠폰 배치', () => {
  test('유저도 House도 전혀 없는 완전히 빈 DB에서 호출해도 크래시하지 않는다', async () => {
    const result = await distributionBatch();

    expect(result.distributed).toBe(false);
    expect(result.couponsIssued).toBe(0);

    const house = await prisma.house.findUniqueOrThrow({ where: { id: HOUSE_ID } });
    expect(house.balance).toBe(0);
  });
});
