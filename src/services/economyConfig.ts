import { Prisma } from '@prisma/client';
import { prisma } from '../db/client';
import { NotAdminError } from './adminGrant';

export const ECONOMY_CONFIG_ID = 'SINGLETON';

type Db = Prisma.TransactionClient | typeof prisma;

export class InvalidEconomyConfigError extends Error {}

// EconomyConfig row는 배포 시점 마이그레이션에서 시딩되지만, 방어적으로 지연 생성도 지원한다
// (House의 getOrCreateHouse와 동일한 패턴).
export async function getOrCreateEconomyConfig(db: Db = prisma) {
  const existing = await db.economyConfig.findUnique({ where: { id: ECONOMY_CONFIG_ID } });
  if (existing) {
    return existing;
  }

  return db.economyConfig.create({ data: { id: ECONOMY_CONFIG_ID } });
}

export async function updateEconomyConfig(params: {
  requestedBy: string;
  adminDiscordId: string | undefined;
  lowerTierWeight: number;
  houseBalanceCapRatio: number;
}) {
  if (!params.adminDiscordId || params.requestedBy !== params.adminDiscordId) {
    throw new NotAdminError(params.requestedBy);
  }
  if (!(params.lowerTierWeight >= 1)) {
    throw new InvalidEconomyConfigError('lowerTierWeight must be >= 1');
  }
  if (!(params.houseBalanceCapRatio > 0 && params.houseBalanceCapRatio <= 1)) {
    throw new InvalidEconomyConfigError('houseBalanceCapRatio must be in (0, 1]');
  }

  await getOrCreateEconomyConfig();

  return prisma.economyConfig.update({
    where: { id: ECONOMY_CONFIG_ID },
    data: { lowerTierWeight: params.lowerTierWeight, houseBalanceCapRatio: params.houseBalanceCapRatio },
  });
}
