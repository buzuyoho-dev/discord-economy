import { Prisma, TransactionType } from '@prisma/client';
import { prisma } from '../db/client';
import {
  AlreadyJoinedError,
  BetNotClosedError,
  BetNotFoundError,
  BetNotOpenError,
  InvalidBetOptionsError,
  normalizeLabel,
  NotBetCreatorError,
} from './betShared';
import { applyHouseTransaction } from './house';
import { applyTransaction, getOrCreateUser } from './ledger';

export {
  AlreadyJoinedError,
  BetNotClosedError,
  BetNotFoundError,
  BetNotOpenError,
  InvalidBetOptionsError,
  normalizeLabel,
  NotBetCreatorError,
} from './betShared';
export class DuplicateOptionLabelError extends Error {}
export class InvalidOptionError extends Error {}

const TAX_RATE = 0.05;

export async function createBet(params: {
  creatorId: string;
  title: string;
  amount: number;
  options: string[];
}) {
  if (!Number.isInteger(params.amount) || params.amount <= 0) {
    throw new InvalidBetOptionsError('amount must be a positive integer');
  }
  if (params.options.length < 2) {
    throw new InvalidBetOptionsError('at least 2 options are required');
  }

  const normalizedLabels = params.options.map(normalizeLabel);
  if (new Set(normalizedLabels).size !== normalizedLabels.length) {
    throw new DuplicateOptionLabelError('option labels must be distinct');
  }

  return prisma.bet.create({
    data: {
      creatorId: params.creatorId,
      title: params.title,
      amount: params.amount,
      options: { create: params.options.map((label) => ({ label })) },
    },
    include: { options: true },
  });
}

export async function joinBet(params: { betId: number; userId: string; optionId: number }) {
  await getOrCreateUser(params.userId);

  return prisma.$transaction(async (tx) => {
    const bet = await tx.bet.findUnique({ where: { id: params.betId } });
    if (!bet) {
      throw new BetNotFoundError(`bet ${params.betId} not found`);
    }
    if (bet.status !== 'OPEN') {
      throw new BetNotOpenError(`bet ${params.betId} is not open`);
    }

    const option = await tx.betOption.findUnique({ where: { id: params.optionId } });
    if (!option || option.betId !== params.betId) {
      throw new InvalidOptionError(`option ${params.optionId} does not belong to bet ${params.betId}`);
    }

    const existingEntry = await tx.betEntry.findUnique({
      where: { betId_userId: { betId: params.betId, userId: params.userId } },
    });
    if (existingEntry) {
      throw new AlreadyJoinedError(`${params.userId} already joined bet ${params.betId}`);
    }

    await applyTransaction(tx, {
      discordId: params.userId,
      type: TransactionType.BET,
      amount: -bet.amount,
      description: `베팅 참가: ${bet.title}`,
    });

    try {
      return await tx.betEntry.create({
        data: { betId: params.betId, userId: params.userId, optionId: params.optionId },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new AlreadyJoinedError(`${params.userId} already joined bet ${params.betId}`);
      }
      throw error;
    }
  });
}

export async function closeBet(params: { betId: number; requestedBy: string }) {
  return prisma.$transaction(async (tx) => {
    const bet = await tx.bet.findUnique({ where: { id: params.betId } });
    if (!bet) {
      throw new BetNotFoundError(`bet ${params.betId} not found`);
    }
    if (bet.creatorId !== params.requestedBy) {
      throw new NotBetCreatorError(`${params.requestedBy} is not the creator of bet ${params.betId}`);
    }
    if (bet.status !== 'OPEN') {
      throw new BetNotOpenError(`bet ${params.betId} is not open`);
    }

    return tx.bet.update({
      where: { id: params.betId },
      data: { status: 'CLOSED', closedAt: new Date() },
    });
  });
}

export async function settleBet(params: {
  betId: number;
  requestedBy: string;
  winningOptionId: number;
  now?: Date;
}) {
  const occurredAt = params.now ?? new Date();

  return prisma.$transaction(async (tx) => {
    const bet = await tx.bet.findUnique({
      where: { id: params.betId },
      include: { entries: true },
    });
    if (!bet) {
      throw new BetNotFoundError(`bet ${params.betId} not found`);
    }
    if (bet.creatorId !== params.requestedBy) {
      throw new NotBetCreatorError(`${params.requestedBy} is not the creator of bet ${params.betId}`);
    }
    if (bet.status !== 'CLOSED') {
      throw new BetNotClosedError(`bet ${params.betId} is not closed`);
    }

    const winningOption = await tx.betOption.findUnique({ where: { id: params.winningOptionId } });
    if (!winningOption || winningOption.betId !== params.betId) {
      throw new InvalidOptionError(
        `option ${params.winningOptionId} does not belong to bet ${params.betId}`
      );
    }

    const entries = bet.entries;
    const distinctOptionIds = new Set(entries.map((entry) => entry.optionId));
    const winners = entries.filter((entry) => entry.optionId === params.winningOptionId);
    const isVoid = distinctOptionIds.size <= 1 || winners.length === 0;

    if (isVoid) {
      for (const entry of entries) {
        await applyTransaction(tx, {
          discordId: entry.userId,
          type: TransactionType.BET,
          amount: bet.amount,
          description: `베팅 무효 환불: ${bet.title}`,
          occurredAt,
        });
      }

      const updated = await tx.bet.update({
        where: { id: params.betId },
        data: { status: 'VOID', winningOptionId: params.winningOptionId, settledAt: occurredAt },
      });

      return {
        ...updated,
        entryResults: entries.map((entry) => ({
          userId: entry.userId,
          optionId: entry.optionId,
          creditedAmount: bet.amount,
        })),
      };
    }

    const totalPool = entries.length * bet.amount;
    const winnersByJoinOrder = [...winners].sort(
      (a, b) => a.joinedAt.getTime() - b.joinedAt.getTime()
    );
    const basePayout = Math.floor(totalPool / winnersByJoinOrder.length);
    const remainder = totalPool % winnersByJoinOrder.length;
    const payoutByUserId = new Map<string, number>();
    let totalTax = 0;

    for (let i = 0; i < winnersByJoinOrder.length; i++) {
      const grossPayout = basePayout + (i < remainder ? 1 : 0);
      const profit = grossPayout - bet.amount;
      const tax = Math.round(profit * TAX_RATE);
      const netPayout = grossPayout - tax;
      totalTax += tax;
      payoutByUserId.set(winnersByJoinOrder[i].userId, netPayout);
      await applyTransaction(tx, {
        discordId: winnersByJoinOrder[i].userId,
        type: TransactionType.BET,
        amount: netPayout,
        description: `베팅 정산: ${bet.title}`,
        occurredAt,
      });
    }

    if (totalTax > 0) {
      await applyHouseTransaction(tx, {
        type: TransactionType.TAX,
        amount: totalTax,
        description: `모드1 베팅세: ${bet.title}`,
        occurredAt,
      });
    }

    const updated = await tx.bet.update({
      where: { id: params.betId },
      data: { status: 'SETTLED', winningOptionId: params.winningOptionId, settledAt: occurredAt },
    });

    return {
      ...updated,
      entryResults: entries.map((entry) => ({
        userId: entry.userId,
        optionId: entry.optionId,
        creditedAmount: payoutByUserId.get(entry.userId) ?? 0,
      })),
    };
  });
}
