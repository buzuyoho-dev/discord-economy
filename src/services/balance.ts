import { prisma } from '../db/client';
import { getOrCreateUser } from './ledger';

const RECENT_TRANSACTIONS_LIMIT = 5;

export async function getBalanceSummary(discordId: string) {
  const user = await getOrCreateUser(discordId);

  const recentTransactions = await prisma.transaction.findMany({
    where: { userId: discordId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: RECENT_TRANSACTIONS_LIMIT,
  });

  return {
    balance: user.balance,
    recentTransactions,
  };
}
