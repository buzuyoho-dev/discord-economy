import { describe, expect, test } from 'vitest';
import { prisma } from '../../src/db/client';
import { NotAdminError } from '../../src/services/adminGrant';
import {
  ECONOMY_CONFIG_ID,
  getOrCreateEconomyConfig,
  InvalidEconomyConfigError,
  updateEconomyConfig,
} from '../../src/services/economyConfig';

const ADMIN_ID = 'admin-1';

describe('getOrCreateEconomyConfig', () => {
  test('row가 없으면 기본값(5%, 1.5배, 캡비율 40%, 환급공지채널)으로 지연 생성한다', async () => {
    const config = await getOrCreateEconomyConfig();

    expect(config.id).toBe(ECONOMY_CONFIG_ID);
    expect(config.rebateRate).toBe(0.05);
    expect(config.lowerTierWeight).toBe(1.5);
    expect(config.houseBalanceCapRatio).toBe(0.4);
    expect(config.rebateAnnounceChannelId).toBe('1518506716164259910');
  });

  test('이미 있으면 기존 row를 그대로 반환한다', async () => {
    await prisma.economyConfig.create({
      data: { id: ECONOMY_CONFIG_ID, rebateRate: 0.1, lowerTierWeight: 2, houseBalanceCapRatio: 0.3 },
    });

    const config = await getOrCreateEconomyConfig();

    expect(config.rebateRate).toBe(0.1);
    expect(config.lowerTierWeight).toBe(2);
    expect(config.houseBalanceCapRatio).toBe(0.3);
  });
});

describe('updateEconomyConfig', () => {
  test('관리자가 정상 값으로 갱신한다 (rebateRate는 더 이상 파라미터로 받지 않고 DB 값 그대로 유지)', async () => {
    const updated = await updateEconomyConfig({
      requestedBy: ADMIN_ID,
      adminDiscordId: ADMIN_ID,
      lowerTierWeight: 2,
      houseBalanceCapRatio: 0.3,
    });

    expect(updated.lowerTierWeight).toBe(2);
    expect(updated.houseBalanceCapRatio).toBe(0.3);
    expect(updated.rebateRate).toBe(0.05);
  });

  test('관리자가 아니면 거부한다', async () => {
    await expect(
      updateEconomyConfig({
        requestedBy: 'not-admin',
        adminDiscordId: ADMIN_ID,
        lowerTierWeight: 2,
        houseBalanceCapRatio: 0.3,
      })
    ).rejects.toThrow(NotAdminError);
  });

  test('houseBalanceCapRatio가 0 이하이거나 1 초과면 거부한다', async () => {
    await expect(
      updateEconomyConfig({
        requestedBy: ADMIN_ID,
        adminDiscordId: ADMIN_ID,
        lowerTierWeight: 1.5,
        houseBalanceCapRatio: 0,
      })
    ).rejects.toThrow(InvalidEconomyConfigError);
    await expect(
      updateEconomyConfig({
        requestedBy: ADMIN_ID,
        adminDiscordId: ADMIN_ID,
        lowerTierWeight: 1.5,
        houseBalanceCapRatio: 1.01,
      })
    ).rejects.toThrow(InvalidEconomyConfigError);
  });

  test('lowerTierWeight가 1 미만이면 거부한다 (하위 플레이어가 오히려 덜 받는 걸 방지)', async () => {
    await expect(
      updateEconomyConfig({
        requestedBy: ADMIN_ID,
        adminDiscordId: ADMIN_ID,
        lowerTierWeight: 0.9,
        houseBalanceCapRatio: 0.4,
      })
    ).rejects.toThrow(InvalidEconomyConfigError);
  });

  test('houseBalanceCapRatio=1, lowerTierWeight=1인 경계값은 허용한다', async () => {
    await expect(
      updateEconomyConfig({
        requestedBy: ADMIN_ID,
        adminDiscordId: ADMIN_ID,
        lowerTierWeight: 1,
        houseBalanceCapRatio: 1,
      })
    ).resolves.toBeDefined();
  });
});
