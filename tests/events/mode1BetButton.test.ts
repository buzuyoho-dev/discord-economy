import type { ButtonInteraction } from 'discord.js';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { prisma } from '../../src/db/client';
import { logBetEvent } from '../../src/discord/betLog';
import { handleMode1BetJoinButton } from '../../src/events/mode1BetButton';

vi.mock('../../src/discord/betLog', () => ({
  logBetEvent: vi.fn(),
}));

// handleMode1BetJoinButton은 레거시(LEGACY_MODE1) 베팅 전용이다. createBet()은 이제 UNIFIED
// 베팅만 만들기 때문에, 레거시 모양의 픽스처는 Prisma로 직접 만든다.
async function createLegacyBet(params: {
  creatorId: string;
  title: string;
  amount: number;
  options: string[];
}) {
  return prisma.bet.create({
    data: {
      creatorId: params.creatorId,
      title: params.title,
      amount: params.amount,
      mode: 'LEGACY_MODE1',
      options: { create: params.options.map((label) => ({ label })) },
    },
    include: { options: true },
  });
}

function makeJoinInteraction(betId: number, optionId: number, userId: string): ButtonInteraction {
  return {
    customId: `mode1bet:join:${betId}:${optionId}`,
    user: { id: userId },
    client: {},
    reply: vi.fn().mockResolvedValue(undefined),
    message: { edit: vi.fn().mockResolvedValue(undefined) },
  } as unknown as ButtonInteraction;
}

describe('handleMode1BetJoinButton', () => {
  afterEach(() => {
    vi.mocked(logBetEvent).mockClear();
  });

  test('참가 처리는 정상적으로 일어나지만 베팅-로그 채널에는 기록하지 않는다', async () => {
    const bet = await createLegacyBet({
      creatorId: 'creator-log-1',
      title: '참가 로그 비기록 테스트',
      amount: 1_000,
      options: ['A', 'B'],
    });

    await handleMode1BetJoinButton(makeJoinInteraction(bet.id, bet.options[0].id, 'joiner-log-1'));

    const entry = await prisma.betEntry.findUniqueOrThrow({
      where: { betId_userId: { betId: bet.id, userId: 'joiner-log-1' } },
    });
    expect(entry.optionId).toBe(bet.options[0].id);

    expect(logBetEvent).not.toHaveBeenCalled();
  });
});
