import { LotteryDrawSource, TransactionType } from '@prisma/client';
import { describe, expect, test } from 'vitest';
import { prisma } from '../../src/db/client';
import { HOUSE_ID } from '../../src/services/house';
import { getOrCreateUser } from '../../src/services/ledger';
import { LOTTERY_TICKET_PRICE, purchaseLottery } from '../../src/services/lottery';
import { runLotteryDraw } from '../../src/services/lotteryDraw';

// 2026-07-01 KST 날짜의 회차 식별자
const DRAW_DATE = new Date('2026-07-01T00:00:00.000Z');
// 정오 이전 KST → drawDate = DRAW_DATE
const BUY_TIME = new Date('2026-07-01T02:00:00.000Z');

async function buyTicket(discordId: string, chosenNumber: number) {
  await getOrCreateUser(discordId);
  await purchaseLottery({ discordId, chosenNumber, now: BUY_TIME });
}

describe('runLotteryDraw - 참여자 0명', () => {
  test('티켓이 없으면 아무것도 변하지 않는다 (풀 = 0, 잭팟 유지)', async () => {
    const result = await runLotteryDraw({ drawDate: DRAW_DATE, pickNumber: () => 7 });

    expect(result.ticketCount).toBe(0);
    expect(result.totalPool).toBe(0);
    expect(result.winners).toHaveLength(0);
    expect(result.carriedOver).toBe(0);

    const state = await prisma.lotteryState.findUnique({ where: { id: 1 } });
    expect(state?.currentJackpot ?? 0).toBe(0);

    const houseTxs = await prisma.houseTransaction.findMany({
      where: { type: TransactionType.LOTTERY_TAX },
    });
    expect(houseTxs).toHaveLength(0);
  });
});

describe('runLotteryDraw - 당첨자 없음', () => {
  test('당첨 번호를 맞춘 사람이 없으면 총 풀이 잭팟으로 이월되고 세금은 없다', async () => {
    await buyTicket('d-no-1', 3);
    await buyTicket('d-no-2', 5);

    const result = await runLotteryDraw({ drawDate: DRAW_DATE, pickNumber: () => 7 });

    const expectedPool = 2 * LOTTERY_TICKET_PRICE;

    expect(result.ticketCount).toBe(2);
    expect(result.totalPool).toBe(expectedPool);
    expect(result.winners).toHaveLength(0);
    expect(result.carriedOver).toBe(expectedPool);

    const state = await prisma.lotteryState.findUniqueOrThrow({ where: { id: 1 } });
    expect(state.currentJackpot).toBe(expectedPool);

    const houseTxs = await prisma.houseTransaction.findMany({
      where: { type: TransactionType.LOTTERY_TAX },
    });
    expect(houseTxs).toHaveLength(0);

    const tickets = await prisma.lotteryTicket.findMany({ where: { drawDate: DRAW_DATE } });
    expect(tickets.every((t) => t.settled)).toBe(true);
  });
});

describe('runLotteryDraw - 당첨자 1명', () => {
  test('세금 10% 하우스 귀속, 나머지 90% 당첨자 지급, 잭팟 초기화', async () => {
    await buyTicket('d-one-1', 7); // 당첨자
    await buyTicket('d-one-2', 3); // 낙첨자

    const totalPool = 2 * LOTTERY_TICKET_PRICE; // 2,000,000
    const tax = Math.floor(totalPool * 0.1);     // 200,000
    const prize = totalPool - tax;               // 1,800,000

    const result = await runLotteryDraw({ drawDate: DRAW_DATE, pickNumber: () => 7 });

    expect(result.winners).toEqual(['d-one-1']);
    expect(result.prizePerWinner).toBe(prize);
    expect(result.tax).toBe(tax);
    expect(result.carriedOver).toBe(0);

    const winner = await prisma.user.findUniqueOrThrow({ where: { discordId: 'd-one-1' } });
    expect(winner.balance).toBe(10_000_000 - LOTTERY_TICKET_PRICE + prize);

    const loser = await prisma.user.findUniqueOrThrow({ where: { discordId: 'd-one-2' } });
    expect(loser.balance).toBe(10_000_000 - LOTTERY_TICKET_PRICE);

    const winTxs = await prisma.transaction.findMany({
      where: { userId: 'd-one-1', type: TransactionType.LOTTERY_WIN },
    });
    expect(winTxs).toHaveLength(1);
    expect(winTxs[0].amount).toBe(prize);

    const house = await prisma.house.findUniqueOrThrow({ where: { id: HOUSE_ID } });
    expect(house.balance).toBe(tax);

    const state = await prisma.lotteryState.findUniqueOrThrow({ where: { id: 1 } });
    expect(state.currentJackpot).toBe(0);

    const tickets = await prisma.lotteryTicket.findMany({ where: { drawDate: DRAW_DATE } });
    expect(tickets.every((t) => t.settled)).toBe(true);
  });
});

describe('runLotteryDraw - 당첨자 여러 명', () => {
  test('당첨자 2명: 균등 분배, 세금 계산 정확', async () => {
    // pool: 3 × 1,000,000 = 3,000,000
    // tax: floor(3,000,000 × 0.1) = 300,000
    // prize: 2,700,000  →  per winner: floor(2,700,000 / 2) = 1,350,000  remainder: 0
    await buyTicket('d-multi-1', 7);
    await buyTicket('d-multi-2', 7);
    await buyTicket('d-multi-3', 3);

    const result = await runLotteryDraw({ drawDate: DRAW_DATE, pickNumber: () => 7 });

    expect(result.winners).toHaveLength(2);
    expect(result.winners).toContain('d-multi-1');
    expect(result.winners).toContain('d-multi-2');
    expect(result.prizePerWinner).toBe(1_350_000);
    expect(result.tax).toBe(300_000);

    for (const id of ['d-multi-1', 'd-multi-2']) {
      const u = await prisma.user.findUniqueOrThrow({ where: { discordId: id } });
      expect(u.balance).toBe(10_000_000 - LOTTERY_TICKET_PRICE + 1_350_000);
    }

    // house = tax 300,000 (우수리 0)
    const house = await prisma.house.findUniqueOrThrow({ where: { id: HOUSE_ID } });
    expect(house.balance).toBe(300_000);
  });

  test('우수리 발생 시 하우스로 귀속된다', async () => {
    // jackpot = 1 → total pool = 1 + 2×1,000,000 = 2,000,001
    // tax: floor(2,000,001 × 0.1) = 200,000
    // prize: 1,800,001  →  per winner: floor(1,800,001 / 2) = 900,000  remainder: 1
    // house = 200,000 + 1 = 200,001
    await prisma.lotteryState.create({ data: { id: 1, currentJackpot: 1 } });
    await buyTicket('d-rem-1', 7);
    await buyTicket('d-rem-2', 7);

    const result = await runLotteryDraw({ drawDate: DRAW_DATE, pickNumber: () => 7 });

    expect(result.prizePerWinner).toBe(900_000);
    expect(result.tax).toBe(200_000);

    const house = await prisma.house.findUniqueOrThrow({ where: { id: HOUSE_ID } });
    expect(house.balance).toBe(200_001);
  });
});

describe('runLotteryDraw - 이월 잭팟 반영', () => {
  test('이전 회차 잭팟이 당첨 시 총 풀에 합산된다', async () => {
    const prevJackpot = 5_000_000;
    await prisma.lotteryState.create({ data: { id: 1, currentJackpot: prevJackpot } });
    await buyTicket('d-jp-1', 7);

    const totalPool = prevJackpot + LOTTERY_TICKET_PRICE; // 6,000,000
    const tax = Math.floor(totalPool * 0.1);              // 600,000
    const prize = totalPool - tax;                        // 5,400,000

    const result = await runLotteryDraw({ drawDate: DRAW_DATE, pickNumber: () => 7 });

    expect(result.previousJackpot).toBe(prevJackpot);
    expect(result.totalPool).toBe(totalPool);
    expect(result.prizePerWinner).toBe(prize);

    const winner = await prisma.user.findUniqueOrThrow({ where: { discordId: 'd-jp-1' } });
    expect(winner.balance).toBe(10_000_000 - LOTTERY_TICKET_PRICE + prize);

    const state = await prisma.lotteryState.findUniqueOrThrow({ where: { id: 1 } });
    expect(state.currentJackpot).toBe(0);
  });

  test('당첨자 없을 때 이전 잭팟 + 이번 판매금이 누적된다', async () => {
    const prevJackpot = 3_000_000;
    await prisma.lotteryState.create({ data: { id: 1, currentJackpot: prevJackpot } });
    await buyTicket('d-jp-2', 3);
    await buyTicket('d-jp-3', 5);

    const expectedCarryover = prevJackpot + 2 * LOTTERY_TICKET_PRICE; // 5,000,000

    const result = await runLotteryDraw({ drawDate: DRAW_DATE, pickNumber: () => 7 });

    expect(result.carriedOver).toBe(expectedCarryover);

    const state = await prisma.lotteryState.findUniqueOrThrow({ where: { id: 1 } });
    expect(state.currentJackpot).toBe(expectedCarryover);
  });
});

describe('runLotteryDraw - 감사 로그', () => {
  test('추첨마다 LotteryDrawLog에 당첨번호/참여자수/source가 기록된다 (기본값 CRON)', async () => {
    await buyTicket('d-log-1', 3);
    await buyTicket('d-log-2', 5);

    const result = await runLotteryDraw({ drawDate: DRAW_DATE, pickNumber: () => 7 });

    const logs = await prisma.lotteryDrawLog.findMany({ where: { drawDate: DRAW_DATE } });
    expect(logs).toHaveLength(1);
    expect(logs[0].winningNumber).toBe(result.winningNumber);
    expect(logs[0].ticketCount).toBe(2);
    expect(logs[0].source).toBe(LotteryDrawSource.CRON);
  });

  test('source를 MANUAL로 넘기면 그대로 기록된다', async () => {
    await runLotteryDraw({ drawDate: DRAW_DATE, pickNumber: () => 7, source: LotteryDrawSource.MANUAL });

    const logs = await prisma.lotteryDrawLog.findMany({ where: { drawDate: DRAW_DATE } });
    expect(logs).toHaveLength(1);
    expect(logs[0].source).toBe(LotteryDrawSource.MANUAL);
  });
});

describe('runLotteryDraw - LotteryState 자동 생성', () => {
  test('LotteryState row가 없어도 초기 잭팟 0으로 정상 동작한다', async () => {
    await buyTicket('d-init-1', 7);

    await expect(
      runLotteryDraw({ drawDate: DRAW_DATE, pickNumber: () => 7 })
    ).resolves.toBeDefined();

    const state = await prisma.lotteryState.findUnique({ where: { id: 1 } });
    expect(state?.currentJackpot).toBe(0);
  });
});
