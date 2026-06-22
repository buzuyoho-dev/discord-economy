import { TransactionType } from '@prisma/client';
import { prisma } from '../db/client';
import { applyHouseTransaction, getOrCreateHouse } from '../services/house';
import { applyTransaction, STARTING_BALANCE } from '../services/ledger';

interface ResetPlanItem {
  discordId: string;
  balanceBefore: number;
  delta: number;
  balanceAfter: number;
}

interface HouseResetPlan {
  balanceBefore: number;
  delta: number;
  balanceAfter: number;
}

export interface ResetServerBalancesResult {
  users: ResetPlanItem[];
  house: HouseResetPlan;
}

export async function resetServerBalances(execute: boolean): Promise<ResetServerBalancesResult> {
  return prisma.$transaction(async (tx) => {
    const users = await tx.user.findMany({ orderBy: { discordId: 'asc' } });
    const house = await getOrCreateHouse(tx);

    const userPlan: ResetPlanItem[] = users.map((u) => ({
      discordId: u.discordId,
      balanceBefore: u.balance,
      delta: STARTING_BALANCE - u.balance,
      balanceAfter: STARTING_BALANCE,
    }));

    const housePlan: HouseResetPlan = {
      balanceBefore: house.balance,
      delta: -house.balance,
      balanceAfter: 0,
    };

    for (const item of userPlan) {
      console.log(
        `${execute ? '[실행]' : '[DRY-RUN]'} UPDATE "User" SET "balance" = "balance" + (${item.delta}) WHERE "discordId" = '${item.discordId}';`
      );
      console.log(
        `${execute ? '[실행]' : '[DRY-RUN]'} INSERT INTO "Transaction" ("userId", "type", "amount", "balanceAfter", "description") VALUES ('${item.discordId}', 'ADMIN_RESET', ${item.delta}, ${item.balanceAfter}, '서버 초기화');`
      );

      if (execute) {
        await applyTransaction(tx, {
          discordId: item.discordId,
          type: TransactionType.ADMIN_RESET,
          amount: item.delta,
          description: '서버 초기화',
        });
      }
    }

    console.log(
      `${execute ? '[실행]' : '[DRY-RUN]'} UPDATE "House" SET "balance" = "balance" + (${housePlan.delta}) WHERE "id" = 'singleton';`
    );
    console.log(
      `${execute ? '[실행]' : '[DRY-RUN]'} INSERT INTO "HouseTransaction" ("type", "amount", "balanceAfter", "description") VALUES ('ADMIN_RESET', ${housePlan.delta}, ${housePlan.balanceAfter}, '서버 초기화');`
    );

    if (execute) {
      await applyHouseTransaction(tx, {
        type: TransactionType.ADMIN_RESET,
        amount: housePlan.delta,
        description: '서버 초기화',
      });
    }

    return { users: userPlan, house: housePlan };
  });
}

async function main() {
  const execute = process.argv.includes('--execute');

  const result = await resetServerBalances(execute);

  console.log('');
  console.log(execute ? '=== 실행 결과 ===' : '=== DRY RUN 결과 (DB에 쓰지 않음) ===');
  for (const u of result.users) {
    console.log(`${u.discordId}: ${u.balanceBefore.toLocaleString()} -> ${u.balanceAfter.toLocaleString()} (변동 ${u.delta >= 0 ? '+' : ''}${u.delta.toLocaleString()})`);
  }
  console.log(
    `House: ${result.house.balanceBefore.toLocaleString()} -> ${result.house.balanceAfter.toLocaleString()} (변동 ${result.house.delta >= 0 ? '+' : ''}${result.house.delta.toLocaleString()})`
  );
}

if (require.main === module) {
  main()
    .catch((e) => {
      console.error(e);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
