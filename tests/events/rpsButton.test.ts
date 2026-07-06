import { randomUUID } from 'node:crypto';
import type { ButtonInteraction } from 'discord.js';
import { describe, expect, test, vi } from 'vitest';
import { prisma } from '../../src/db/client';
import {
  assertAuthorizedResponder,
  handleRpsActionButton,
  UnauthorizedResponderError,
} from '../../src/events/rpsButton';
import { pendingRpsChallenges } from '../../src/events/rpsState';
import { getOrCreateUser } from '../../src/services/ledger';

describe('assertAuthorizedResponder', () => {
  test('지목된 상대방 본인이 클릭했으면 통과한다', () => {
    expect(() => assertAuthorizedResponder('opponent-1', 'opponent-1')).not.toThrow();
  });

  test('지목된 상대방이 아닌 다른 사람이 클릭했으면 거부한다', () => {
    expect(() => assertAuthorizedResponder('someone-else', 'opponent-1')).toThrow(
      UnauthorizedResponderError
    );
  });

  test('챌린저 본인이 눌러도(자기 도전에) 거부한다', () => {
    expect(() => assertAuthorizedResponder('challenger-1', 'opponent-1')).toThrow(
      UnauthorizedResponderError
    );
  });
});

function makeAcceptInteraction(params: {
  challengeId: string;
  userId: string;
  action: 'rock' | 'paper' | 'scissors';
}): ButtonInteraction {
  return {
    customId: `rps:${params.action}:${params.challengeId}`,
    user: { id: params.userId },
    deferUpdate: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
  } as unknown as ButtonInteraction;
}

// 💡 editReply에 실려간 임베드에서 "결과" 필드 문구 하나만 뽑아주는 헬퍼.
// (buildVoidEmbed는 fields[0]에 결과 문구를 담는다 - rpsView.ts 참고)
function getResultFieldValue(interaction: ButtonInteraction): string | undefined {
  const replyArg = vi.mocked(interaction.editReply).mock.calls[0][0] as {
    embeds: Array<{ toJSON(): { description?: string; fields?: Array<{ name: string; value: string }> } }>;
  };
  return replyArg.embeds[0].toJSON().fields?.[0]?.value;
}

describe('handleRpsActionButton - 정산 시점 잔액 재검증', () => {
  test('상대(수락자)의 잔액이 부족해서 무효 처리되면, 메시지에 상대방 멘션이 포함된다', async () => {
    const challengerId = 'rps-button-challenger-1'; // C: 도전을 건 쪽
    const opponentId = 'rps-button-opponent-1'; // A: 이미 다른 대결에서 져서 잔액이 0인 쪽
    await getOrCreateUser(challengerId);
    await getOrCreateUser(opponentId);
    await prisma.user.update({ where: { discordId: opponentId }, data: { balance: 0 } });

    const challengeId = randomUUID();
    pendingRpsChallenges.set(challengeId, {
      challengerId,
      opponentId,
      betAmount: 1_000_000,
      challengerChoice: '바위',
      timeout: setTimeout(() => {}, 1_000_000),
    });

    const interaction = makeAcceptInteraction({ challengeId, userId: opponentId, action: 'rock' });

    await handleRpsActionButton(interaction);

    // 💡 대기 목록에서는 즉시 제거되어(재사용 방지), 정산 실패 여부와 무관하게 다시 응답할 수 없다.
    expect(pendingRpsChallenges.has(challengeId)).toBe(false);

    expect(interaction.editReply).toHaveBeenCalledTimes(1);
    // 💡 잔액이 부족했던 쪽(A = opponentId)의 멘션이 메시지에 찍혀야 한다. 엉뚱하게
    // 챌린저(C)를 지목하면 안 된다.
    const resultText = getResultFieldValue(interaction);
    expect(resultText).toContain(`<@${opponentId}>`);
    expect(resultText).not.toContain(`<@${challengerId}>`);
    expect(resultText).toContain('보유 포인트가 부족해서 무효 처리되었습니다');

    // 💡 재검증 단계에서 막혔으므로 실제로는 아무도 차감되지 않아야 한다.
    const opponent = await prisma.user.findUniqueOrThrow({ where: { discordId: opponentId } });
    expect(opponent.balance).toBe(0);
  });

  test('챌린저(도전자)의 잔액이 줄어 베팅 한도를 넘겨 무효 처리되면, 메시지에 챌린저 멘션이 포함된다', async () => {
    const challengerId = 'rps-button-challenger-2'; // C: 도전을 걸었지만, 그 사이 잔액이 줄어든 쪽
    const opponentId = 'rps-button-opponent-2'; // A: 잔액은 충분한 쪽
    await getOrCreateUser(challengerId);
    await getOrCreateUser(opponentId);
    // 💡 베팅금(1,000,000)이 챌린저의 새 잔액(2,000,000)의 25%(500,000)를 넘도록 만든다.
    // -> 정산 재검증(validateBetAmount)에서 BetTooLargeError가 난다.
    await prisma.user.update({ where: { discordId: challengerId }, data: { balance: 2_000_000 } });

    const challengeId = randomUUID();
    pendingRpsChallenges.set(challengeId, {
      challengerId,
      opponentId,
      betAmount: 1_000_000,
      challengerChoice: '바위',
      timeout: setTimeout(() => {}, 1_000_000),
    });

    const interaction = makeAcceptInteraction({ challengeId, userId: opponentId, action: 'scissors' });

    await handleRpsActionButton(interaction);

    expect(interaction.editReply).toHaveBeenCalledTimes(1);
    // 💡 이번엔 반대로 챌린저(C)의 멘션이 찍혀야 한다.
    const resultText = getResultFieldValue(interaction);
    expect(resultText).toContain(`<@${challengerId}>`);
    expect(resultText).not.toContain(`<@${opponentId}>`);
    expect(resultText).toContain('보유 포인트가 부족해서 무효 처리되었습니다');

    const challenger = await prisma.user.findUniqueOrThrow({ where: { discordId: challengerId } });
    expect(challenger.balance).toBe(2_000_000); // 차감 없음
  });
});
