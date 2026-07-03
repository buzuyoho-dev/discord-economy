import { describe, expect, test } from 'vitest';
import { prisma } from '../../src/db/client';
import { NotAdminError } from '../../src/services/adminGrant';
import { applyTransaction, getOrCreateUser } from '../../src/services/ledger';
import { getPointHistory, MAX_POINT_HISTORY_LIMIT } from '../../src/services/pointHistory';

const ADMIN_ID = 'admin-1';

describe('getPointHistory - 권한', () => {
  test('관리자가 아니면 거부된다', async () => {
    await expect(
      getPointHistory({ requestedBy: 'not-admin', adminDiscordId: ADMIN_ID })
    ).rejects.toThrow(NotAdminError);
  });

  test('ADMIN_DISCORD_ID가 설정되지 않았으면 누구도 조회할 수 없다', async () => {
    await expect(
      getPointHistory({ requestedBy: ADMIN_ID, adminDiscordId: undefined })
    ).rejects.toThrow(NotAdminError);
  });
});

describe('getPointHistory - 조회', () => {
  test('userId를 지정하면 그 유저의 거래만 최신순으로 반환한다', async () => {
    await getOrCreateUser('ph-user-1');
    await getOrCreateUser('ph-user-2');

    await prisma.$transaction((tx) =>
      applyTransaction(tx, { discordId: 'ph-user-1', type: 'ATTENDANCE', amount: 1, description: 'a' })
    );
    await prisma.$transaction((tx) =>
      applyTransaction(tx, { discordId: 'ph-user-2', type: 'ATTENDANCE', amount: 1, description: 'b' })
    );
    await prisma.$transaction((tx) =>
      applyTransaction(tx, { discordId: 'ph-user-1', type: 'ATTENDANCE', amount: 1, description: 'c' })
    );

    const result = await getPointHistory({
      requestedBy: ADMIN_ID,
      adminDiscordId: ADMIN_ID,
      userId: 'ph-user-1',
    });

    expect(result.every((tx) => tx.userId === 'ph-user-1')).toBe(true);
    // 최신순: c(마지막 생성) -> a -> getOrCreateUser가 만든 INITIAL(시작 포인트 지급)이 가장 오래됨
    expect(result.map((tx) => tx.description)).toEqual(['c', 'a', '시작 포인트 지급']);
  });

  test('userId를 지정하지 않으면 전체 유저의 최신 거래를 반환한다', async () => {
    await getOrCreateUser('ph-all-1');
    await getOrCreateUser('ph-all-2');
    await prisma.$transaction((tx) =>
      applyTransaction(tx, { discordId: 'ph-all-1', type: 'ATTENDANCE', amount: 1 })
    );
    await prisma.$transaction((tx) =>
      applyTransaction(tx, { discordId: 'ph-all-2', type: 'ATTENDANCE', amount: 1 })
    );

    const result = await getPointHistory({ requestedBy: ADMIN_ID, adminDiscordId: ADMIN_ID });

    const userIds = new Set(result.map((tx) => tx.userId));
    expect(userIds.has('ph-all-1')).toBe(true);
    expect(userIds.has('ph-all-2')).toBe(true);
  });

  test('limit은 기본 10건이고, 지정하면 그만큼(1~30 사이로 강제)만 반환한다', async () => {
    await getOrCreateUser('ph-limit-1');
    // 💡 getOrCreateUser가 만든 INITIAL 1건 + 아래 35건 = 총 36건이라, 30건 상한이 실제로
    // 걸리는지(전부 다 반환되지 않는지) 확인할 수 있다.
    for (let i = 0; i < 35; i++) {
      await prisma.$transaction((tx) =>
        applyTransaction(tx, { discordId: 'ph-limit-1', type: 'ATTENDANCE', amount: 1, description: `t${i}` })
      );
    }

    const defaultResult = await getPointHistory({
      requestedBy: ADMIN_ID,
      adminDiscordId: ADMIN_ID,
      userId: 'ph-limit-1',
    });
    expect(defaultResult).toHaveLength(10);

    const cappedResult = await getPointHistory({
      requestedBy: ADMIN_ID,
      adminDiscordId: ADMIN_ID,
      userId: 'ph-limit-1',
      limit: MAX_POINT_HISTORY_LIMIT + 100,
    });
    expect(cappedResult).toHaveLength(MAX_POINT_HISTORY_LIMIT);

    const smallResult = await getPointHistory({
      requestedBy: ADMIN_ID,
      adminDiscordId: ADMIN_ID,
      userId: 'ph-limit-1',
      limit: 3,
    });
    expect(smallResult).toHaveLength(3);
    expect(smallResult[0].description).toBe('t34'); // 최신순 (마지막으로 생성된 t34가 맨 앞)
  });
});
