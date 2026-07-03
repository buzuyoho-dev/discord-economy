// 💡 이 파일은 관리자가 유저별(또는 전체) 포인트 거래 내역을 조회할 때 쓰는 서비스다.
// 새 테이블은 필요 없다 - 이미 모든 포인트 변동이 기록되는 Transaction 모델을 그대로 읽기만 한다.
import { prisma } from '../db/client';
import { NotAdminError } from './adminGrant';

const DEFAULT_LIMIT = 10;
export const MAX_POINT_HISTORY_LIMIT = 30;

// 💡 limit을 1~30 사이로 강제한다 (관리자가 실수로 너무 큰 수를 넣어도 안전하게 잘라낸다).
function clampLimit(limit: number | undefined): number {
  return Math.min(Math.max(limit ?? DEFAULT_LIMIT, 1), MAX_POINT_HISTORY_LIMIT);
}

export async function getPointHistory(params: {
  requestedBy: string;
  adminDiscordId: string | undefined;
  userId?: string;
  limit?: number;
}) {
  if (!params.adminDiscordId || params.requestedBy !== params.adminDiscordId) {
    throw new NotAdminError(params.requestedBy);
  }

  return prisma.transaction.findMany({
    where: params.userId ? { userId: params.userId } : undefined,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: clampLimit(params.limit),
  });
}
