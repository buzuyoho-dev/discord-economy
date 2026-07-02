import { Prisma, TransactionType } from '@prisma/client';
import { prisma } from '../db/client';
import { NotAdminError } from './adminGrant';
import { BetNotFoundError, BetNotSettledError } from './betShared';
import { applyHouseTransaction } from './house';
import { applyTransaction } from './ledger';
import { computeMode1Settlement } from './mode1Bet';
import { computeMode2Settlement } from './mode2Bet';

type Db = Prisma.TransactionClient | typeof prisma;

type SettledBetLookup =
  | { mode: 1; bet: Prisma.BetGetPayload<{ include: { entries: true } }> }
  | { mode: 2; bet: Prisma.Mode2BetGetPayload<{ include: { entries: true } }> };

export interface SettlementCancellationCorrection {
  userId: string;
  amount: number;
}

export interface SettlementCancellationPlan {
  mode: 1 | 2;
  betId: number;
  title: string;
  corrections: SettlementCancellationCorrection[];
  houseDelta: number;
}

const CORRECTION_DESCRIPTION_SUFFIX = '정산취소 (정산 오류 정정)';

function assertAdmin(requestedBy: string, adminDiscordId: string | undefined) {
  if (!adminDiscordId || requestedBy !== adminDiscordId) {
    throw new NotAdminError(requestedBy);
  }
}

async function findBet(db: Db, betId: number): Promise<SettledBetLookup | null> {
  const bet1 = await db.bet.findUnique({ where: { id: betId }, include: { entries: true } });
  if (bet1) {
    return { mode: 1, bet: bet1 };
  }

  const bet2 = await db.mode2Bet.findUnique({ where: { id: betId }, include: { entries: true } });
  if (bet2) {
    return { mode: 2, bet: bet2 };
  }

  return null;
}

function assertSettled(
  found: SettledBetLookup | null,
  betId: number
): asserts found is SettledBetLookup {
  if (!found) {
    throw new BetNotFoundError(`bet ${betId} not found`);
  }
  if (found.bet.status !== 'SETTLED') {
    throw new BetNotSettledError(`bet ${betId} is not settled`);
  }
}

function buildCorrectionPlan(found: SettledBetLookup): SettlementCancellationPlan {
  if (found.mode === 1) {
    const bet = found.bet;
    if (bet.winningOptionId === null) {
      throw new Error(`settled bet ${bet.id} has no winningOptionId`);
    }

    const { payoutByUserId, totalTax } = computeMode1Settlement({
      entries: bet.entries,
      betAmount: bet.amount,
      winningOptionId: bet.winningOptionId,
    });

    return {
      mode: 1,
      betId: bet.id,
      title: bet.title,
      corrections: [...payoutByUserId.entries()].map(([userId, amount]) => ({
        userId,
        amount: -amount,
      })),
      houseDelta: totalTax > 0 ? -totalTax : 0,
    };
  }

  const bet = found.bet;
  if (bet.winningSide === null) {
    throw new Error(`settled mode2 bet ${bet.id} has no winningSide`);
  }

  const { payoutByUserId, totalTax, shortfall } = computeMode2Settlement({
    entries: bet.entries,
    winningSide: bet.winningSide,
  });

  return {
    mode: 2,
    betId: bet.id,
    title: bet.title,
    corrections: [...payoutByUserId.entries()].map(([userId, amount]) => ({
      userId,
      amount: -amount,
    })),
    houseDelta: shortfall - totalTax,
  };
}

export async function previewSettlementCancellation(params: {
  betId: number;
  requestedBy: string;
  adminDiscordId: string | undefined;
}): Promise<SettlementCancellationPlan> {
  assertAdmin(params.requestedBy, params.adminDiscordId);

  const found = await findBet(prisma, params.betId);
  assertSettled(found, params.betId);

  return buildCorrectionPlan(found);
}

export async function cancelSettlement(params: {
  betId: number;
  requestedBy: string;
  adminDiscordId: string | undefined;
  now?: Date;
}): Promise<SettlementCancellationPlan> {
  assertAdmin(params.requestedBy, params.adminDiscordId);
  const occurredAt = params.now ?? new Date();

  return prisma.$transaction(async (tx) => {
    const found = await findBet(tx, params.betId);
    assertSettled(found, params.betId);

    const plan = buildCorrectionPlan(found);

    for (const correction of plan.corrections) {
      await applyTransaction(tx, {
        discordId: correction.userId,
        type: TransactionType.SETTLEMENT_CORRECTION,
        amount: correction.amount,
        description: `베팅#${plan.betId} ${CORRECTION_DESCRIPTION_SUFFIX}`,
        occurredAt,
      });
    }

    if (plan.houseDelta !== 0) {
      await applyHouseTransaction(tx, {
        type: TransactionType.SETTLEMENT_CORRECTION,
        amount: plan.houseDelta,
        description: `베팅#${plan.betId} ${CORRECTION_DESCRIPTION_SUFFIX}`,
        occurredAt,
      });
    }

    if (found.mode === 1) {
      await tx.bet.update({
        where: { id: params.betId },
        data: { status: 'CLOSED', winningOptionId: null, settledAt: null },
      });
    } else {
      await tx.mode2Bet.update({
        where: { id: params.betId },
        data: { status: 'CLOSED', winningSide: null, settledAt: null },
      });
    }

    return plan;
  });
}
