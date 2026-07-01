import { Prisma, TransactionType } from '@prisma/client';
import { prisma } from '../db/client';
import { applyTransaction, getOrCreateUser } from './ledger';

export const LOTTERY_TICKET_PRICE = 1_000_000;
export const LOTTERY_MIN_NUMBER = 1;
export const LOTTERY_MAX_NUMBER = 20;

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const NOON_HOUR_KST = 12;

export class InvalidLotteryNumberError extends Error {
  constructor(chosenNumber: number) {
    super(
      `Invalid lottery number ${chosenNumber}: must be between ${LOTTERY_MIN_NUMBER} and ${LOTTERY_MAX_NUMBER}`
    );
    this.name = 'InvalidLotteryNumberError';
  }
}

export class InsufficientBalanceForLotteryError extends Error {
  constructor(discordId: string) {
    super(`${discordId} has insufficient balance to purchase a lottery ticket`);
    this.name = 'InsufficientBalanceForLotteryError';
  }
}

export class AlreadyPurchasedLotteryError extends Error {
  constructor(discordId: string) {
    super(`${discordId} already purchased a lottery ticket for this draw`);
    this.name = 'AlreadyPurchasedLotteryError';
  }
}

// KST 날짜 기준으로 이 티켓이 속할 회차 날짜를 계산한다.
// 정오 이전 → 오늘 KST 날짜 / 정오 이후 → 내일 KST 날짜
// 반환값은 해당 KST 날짜의 UTC 자정(T00:00:00.000Z) — 회차 식별자로 사용된다.
export function getDrawDate(now: Date): Date {
  const kstMs = now.getTime() + KST_OFFSET_MS;
  const kstDate = new Date(kstMs);
  const kstHour = kstDate.getUTCHours();
  const kstDateStr = kstDate.toISOString().slice(0, 10);

  if (kstHour < NOON_HOUR_KST) {
    return new Date(kstDateStr + 'T00:00:00.000Z');
  }

  const tomorrowKstMs = kstMs + 24 * 60 * 60 * 1000;
  const tomorrowStr = new Date(tomorrowKstMs).toISOString().slice(0, 10);
  return new Date(tomorrowStr + 'T00:00:00.000Z');
}

export interface LotteryPurchaseResult {
  balanceAfter: number;
  drawDate: Date;
  chosenNumber: number;
}

export async function purchaseLottery(params: {
  discordId: string;
  chosenNumber: number;
  now?: Date;
}): Promise<LotteryPurchaseResult> {
  const now = params.now ?? new Date();

  if (params.chosenNumber < LOTTERY_MIN_NUMBER || params.chosenNumber > LOTTERY_MAX_NUMBER) {
    throw new InvalidLotteryNumberError(params.chosenNumber);
  }

  await getOrCreateUser(params.discordId);

  const drawDate = getDrawDate(now);

  try {
    return await prisma.$transaction(async (tx) => {
      const user = await tx.user.findUniqueOrThrow({ where: { discordId: params.discordId } });
      if (user.balance < LOTTERY_TICKET_PRICE) {
        throw new InsufficientBalanceForLotteryError(params.discordId);
      }

      const updated = await applyTransaction(tx, {
        discordId: params.discordId,
        type: TransactionType.LOTTERY_PURCHASE,
        amount: -LOTTERY_TICKET_PRICE,
        description: `복권 구매 (번호: ${params.chosenNumber})`,
        occurredAt: now,
      });

      await tx.lotteryTicket.create({
        data: {
          userId: params.discordId,
          chosenNumber: params.chosenNumber,
          amount: LOTTERY_TICKET_PRICE,
          drawDate,
          purchasedAt: now,
        },
      });

      return {
        balanceAfter: updated.balance,
        drawDate,
        chosenNumber: params.chosenNumber,
      };
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw new AlreadyPurchasedLotteryError(params.discordId);
    }
    throw error;
  }
}
