import { prisma } from '../db/client';

export type Tier = '신' | '신하' | '평민' | '노비';

export interface RankingEntry {
  discordId: string;
  balance: number;
  rank: number;
  tier: Tier;
}

export function assignTier(rank: number, totalUsers: number): Tier {
  if (rank === 1) {
    return '신';
  }
  if (rank === totalUsers) {
    return '노비';
  }
  if (rank === 2) {
    return '신하';
  }
  return '평민';
}

export async function getRankings(): Promise<RankingEntry[]> {
  const users = await prisma.user.findMany({
    orderBy: [{ balance: 'desc' }, { discordId: 'asc' }],
  });

  return users.map((user, index) => ({
    discordId: user.discordId,
    balance: user.balance,
    rank: index + 1,
    tier: assignTier(index + 1, users.length),
  }));
}
