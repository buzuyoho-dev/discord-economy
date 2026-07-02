import { Prisma, TransactionType } from '@prisma/client';
import { prisma } from '../db/client';
import {
  AlreadyJoinedError,
  BetNotClosedError,
  BetNotFoundError,
  BetNotOpenError,
  InvalidBetOptionsError,
  NotBetCreatorError,
  normalizeLabel,
} from './betShared';
import { applyHouseTransaction, getOrCreateHouse } from './house';
import { applyTransaction, getOrCreateUser } from './ledger';

export {
  AlreadyJoinedError,
  BetNotClosedError,
  BetNotFoundError,
  BetNotOpenError,
  NotBetCreatorError,
} from './betShared';
export class Mode2BetLimitExceededError extends Error {}

const TAX_RATE = 0.05;

export interface Mode2SettlementCalculation {
  payoutByUserId: Map<string, number>;
  totalTax: number;
  shortfall: number;
}

// settleMode2Bet과 정산취소(재계산) 양쪽에서 공유하는 순수 함수.
export function computeMode2Settlement(params: {
  entries: { userId: string; side: 'A' | 'B'; amount: number; joinedAt: Date }[];
  winningSide: 'A' | 'B';
}): Mode2SettlementCalculation {
  const winners = params.entries
    .filter((entry) => entry.side === params.winningSide)
    .sort((a, b) => a.joinedAt.getTime() - b.joinedAt.getTime());
  const losers = params.entries.filter((entry) => entry.side !== params.winningSide);

  const totalProfitOwed = winners.reduce((sum, entry) => sum + entry.amount, 0);
  const totalLoserPool = losers.reduce((sum, entry) => sum + entry.amount, 0);
  const shortfall = Math.max(0, totalProfitOwed - totalLoserPool);

  let totalTax = 0;
  const payoutByUserId = new Map<string, number>();
  for (const winner of winners) {
    const profit = winner.amount;
    const tax = Math.round(profit * TAX_RATE);
    const netProfit = profit - tax;
    totalTax += tax;
    const payout = winner.amount + netProfit;
    payoutByUserId.set(winner.userId, payout);
  }

  return { payoutByUserId, totalTax, shortfall };
}

export async function createMode2Bet(params: {
  creatorId: string;
  title: string;
  sideALabel: string;
  sideBLabel: string;
}) {
  if (normalizeLabel(params.sideALabel) === normalizeLabel(params.sideBLabel)) {
    throw new InvalidBetOptionsError('sideALabel and sideBLabel must be distinct');
  }

  return prisma.mode2Bet.create({
    data: {
      creatorId: params.creatorId,
      title: params.title,
      sideALabel: params.sideALabel,
      sideBLabel: params.sideBLabel,
    },
  });
}

export async function closeMode2Bet(params: { betId: number; requestedBy: string }) {
  return prisma.$transaction(async (tx) => {
    const bet = await tx.mode2Bet.findUnique({ where: { id: params.betId } });
    if (!bet) {
      throw new BetNotFoundError(`mode2 bet ${params.betId} not found`);
    }
    if (bet.creatorId !== params.requestedBy) {
      throw new NotBetCreatorError(`${params.requestedBy} is not the creator of bet ${params.betId}`);
    }
    if (bet.status !== 'OPEN') {
      throw new BetNotOpenError(`mode2 bet ${params.betId} is not open`);
    }

    return tx.mode2Bet.update({
      where: { id: params.betId },
      data: { status: 'CLOSED', closedAt: new Date() },
    });
  });
}

export async function placeMode2Bet(params: {
  betId: number;
  userId: string;
  side: 'A' | 'B';
  amount: number;
}) {
  if (!Number.isInteger(params.amount) || params.amount <= 0) {
    throw new InvalidBetOptionsError('amount must be a positive integer');
  }

  await getOrCreateUser(params.userId);

  return prisma.$transaction(async (tx) => {
    const bet = await tx.mode2Bet.findUnique({ where: { id: params.betId } });
    if (!bet) {
      throw new BetNotFoundError(`mode2 bet ${params.betId} not found`);
    }
    if (bet.status !== 'OPEN') {
      throw new BetNotOpenError(`mode2 bet ${params.betId} is not open`);
    }

    const existingEntry = await tx.mode2Entry.findUnique({
      where: { betId_userId: { betId: params.betId, userId: params.userId } },
    });
    if (existingEntry) {
      throw new AlreadyJoinedError(`${params.userId} already joined mode2 bet ${params.betId}`);
    }

    // 한도 체크는 차감과 같은 트랜잭션 안에서, 매번 새로 읽은 하우스 잔액을 기준으로 한다.
    const house = await getOrCreateHouse(tx);
    const limit = Math.floor(house.balance * 0.1);
    if (params.amount > limit) {
      throw new Mode2BetLimitExceededError(
        `stake ${params.amount} exceeds the current limit ${limit} (house balance ${house.balance} x 10%)`
      );
    }

    await applyTransaction(tx, {
      discordId: params.userId,
      type: TransactionType.BET,
      amount: -params.amount,
      description: `모드2 베팅 참가: ${bet.title}`,
    });

    try {
      return await tx.mode2Entry.create({
        data: { betId: params.betId, userId: params.userId, side: params.side, amount: params.amount },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new AlreadyJoinedError(`${params.userId} already joined mode2 bet ${params.betId}`);
      }
      throw error;
    }
  });
}

export async function settleMode2Bet(params: {
  betId: number;
  requestedBy: string;
  winningSide: 'A' | 'B';
  now?: Date;
}) {
  const occurredAt = params.now ?? new Date();

  return prisma.$transaction(async (tx) => {
    const bet = await tx.mode2Bet.findUnique({
      where: { id: params.betId },
      include: { entries: true },
    });
    if (!bet) {
      throw new BetNotFoundError(`mode2 bet ${params.betId} not found`);
    }
    if (bet.creatorId !== params.requestedBy) {
      throw new NotBetCreatorError(`${params.requestedBy} is not the creator of bet ${params.betId}`);
    }
    if (bet.status !== 'CLOSED') {
      throw new BetNotClosedError(`mode2 bet ${params.betId} is not closed`);
    }

    const { payoutByUserId, totalTax, shortfall } = computeMode2Settlement({
      entries: bet.entries,
      winningSide: params.winningSide,
    });

    // 부족분 충당과 베팅세는 서로 독립적인 흐름 - 부족분이 없어도 세금은 항상 걷힌다.
    if (shortfall > 0) {
      await applyHouseTransaction(tx, {
        type: TransactionType.BET,
        amount: -shortfall,
        description: `모드2 정산 부족분 충당: ${bet.title}`,
        occurredAt,
      });
    }

    for (const [userId, payout] of payoutByUserId) {
      await applyTransaction(tx, {
        discordId: userId,
        type: TransactionType.BET,
        amount: payout,
        description: `모드2 베팅 정산: ${bet.title}`,
        occurredAt,
      });
    }

    if (totalTax > 0) {
      await applyHouseTransaction(tx, {
        type: TransactionType.TAX,
        amount: totalTax,
        description: `모드2 베팅세: ${bet.title}`,
        occurredAt,
      });
    }

    const updated = await tx.mode2Bet.update({
      where: { id: params.betId },
      data: { status: 'SETTLED', winningSide: params.winningSide, settledAt: occurredAt },
    });

    return {
      ...updated,
      entryResults: bet.entries.map((entry) => ({
        userId: entry.userId,
        side: entry.side,
        stake: entry.amount,
        creditedAmount: payoutByUserId.get(entry.userId) ?? 0,
      })),
    };
  });
}
