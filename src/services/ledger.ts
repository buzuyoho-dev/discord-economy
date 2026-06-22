import { Prisma, TransactionType } from '@prisma/client';
import { prisma } from '../db/client';

const STARTING_BALANCE = 10_000_000;

export class InsufficientBalanceError extends Error {
  constructor(entityId: string, attemptedBalance: number) {
    super(
      `Insufficient balance for ${entityId}: resulting balance ${attemptedBalance} would be negative`
    );
    this.name = 'InsufficientBalanceError';
  }
}

// User/House가 공유하는 원자적 잔액 갱신 + 거래 기록 + 마이너스 방지 가드
export async function applyBalanceChange<TBalance extends { balance: number }>(options: {
  entityId: string;
  updateBalance: () => Promise<TBalance>;
  recordLedgerEntry: (balanceAfter: number) => Promise<unknown>;
}): Promise<TBalance> {
  const updated = await options.updateBalance();

  if (updated.balance < 0) {
    throw new InsufficientBalanceError(options.entityId, updated.balance);
  }

  await options.recordLedgerEntry(updated.balance);

  return updated;
}

export async function getOrCreateUser(discordId: string) {
  const existing = await prisma.user.findUnique({ where: { discordId } });
  if (existing) {
    return existing;
  }

  return prisma.$transaction(async (tx) => {
    await tx.user.create({ data: { discordId } });
    return applyTransaction(tx, {
      discordId,
      type: TransactionType.INITIAL,
      amount: STARTING_BALANCE,
      description: '시작 포인트 지급',
    });
  });
}

export async function applyTransaction(
  tx: Prisma.TransactionClient,
  params: {
    discordId: string;
    type: TransactionType;
    amount: number;
    description?: string;
    occurredAt?: Date;
  }
) {
  return applyBalanceChange({
    entityId: params.discordId,
    updateBalance: () =>
      tx.user.update({
        where: { discordId: params.discordId },
        data: { balance: { increment: params.amount } },
      }),
    recordLedgerEntry: (balanceAfter) =>
      tx.transaction.create({
        data: {
          userId: params.discordId,
          type: params.type,
          amount: params.amount,
          balanceAfter,
          description: params.description,
          createdAt: params.occurredAt,
        },
      }),
  });
}
