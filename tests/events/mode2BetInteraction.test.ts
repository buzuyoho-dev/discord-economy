import type { ModalSubmitInteraction } from 'discord.js';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { prisma } from '../../src/db/client';
import { logBetEvent } from '../../src/discord/betLog';
import { handleMode2BetAmountModal } from '../../src/events/mode2BetInteraction';
import { applyHouseTransaction, getOrCreateHouse } from '../../src/services/house';
import { createMode2Bet } from '../../src/services/mode2Bet';

vi.mock('../../src/discord/betLog', () => ({
  logBetEvent: vi.fn(),
}));

async function setHouseBalance(amount: number) {
  await getOrCreateHouse();
  await prisma.$transaction((tx) =>
    applyHouseTransaction(tx, { type: 'TAX', amount, description: 'test setup' })
  );
}

function makeAmountModalInteraction(
  betId: number,
  side: 'A' | 'B',
  userId: string,
  amount: string
): ModalSubmitInteraction {
  return {
    customId: `mode2bet:amount:${betId}:${side}`,
    user: { id: userId },
    client: {},
    reply: vi.fn().mockResolvedValue(undefined),
    message: null,
    fields: { getTextInputValue: () => amount },
  } as unknown as ModalSubmitInteraction;
}

describe('handleMode2BetAmountModal', () => {
  afterEach(() => {
    vi.mocked(logBetEvent).mockClear();
  });

  test('참가 처리는 정상적으로 일어나지만 베팅-로그 채널에는 기록하지 않는다', async () => {
    await setHouseBalance(10_000_000);
    const bet = await createMode2Bet({
      creatorId: 'creator-log-2',
      title: '참가 로그 비기록 테스트',
      sideALabel: 'A팀',
      sideBLabel: 'B팀',
    });

    await handleMode2BetAmountModal(
      makeAmountModalInteraction(bet.id, 'A', 'joiner-log-2', '1000')
    );

    const entry = await prisma.mode2Entry.findUniqueOrThrow({
      where: { betId_userId: { betId: bet.id, userId: 'joiner-log-2' } },
    });
    expect(entry.side).toBe('A');

    expect(logBetEvent).not.toHaveBeenCalled();
  });
});
