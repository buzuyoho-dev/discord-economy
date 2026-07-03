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

// 💡 excludeUserId를 넘기면 그 discordId는 결과에서 통째로 빼고 순위를 매긴다.
// 봇 자신의 Discord ID를 넘기는 용도로 쓴다 - 어떤 이유로든 봇 명의 User row가 DB에
// 남아있어도, 순위표에는 절대 나타나지 않게 하는 마지막 방어선이다.
export async function getRankings(options?: { excludeUserId?: string }): Promise<RankingEntry[]> {
  const users = await prisma.user.findMany({
    where: options?.excludeUserId ? { discordId: { not: options.excludeUserId } } : undefined,
    orderBy: [{ balance: 'desc' }, { discordId: 'asc' }],
  });

  return users.map((user, index) => ({
    discordId: user.discordId,
    balance: user.balance,
    rank: index + 1,
    tier: assignTier(index + 1, users.length),
  }));
}
