import { describe, expect, test } from 'vitest';
import { prisma } from '../../src/db/client';
import { BotTargetError } from '../../src/services/discordTargetGuard';
import { getOrCreateHouse, HOUSE_ID } from '../../src/services/house';
import { getOrCreateUser } from '../../src/services/ledger';
import { grantPoints, InvalidGrantAmountError, NotAdminError } from '../../src/services/adminGrant';

const ADMIN_ID = 'admin-1';

describe('grantPoints - 권한', () => {
  test('관리자 ID가 아닌 유저가 시도하면 거부되고 잔액이 변하지 않는다', async () => {
    await getOrCreateUser('target-1');

    await expect(
      grantPoints({
        requestedBy: 'not-admin',
        adminDiscordId: ADMIN_ID,
        targetId: 'target-1',
        amount: 1_000_000,
        reason: '테스트',
      })
    ).rejects.toThrow(NotAdminError);

    const target = await prisma.user.findUniqueOrThrow({ where: { discordId: 'target-1' } });
    expect(target.balance).toBe(10_000_000);

    const txs = await prisma.transaction.findMany({ where: { userId: 'target-1', type: 'ADMIN_GRANT' } });
    expect(txs).toHaveLength(0);
  });

  test('ADMIN_DISCORD_ID가 설정되지 않았으면(undefined) 누구도 사용할 수 없다', async () => {
    await getOrCreateUser('target-2');

    await expect(
      grantPoints({
        requestedBy: ADMIN_ID,
        adminDiscordId: undefined,
        targetId: 'target-2',
        amount: 1_000_000,
        reason: '테스트',
      })
    ).rejects.toThrow(NotAdminError);

    const target = await prisma.user.findUniqueOrThrow({ where: { discordId: 'target-2' } });
    expect(target.balance).toBe(10_000_000);
  });
});

describe('grantPoints - 봇 대상 차단', () => {
  test('대상이 봇이면 거부되고 User row 자체가 생성되지 않는다', async () => {
    await expect(
      grantPoints({
        requestedBy: ADMIN_ID,
        adminDiscordId: ADMIN_ID,
        targetId: 'bot-1',
        targetIsBot: true,
        amount: 1_000_000,
        reason: '테스트',
      })
    ).rejects.toThrow(BotTargetError);

    const botUser = await prisma.user.findUnique({ where: { discordId: 'bot-1' } });
    expect(botUser).toBeNull();
  });
});

describe('grantPoints - 정상 지급', () => {
  test('관리자가 지급하면 대상 잔액이 늘고 ADMIN_GRANT 거래가 기록되며 하우스는 변하지 않는다', async () => {
    await getOrCreateUser('target-3');
    await getOrCreateHouse();

    const result = await grantPoints({
      requestedBy: ADMIN_ID,
      adminDiscordId: ADMIN_ID,
      targetId: 'target-3',
      amount: 5_000_000,
      reason: '이벤트 우승 보상',
    });

    expect(result.balance).toBe(10_000_000 + 5_000_000);

    const target = await prisma.user.findUniqueOrThrow({ where: { discordId: 'target-3' } });
    expect(target.balance).toBe(10_000_000 + 5_000_000);

    const txs = await prisma.transaction.findMany({ where: { userId: 'target-3', type: 'ADMIN_GRANT' } });
    expect(txs).toHaveLength(1);
    expect(txs[0].amount).toBe(5_000_000);
    expect(txs[0].balanceAfter).toBe(10_000_000 + 5_000_000);
    expect(txs[0].description).toBe('이벤트 우승 보상');

    const house = await prisma.house.findUniqueOrThrow({ where: { id: HOUSE_ID } });
    expect(house.balance).toBe(0);
    const houseTxs = await prisma.houseTransaction.findMany();
    expect(houseTxs).toHaveLength(0);
  });

  test('대상 유저가 아직 존재하지 않아도 자동으로 생성되어 지급된다', async () => {
    const result = await grantPoints({
      requestedBy: ADMIN_ID,
      adminDiscordId: ADMIN_ID,
      targetId: 'target-brand-new',
      amount: 1_000_000,
      reason: '신규 유저 테스트',
    });

    expect(result.balance).toBe(10_000_000 + 1_000_000);
  });
});

describe('grantPoints - 금액 검증', () => {
  test.each([0, -1, 1.5, NaN, Infinity, -Infinity])('금액이 %s이면 거부되고 잔액이 변하지 않는다', async (amount) => {
    await getOrCreateUser('target-invalid-amount');

    await expect(
      grantPoints({
        requestedBy: ADMIN_ID,
        adminDiscordId: ADMIN_ID,
        targetId: 'target-invalid-amount',
        amount,
        reason: '테스트',
      })
    ).rejects.toThrow(InvalidGrantAmountError);

    const target = await prisma.user.findUniqueOrThrow({ where: { discordId: 'target-invalid-amount' } });
    expect(target.balance).toBe(10_000_000);

    const txs = await prisma.transaction.findMany({
      where: { userId: 'target-invalid-amount', type: 'ADMIN_GRANT' },
    });
    expect(txs).toHaveLength(0);
  });
});
