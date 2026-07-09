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

export async function getEconomySnapshot(db: Db = prisma) {
  const house = await getOrCreateHouse(db);
  const users = await db.user.findMany({ select: { balance: true } });
  const totalUserBalance = users.reduce((sum, user) => sum + user.balance, 0);
  const totalEconomy = house.balance + totalUserBalance;
  return { house, totalUserBalance, totalEconomy };
}

// 하우스 잔고가 전체 경제의 capRatio를 넘지 않도록, 캡 금액과 초과분(환급 재원)을
// 계산하는 순수 함수. distributionBatch()의 정기 배치와 houseBalanceCapCatchUp.ts의
// 일회성 catch-up 스크립트 양쪽에서 동일한 계산을 공유한다.
export function computeHouseCapExcess(params: {
  totalEconomy: number;
  houseBalance: number;
  capRatio: number;
}): { capAmount: number; excessAmount: number } {
  const capAmount = Math.floor(params.totalEconomy * params.capRatio);
  const excessAmount = Math.max(0, params.houseBalance - capAmount);
  return { capAmount, excessAmount };
}

export async function getHouseStatus(db: Db = prisma) {
  const { house, totalUserBalance, totalEconomy } = await getEconomySnapshot(db);
  const share = totalEconomy > 0 ? house.balance / totalEconomy : 0;

  return { balance: house.balance, totalUserBalance, share };
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
