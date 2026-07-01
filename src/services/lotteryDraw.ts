import { randomInt } from 'crypto';
import { TransactionType } from '@prisma/client';
import { prisma } from '../db/client';
import { applyHouseTransaction } from './house';
import { applyTransaction } from './ledger';
import { LOTTERY_MAX_NUMBER, LOTTERY_MIN_NUMBER, LOTTERY_TICKET_PRICE } from './lottery';

export interface LotteryDrawResult {
  drawDate: Date;
  winningNumber: number;
  ticketCount: number;
  totalPool: number;
  previousJackpot: number;
  winners: string[];
  prizePerWinner: number;
  tax: number;
  carriedOver: number;
}

function cryptoPickNumber(): number {
  return randomInt(LOTTERY_MIN_NUMBER, LOTTERY_MAX_NUMBER + 1);
}

export async function runLotteryDraw(params: {
  drawDate: Date;
  pickNumber?: () => number;
}): Promise<LotteryDrawResult> {
  const pickNumber = params.pickNumber ?? cryptoPickNumber;

  return prisma.$transaction(async (tx) => {
    const tickets = await tx.lotteryTicket.findMany({
      where: { drawDate: params.drawDate, settled: false },
    });

    const state = await tx.lotteryState.findUnique({ where: { id: 1 } });
    const previousJackpot = state?.currentJackpot ?? 0;

    const salesRevenue = tickets.length * LOTTERY_TICKET_PRICE;
    const totalPool = previousJackpot + salesRevenue;

    const winningNumber = pickNumber();
    const winnerTickets = tickets.filter((t) => t.chosenNumber === winningNumber);
    const winners = winnerTickets.map((t) => t.userId);

    let prizePerWinner = 0;
    let tax = 0;
    let carriedOver = 0;

    if (winners.length > 0) {
      tax = Math.floor(totalPool * 0.1);
      const prize = totalPool - tax;
      prizePerWinner = Math.floor(prize / winners.length);
      const remainder = prize - prizePerWinner * winners.length;
      const houseGain = tax + remainder;

      if (houseGain > 0) {
        await applyHouseTransaction(tx, {
          type: TransactionType.LOTTERY_TAX,
          amount: houseGain,
          description: `복권 세금 (당첨 번호: ${winningNumber}, 당첨자 ${winners.length}명)`,
        });
      }

      for (const userId of winners) {
        await applyTransaction(tx, {
          discordId: userId,
          type: TransactionType.LOTTERY_WIN,
          amount: prizePerWinner,
          description: `복권 당첨 (번호: ${winningNumber})`,
        });
      }

      await tx.lotteryState.upsert({
        where: { id: 1 },
        update: { currentJackpot: 0 },
        create: { id: 1, currentJackpot: 0 },
      });
    } else {
      carriedOver = totalPool;

      await tx.lotteryState.upsert({
        where: { id: 1 },
        update: { currentJackpot: carriedOver },
        create: { id: 1, currentJackpot: carriedOver },
      });
    }

    await tx.lotteryTicket.updateMany({
      where: { drawDate: params.drawDate },
      data: { settled: true },
    });

    return {
      drawDate: params.drawDate,
      winningNumber,
      ticketCount: tickets.length,
      totalPool,
      previousJackpot,
      winners,
      prizePerWinner,
      tax,
      carriedOver,
    };
  });
}
