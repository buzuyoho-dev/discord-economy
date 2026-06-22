import { TransactionType } from '@prisma/client';
import { prisma } from '../db/client';
import { buildGambleRollbackDescription } from '../services/gamble';
import { applyTransaction } from '../services/ledger';

const TARGETS: { discordId: string; nickname: string }[] = [
  { discordId: '388341857782071306', nickname: '소시지' },
  { discordId: '440416248153767946', nickname: '뼅뼅이' },
  { discordId: '379539673837731842', nickname: '사이머' },
  { discordId: '251997328125329428', nickname: 'ASH' },
  { discordId: '389499261714300948', nickname: '갬탕기' },
];

const ROLLBACK_REF_PATTERN = /원거래 #(\d+)/;

interface RollbackItem {
  originalTransactionId: number;
  originalAmount: number;
  rollbackAmount: number;
}

async function findUnrolledBackWins(
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  discordId: string
): Promise<RollbackItem[]> {
  const [wins, existingRollbacks] = await Promise.all([
    tx.transaction.findMany({
      where: { userId: discordId, type: TransactionType.GAMBLE_WIN },
      orderBy: { id: 'asc' },
    }),
    tx.transaction.findMany({
      where: { userId: discordId, type: TransactionType.GAMBLE_ROLLBACK },
      select: { description: true },
    }),
  ]);

  const rolledBackIds = new Set(
    existingRollbacks
      .map((r) => r.description?.match(ROLLBACK_REF_PATTERN)?.[1])
      .filter((id): id is string => id !== undefined)
      .map(Number)
  );

  return wins
    .filter((w) => !rolledBackIds.has(w.id))
    .map((w) => ({ originalTransactionId: w.id, originalAmount: w.amount, rollbackAmount: -w.amount }));
}

export async function rollbackGambleWinBug(execute: boolean) {
  return prisma.$transaction(async (tx) => {
    const report: {
      discordId: string;
      nickname: string;
      balanceBefore: number;
      balanceAfter: number;
      items: RollbackItem[];
    }[] = [];

    for (const { discordId, nickname } of TARGETS) {
      const user = await tx.user.findUniqueOrThrow({ where: { discordId } });
      const items = await findUnrolledBackWins(tx, discordId);

      let balanceAfter = user.balance;

      for (const item of items) {
        const description = buildGambleRollbackDescription(item.originalTransactionId);

        console.log(
          `${execute ? '[실행]' : '[DRY-RUN]'} UPDATE "User" SET "balance" = "balance" + (${item.rollbackAmount}) WHERE "discordId" = '${discordId}'; -- ${nickname}`
        );
        console.log(
          `${execute ? '[실행]' : '[DRY-RUN]'} INSERT INTO "Transaction" ("userId", "type", "amount", "balanceAfter", "description") VALUES ('${discordId}', 'GAMBLE_ROLLBACK', ${item.rollbackAmount}, ${balanceAfter + item.rollbackAmount}, '${description}');`
        );

        if (execute) {
          const updated = await applyTransaction(tx, {
            discordId,
            type: TransactionType.GAMBLE_ROLLBACK,
            amount: item.rollbackAmount,
            description,
          });
          balanceAfter = updated.balance;
        } else {
          balanceAfter += item.rollbackAmount;
        }
      }

      report.push({ discordId, nickname, balanceBefore: user.balance, balanceAfter, items });
    }

    return report;
  });
}

async function main() {
  const execute = process.argv.includes('--execute');

  const report = await rollbackGambleWinBug(execute);

  console.log('');
  console.log(execute ? '=== 실행 결과 ===' : '=== DRY RUN 결과 (DB에 쓰지 않음) ===');
  for (const r of report) {
    console.log(
      `${r.nickname} (${r.discordId}): 롤백 ${r.items.length}건, 잔액 ${r.balanceBefore.toLocaleString()} -> ${r.balanceAfter.toLocaleString()}`
    );
  }
}

if (require.main === module) {
  main()
    .catch((e) => {
      console.error(e);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
