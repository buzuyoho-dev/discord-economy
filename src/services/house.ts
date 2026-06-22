import { Prisma, TransactionType } from '@prisma/client';
import { prisma } from '../db/client';
import { applyBalanceChange } from './ledger';

export const HOUSE_ID = 'singleton';

type Db = Prisma.TransactionClient | typeof prisma;

// House row는 지연 생성된다 - 첫 거래(도박 패배, 모드2 정산/베팅, 대출, 양도, 환원 등) 시점에
// 없으면 만든다. tx를 넘기면 같은 트랜잭션 안에서 원자적으로 처리되어 동시성 문제가 없다.
export async function getOrCreateHouse(db: Db = prisma) {
  const existing = await db.house.findUnique({ where: { id: HOUSE_ID } });
  if (existing) {
    return existing;
  }

  return db.house.create({ data: { id: HOUSE_ID } });
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
  await getOrCreateHouse(tx);

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
