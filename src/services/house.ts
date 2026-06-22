import { Prisma, TransactionType } from '@prisma/client';
import { prisma } from '../db/client';
import { applyBalanceChange } from './ledger';

export const HOUSE_ID = 'singleton';

export async function getOrCreateHouse() {
  const existing = await prisma.house.findUnique({ where: { id: HOUSE_ID } });
  if (existing) {
    return existing;
  }

  return prisma.house.create({ data: { id: HOUSE_ID } });
}

export async function applyHouseTransaction(
  tx: Prisma.TransactionClient,
  params: {
    type: TransactionType;
    amount: number;
    description?: string;
    occurredAt?: Date;
  }
) {
  return applyBalanceChange({
    entityId: HOUSE_ID,
    updateBalance: () =>
      tx.house.update({
        where: { id: HOUSE_ID },
        data: { balance: { increment: params.amount } },
      }),
    recordLedgerEntry: (balanceAfter) =>
      tx.houseTransaction.create({
        data: {
          type: params.type,
          amount: params.amount,
          balanceAfter,
          description: params.description,
          occurredAt: params.occurredAt,
        },
      }),
  });
}
