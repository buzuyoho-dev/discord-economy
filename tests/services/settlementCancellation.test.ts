import { describe, expect, test } from 'vitest';
import { prisma } from '../../src/db/client';
import { NotAdminError } from '../../src/services/adminGrant';
import { BetNotFoundError, BetNotSettledError } from '../../src/services/betShared';
import { applyHouseTransaction, getOrCreateHouse, HOUSE_ID } from '../../src/services/house';
import { STARTING_BALANCE } from '../../src/services/ledger';
import { closeBet, createBet, joinBet, settleBet } from '../../src/services/mode1Bet';
import {
  closeMode2Bet,
  createMode2Bet,
  placeMode2Bet,
  settleMode2Bet,
} from '../../src/services/mode2Bet';
import { cancelSettlement, previewSettlementCancellation } from '../../src/services/settlementCancellation';

const ADMIN_ID = 'admin-1';

async function setHouseBalance(amount: number) {
  await getOrCreateHouse();
  await prisma.$transaction((tx) =>
    applyHouseTransaction(tx, { type: 'TAX', amount, description: 'test setup' })
  );
}

async function createSettledMode1Bet(prefix: string) {
  const bet = await createBet({
    creatorId: `${prefix}-creator`,
    title: `${prefix}-title`,
    amount: 1_000_000,
    options: ['A', 'B'],
  });
  await joinBet({ betId: bet.id, userId: `${prefix}-winner`, optionId: bet.options[0].id });
  await joinBet({ betId: bet.id, userId: `${prefix}-loser`, optionId: bet.options[1].id });
  await closeBet({ betId: bet.id, requestedBy: `${prefix}-creator` });
  await settleBet({ betId: bet.id, requestedBy: `${prefix}-creator`, winningOptionId: bet.options[0].id });
  return bet;
}

describe('previewSettlementCancellation / cancelSettlement - 공통 검증', () => {
  test('관리자가 아니면 거부한다', async () => {
    const bet = await createSettledMode1Bet('perm');

    await expect(
      previewSettlementCancellation({ betId: bet.id, requestedBy: 'not-admin', adminDiscordId: ADMIN_ID })
    ).rejects.toThrow(NotAdminError);

    await expect(
      cancelSettlement({ betId: bet.id, requestedBy: 'not-admin', adminDiscordId: ADMIN_ID })
    ).rejects.toThrow(NotAdminError);
  });

  test('존재하지 않는 베팅ID는 거부한다', async () => {
    await expect(
      previewSettlementCancellation({ betId: 999_999, requestedBy: ADMIN_ID, adminDiscordId: ADMIN_ID })
    ).rejects.toThrow(BetNotFoundError);
  });

  test('정산되지 않은 모드1 베팅(OPEN)에 시도하면 거부한다', async () => {
    const bet = await createBet({
      creatorId: 'open-creator',
      title: 'open-title',
      amount: 1_000_000,
      options: ['A', 'B'],
    });

    await expect(
      previewSettlementCancellation({ betId: bet.id, requestedBy: ADMIN_ID, adminDiscordId: ADMIN_ID })
    ).rejects.toThrow(BetNotSettledError);
  });

  test('정산되지 않은 모드1 베팅(CLOSED)에 시도하면 거부한다', async () => {
    const bet = await createBet({
      creatorId: 'closed-creator',
      title: 'closed-title',
      amount: 1_000_000,
      options: ['A', 'B'],
    });
    await closeBet({ betId: bet.id, requestedBy: 'closed-creator' });

    await expect(
      cancelSettlement({ betId: bet.id, requestedBy: ADMIN_ID, adminDiscordId: ADMIN_ID })
    ).rejects.toThrow(BetNotSettledError);
  });

  test('정산되지 않은 모드2 베팅에 시도하면 거부한다', async () => {
    const bet = await createMode2Bet({
      creatorId: 'm2-open-creator',
      title: 'm2-open-title',
      sideALabel: 'A',
      sideBLabel: 'B',
    });

    await expect(
      previewSettlementCancellation({ betId: bet.id, requestedBy: ADMIN_ID, adminDiscordId: ADMIN_ID })
    ).rejects.toThrow(BetNotSettledError);
  });
});

describe('cancelSettlement - 모드1', () => {
  test('승자에게 지급된 순수익과 하우스 세금을 정확히 상쇄하고 CLOSED로 되돌린다', async () => {
    const bet = await createBet({
      creatorId: 'm1-creator',
      title: 'm1-title',
      amount: 1_000_000,
      options: ['A', 'B'],
    });
    await joinBet({ betId: bet.id, userId: 'm1-winner', optionId: bet.options[0].id });
    await joinBet({ betId: bet.id, userId: 'm1-loser', optionId: bet.options[1].id });
    await closeBet({ betId: bet.id, requestedBy: 'm1-creator' });
    await settleBet({ betId: bet.id, requestedBy: 'm1-creator', winningOptionId: bet.options[0].id });

    // totalPool=2,000,000, 승자 1명 -> 세전 지급 2,000,000, 순수익 1,000,000, 세금 50,000, 순지급 1,950,000
    const winnerAfterSettle = await prisma.user.findUniqueOrThrow({ where: { discordId: 'm1-winner' } });
    expect(winnerAfterSettle.balance).toBe(STARTING_BALANCE - 1_000_000 + 1_950_000);
    const houseAfterSettle = await prisma.house.findUniqueOrThrow({ where: { id: HOUSE_ID } });
    expect(houseAfterSettle.balance).toBe(50_000);

    const preview = await previewSettlementCancellation({
      betId: bet.id,
      requestedBy: ADMIN_ID,
      adminDiscordId: ADMIN_ID,
    });
    expect(preview.mode).toBe(1);
    expect(preview.corrections).toEqual([{ userId: 'm1-winner', amount: -1_950_000 }]);
    expect(preview.houseDelta).toBe(-50_000);

    const result = await cancelSettlement({ betId: bet.id, requestedBy: ADMIN_ID, adminDiscordId: ADMIN_ID });
    expect(result).toEqual(preview);

    const winnerAfterCancel = await prisma.user.findUniqueOrThrow({ where: { discordId: 'm1-winner' } });
    expect(winnerAfterCancel.balance).toBe(STARTING_BALANCE - 1_000_000); // 참가비 차감만 남음, 정산 전과 동일

    const houseAfterCancel = await prisma.house.findUniqueOrThrow({ where: { id: HOUSE_ID } });
    expect(houseAfterCancel.balance).toBe(0); // 세금 전액 반환

    const betAfter = await prisma.bet.findUniqueOrThrow({ where: { id: bet.id } });
    expect(betAfter.status).toBe('CLOSED');
    expect(betAfter.winningOptionId).toBeNull();
    expect(betAfter.settledAt).toBeNull();

    const corrections = await prisma.transaction.findMany({
      where: { userId: 'm1-winner', type: 'SETTLEMENT_CORRECTION' },
    });
    expect(corrections).toHaveLength(1);
    expect(corrections[0].amount).toBe(-1_950_000);
  });
});

describe('cancelSettlement - 모드2', () => {
  test('부족분 충당 + 세금을 모두 상쇄한다 (반대편 자금 부족 케이스)', async () => {
    await setHouseBalance(50_000_000);
    const bet = await createMode2Bet({
      creatorId: 'm2-creator',
      title: 'm2-title',
      sideALabel: '성공',
      sideBLabel: '실패',
    });
    await placeMode2Bet({ betId: bet.id, userId: 'm2-winner', side: 'A', amount: 4_000_000 });
    await placeMode2Bet({ betId: bet.id, userId: 'm2-loser', side: 'B', amount: 1_000_000 });
    await closeMode2Bet({ betId: bet.id, requestedBy: 'm2-creator' });
    await settleMode2Bet({ betId: bet.id, requestedBy: 'm2-creator', winningSide: 'A' });

    // profit=4,000,000, tax=200,000, netProfit=3,800,000, payout=4,000,000+3,800,000=7,800,000
    // loserPool=1,000,000 < profitOwed(4,000,000) -> shortfall=3,000,000
    const winnerAfterSettle = await prisma.user.findUniqueOrThrow({ where: { discordId: 'm2-winner' } });
    expect(winnerAfterSettle.balance).toBe(STARTING_BALANCE - 4_000_000 + 7_800_000);
    const houseAfterSettle = await prisma.house.findUniqueOrThrow({ where: { id: HOUSE_ID } });
    expect(houseAfterSettle.balance).toBe(50_000_000 - 3_000_000 + 200_000);

    const preview = await previewSettlementCancellation({
      betId: bet.id,
      requestedBy: ADMIN_ID,
      adminDiscordId: ADMIN_ID,
    });
    expect(preview.mode).toBe(2);
    expect(preview.corrections).toEqual([{ userId: 'm2-winner', amount: -7_800_000 }]);
    expect(preview.houseDelta).toBe(3_000_000 - 200_000); // 부족분 환수 - 세금 반환

    await cancelSettlement({ betId: bet.id, requestedBy: ADMIN_ID, adminDiscordId: ADMIN_ID });

    const winnerAfterCancel = await prisma.user.findUniqueOrThrow({ where: { discordId: 'm2-winner' } });
    expect(winnerAfterCancel.balance).toBe(STARTING_BALANCE - 4_000_000); // 정산 전과 동일

    const houseAfterCancel = await prisma.house.findUniqueOrThrow({ where: { id: HOUSE_ID } });
    expect(houseAfterCancel.balance).toBe(50_000_000); // 정산 전과 동일

    const betAfter = await prisma.mode2Bet.findUniqueOrThrow({ where: { id: bet.id } });
    expect(betAfter.status).toBe('CLOSED');
    expect(betAfter.winningSide).toBeNull();
    expect(betAfter.settledAt).toBeNull();
  });
});

describe('cancelSettlement - preview만 호출했을 때는 아무 변경이 없다', () => {
  test('preview 호출 후에도 잔액/하우스/거래 기록이 그대로다', async () => {
    const bet = await createSettledMode1Bet('preview-only');

    const winnerBefore = await prisma.user.findUniqueOrThrow({ where: { discordId: 'preview-only-winner' } });
    const houseBefore = await prisma.house.findUniqueOrThrow({ where: { id: HOUSE_ID } });
    const txCountBefore = await prisma.transaction.count();

    await previewSettlementCancellation({ betId: bet.id, requestedBy: ADMIN_ID, adminDiscordId: ADMIN_ID });

    const winnerAfter = await prisma.user.findUniqueOrThrow({ where: { discordId: 'preview-only-winner' } });
    const houseAfter = await prisma.house.findUniqueOrThrow({ where: { id: HOUSE_ID } });
    const txCountAfter = await prisma.transaction.count();

    expect(winnerAfter.balance).toBe(winnerBefore.balance);
    expect(houseAfter.balance).toBe(houseBefore.balance);
    expect(txCountAfter).toBe(txCountBefore);

    const betAfter = await prisma.bet.findUniqueOrThrow({ where: { id: bet.id } });
    expect(betAfter.status).toBe('SETTLED'); // 그대로
  });
});

describe('cancelSettlement - 원자성', () => {
  test('참가자 처리 중 하나가 실패하면 전부 롤백된다', async () => {
    const bet = await createBet({
      creatorId: 'atomic-creator',
      title: 'atomic-title',
      amount: 1_000_000,
      options: ['A', 'B'],
    });
    // 승자 2명(참가 순서: winner-1, winner-2) + 패자 1명
    await joinBet({ betId: bet.id, userId: 'atomic-winner-1', optionId: bet.options[0].id });
    await joinBet({ betId: bet.id, userId: 'atomic-winner-2', optionId: bet.options[0].id });
    await joinBet({ betId: bet.id, userId: 'atomic-loser', optionId: bet.options[1].id });
    await closeBet({ betId: bet.id, requestedBy: 'atomic-creator' });
    await settleBet({ betId: bet.id, requestedBy: 'atomic-creator', winningOptionId: bet.options[0].id });

    // winner-2가 정산으로 받은 돈을 이미 다 써버린 상황을 시뮬레이션 - 정산취소로 환수하려 하면
    // 잔액이 마이너스가 되어 InsufficientBalanceError로 winner-1 처리 이후(두 번째 순서) 실패해야 한다.
    await prisma.user.update({ where: { discordId: 'atomic-winner-2' }, data: { balance: 0 } });

    const winner1Before = await prisma.user.findUniqueOrThrow({ where: { discordId: 'atomic-winner-1' } });
    const houseBefore = await prisma.house.findUniqueOrThrow({ where: { id: HOUSE_ID } });

    await expect(
      cancelSettlement({ betId: bet.id, requestedBy: ADMIN_ID, adminDiscordId: ADMIN_ID })
    ).rejects.toThrow();

    const winner1After = await prisma.user.findUniqueOrThrow({ where: { discordId: 'atomic-winner-1' } });
    expect(winner1After.balance).toBe(winner1Before.balance); // 롤백됨

    const houseAfter = await prisma.house.findUniqueOrThrow({ where: { id: HOUSE_ID } });
    expect(houseAfter.balance).toBe(houseBefore.balance); // 롤백됨

    const betAfter = await prisma.bet.findUniqueOrThrow({ where: { id: bet.id } });
    expect(betAfter.status).toBe('SETTLED'); // 그대로 (CLOSED로 안 바뀜)
  });
});

describe('cancelSettlement - 재정산 흐름', () => {
  test('정산취소 후 settleBet으로 다시 정산할 수 있다', async () => {
    const bet = await createBet({
      creatorId: 'resettle-creator',
      title: 'resettle-title',
      amount: 1_000_000,
      options: ['A', 'B'],
    });
    await joinBet({ betId: bet.id, userId: 'resettle-a', optionId: bet.options[0].id });
    await joinBet({ betId: bet.id, userId: 'resettle-b', optionId: bet.options[1].id });
    await closeBet({ betId: bet.id, requestedBy: 'resettle-creator' });
    await settleBet({ betId: bet.id, requestedBy: 'resettle-creator', winningOptionId: bet.options[0].id });

    await cancelSettlement({ betId: bet.id, requestedBy: ADMIN_ID, adminDiscordId: ADMIN_ID });

    // 정답을 B로 바꿔 재정산
    const resettled = await settleBet({
      betId: bet.id,
      requestedBy: 'resettle-creator',
      winningOptionId: bet.options[1].id,
    });
    expect(resettled.status).toBe('SETTLED');

    const winnerB = await prisma.user.findUniqueOrThrow({ where: { discordId: 'resettle-b' } });
    // totalPool=2,000,000, 세전 지급 2,000,000, 순수익 1,000,000, 세금 50,000, 순지급 1,950,000
    expect(winnerB.balance).toBe(STARTING_BALANCE - 1_000_000 + 1_950_000);

    const winnerA = await prisma.user.findUniqueOrThrow({ where: { discordId: 'resettle-a' } });
    expect(winnerA.balance).toBe(STARTING_BALANCE - 1_000_000); // 참가비만 차감, 이번엔 패자
  });

  test('이미 정산취소된(CLOSED로 돌아간) 베팅에 다시 정산취소를 시도하면 거부한다', async () => {
    const bet = await createSettledMode1Bet('double-cancel');

    await cancelSettlement({ betId: bet.id, requestedBy: ADMIN_ID, adminDiscordId: ADMIN_ID });

    await expect(
      cancelSettlement({ betId: bet.id, requestedBy: ADMIN_ID, adminDiscordId: ADMIN_ID })
    ).rejects.toThrow(BetNotSettledError);
  });
});
