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
import { tryConsumeCoupon } from './coupon';
import { applyHouseTransaction, getOrCreateHouse } from './house';
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

export interface Mode1SettlementCalculation {
  payoutByUserId: Map<string, number>;
  totalTax: number;
}

// settleBet과 정산취소(재계산) 양쪽에서 공유하는 순수 함수 - 무효(VOID) 케이스는 다루지 않는다
// (winners가 최소 1명 있는, 즉 SETTLED로 확정된 정산만 이 함수를 거친다).
export function computeMode1Settlement(params: {
  entries: { userId: string; optionId: number; joinedAt: Date }[];
  betAmount: number;
  winningOptionId: number;
}): Mode1SettlementCalculation {
  const winners = params.entries.filter((entry) => entry.optionId === params.winningOptionId);
  const totalPool = params.entries.length * params.betAmount;
  const winnersByJoinOrder = [...winners].sort(
    (a, b) => a.joinedAt.getTime() - b.joinedAt.getTime()
  );
  const basePayout = Math.floor(totalPool / winnersByJoinOrder.length);
  const remainder = totalPool % winnersByJoinOrder.length;
  const payoutByUserId = new Map<string, number>();
  let totalTax = 0;

  for (let i = 0; i < winnersByJoinOrder.length; i++) {
    const grossPayout = basePayout + (i < remainder ? 1 : 0);
    const profit = grossPayout - params.betAmount;
    const tax = Math.round(profit * TAX_RATE);
    const netPayout = grossPayout - tax;
    totalTax += tax;
    payoutByUserId.set(winnersByJoinOrder[i].userId, netPayout);
  }

  return { payoutByUserId, totalTax };
}

// 통합(UNIFIED) 베팅 개설 - 고정 참가 금액 없이 옵션 정확히 2개만 받는다.
// 레거시 모드1(LEGACY_MODE1) 베팅은 이 함수로 더 이상 만들 수 없다 (이미 열려있는 것만 기존
// joinBet/closeBet/settleBet으로 계속 처리됨).
export async function createBet(params: {
  creatorId: string;
  title: string;
  options: string[];
}) {
  if (params.options.length !== 2) {
    throw new InvalidBetOptionsError('exactly 2 options are required');
  }

  const normalizedLabels = params.options.map(normalizeLabel);
  if (new Set(normalizedLabels).size !== normalizedLabels.length) {
    throw new DuplicateOptionLabelError('option labels must be distinct');
  }

  return prisma.bet.create({
    data: {
      creatorId: params.creatorId,
      title: params.title,
      mode: 'UNIFIED',
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
    if (bet.amount === null) {
      throw new Error(`bet ${params.betId} has no fixed amount (not a legacy mode1 bet)`);
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
    if (bet.amount === null) {
      throw new Error(`bet ${params.betId} has no fixed amount (not a legacy mode1 bet)`);
    }
    const betAmount = bet.amount;

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
          amount: betAmount,
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
          creditedAmount: betAmount,
        })),
      };
    }

    const { payoutByUserId, totalTax } = computeMode1Settlement({
      entries,
      betAmount,
      winningOptionId: params.winningOptionId,
    });

    for (const [userId, netPayout] of payoutByUserId) {
      await applyTransaction(tx, {
        discordId: userId,
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

export async function joinUnifiedBet(params: {
  betId: number;
  userId: string;
  optionId: number;
  amount: number;
  couponId?: string;
}) {
  if (!Number.isInteger(params.amount) || params.amount <= 0) {
    throw new InvalidBetOptionsError('amount must be a positive integer');
  }

  await getOrCreateUser(params.userId);

  return prisma.$transaction(async (tx) => {
    const bet = await tx.bet.findUnique({ where: { id: params.betId } });
    if (!bet) {
      throw new BetNotFoundError(`bet ${params.betId} not found`);
    }
    if (bet.mode !== 'UNIFIED') {
      throw new Error(`bet ${params.betId} is not a unified bet`);
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
      amount: -params.amount,
      description: `베팅 참가: ${bet.title}`,
    });

    try {
      return await tx.betEntry.create({
        data: {
          betId: params.betId,
          userId: params.userId,
          optionId: params.optionId,
          amount: params.amount,
          // 참가 시점엔 쿠폰을 소진하지 않는다 - 정산 시 승리한 경우에만 최종 검증 후 소진된다.
          couponId: params.couponId,
        },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new AlreadyJoinedError(`${params.userId} already joined bet ${params.betId}`);
      }
      throw error;
    }
  });
}

export interface UnifiedSettlementCalculation {
  payoutByUserId: Map<string, number>;
  houseGain: number;
}

// settleUnifiedBet과 정산취소(재계산) 양쪽에서 공유하는 순수 함수 - VOIDED(한쪽 총액 0) 케이스는
// 다루지 않는다 (양쪽 다 참가자가 있는, 즉 SETTLED로 확정된 정산만 이 함수를 거친다).
export function computeUnifiedSettlement(params: {
  entries: { userId: string; optionId: number; amount: number }[];
  winningOptionId: number;
}): UnifiedSettlementCalculation {
  const winners = params.entries.filter((entry) => entry.optionId === params.winningOptionId);
  const losers = params.entries.filter((entry) => entry.optionId !== params.winningOptionId);
  const winnersTotal = winners.reduce((sum, entry) => sum + entry.amount, 0);
  const losersTotal = losers.reduce((sum, entry) => sum + entry.amount, 0);

  const tax = Math.floor(losersTotal * TAX_RATE);
  const distributable = losersTotal - tax;

  const payoutByUserId = new Map<string, number>();
  let distributed = 0;
  for (const winner of winners) {
    const bonus = Math.floor((winner.amount / winnersTotal) * distributable);
    payoutByUserId.set(winner.userId, winner.amount + bonus);
    distributed += bonus;
  }

  const houseGain = tax + (distributable - distributed);
  return { payoutByUserId, houseGain };
}

export async function settleUnifiedBet(params: {
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
    if (bet.mode !== 'UNIFIED') {
      throw new Error(`bet ${params.betId} is not a unified bet`);
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

    const entries = bet.entries.map((entry) => ({ ...entry, amount: entry.amount ?? 0 }));
    const winnersTotal = entries
      .filter((entry) => entry.optionId === params.winningOptionId)
      .reduce((sum, entry) => sum + entry.amount, 0);
    const losersTotal = entries
      .filter((entry) => entry.optionId !== params.winningOptionId)
      .reduce((sum, entry) => sum + entry.amount, 0);
    const isVoided = winnersTotal === 0 || losersTotal === 0;

    if (isVoided) {
      for (const entry of entries) {
        await applyTransaction(tx, {
          discordId: entry.userId,
          type: TransactionType.BET,
          amount: entry.amount,
          description: `베팅 무효 환불: ${bet.title}`,
          occurredAt,
        });
        await tx.betEntry.update({ where: { id: entry.id }, data: { payout: entry.amount } });
      }

      const updated = await tx.bet.update({
        where: { id: params.betId },
        data: { status: 'VOIDED', winningOptionId: params.winningOptionId, settledAt: occurredAt },
      });

      return {
        ...updated,
        entryResults: entries.map((entry) => ({
          userId: entry.userId,
          optionId: entry.optionId,
          creditedAmount: entry.amount,
        })),
      };
    }

    const { payoutByUserId, houseGain } = computeUnifiedSettlement({
      entries,
      winningOptionId: params.winningOptionId,
    });

    // 베팅2배쿠폰: 승자 처리 루프 내부에서만 검증/소진한다. 패자는 이 루프를 타지 않으므로
    // 쿠폰이 자동으로 보존된다(별도 롤백 로직 불필요).
    const finalPayoutByUserId = new Map<string, number>();
    let house = await getOrCreateHouse(tx);

    for (const entry of entries) {
      if (entry.optionId !== params.winningOptionId) {
        continue;
      }

      const basePayout = payoutByUserId.get(entry.userId) ?? 0;
      let finalPayout = basePayout;

      if (entry.couponId) {
        // 순수익(배당금 - 원금) 부분만 2배 - 추가로 지급되는 보너스분은 하우스 잔고에서
        // 차감된다. 하우스가 감당할 수 없으면(파산 방지) 쿠폰을 소진하지 않고 원래 배당
        // 그대로 지급한다 - 무효한 쿠폰일 때와 동일한 폴백이다.
        const bonus = basePayout - entry.amount;
        const houseCanAfford = bonus > 0 && house.balance >= bonus;

        if (houseCanAfford) {
          const consumed = await tryConsumeCoupon(tx, {
            couponId: entry.couponId,
            userId: entry.userId,
            betId: bet.id,
            now: occurredAt,
          });
          if (consumed) {
            house = await applyHouseTransaction(tx, {
              type: TransactionType.BET,
              amount: -bonus,
              description: `베팅2배쿠폰 보너스 지급: ${bet.title}`,
              occurredAt,
            });
            finalPayout = entry.amount + bonus * 2;
          }
        }
        // 쿠폰이 무효하거나 하우스가 보너스를 감당할 수 없으면 조용히 무시하고
        // 원래 배당(basePayout) 그대로 지급한다.
      }

      finalPayoutByUserId.set(entry.userId, finalPayout);

      await applyTransaction(tx, {
        discordId: entry.userId,
        type: TransactionType.BET,
        amount: finalPayout,
        description: `베팅 정산: ${bet.title}`,
        occurredAt,
      });
    }

    for (const entry of entries) {
      await tx.betEntry.update({
        where: { id: entry.id },
        data: { payout: finalPayoutByUserId.get(entry.userId) ?? 0 },
      });
    }

    if (houseGain > 0) {
      await applyHouseTransaction(tx, {
        type: TransactionType.TAX,
        amount: houseGain,
        description: `베팅세: ${bet.title}`,
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
        creditedAmount: finalPayoutByUserId.get(entry.userId) ?? 0,
      })),
    };
  });
}
