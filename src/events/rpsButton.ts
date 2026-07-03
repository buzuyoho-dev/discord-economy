// 💡 이 파일은 상대방이 [거절하기]/[가위]/[바위]/[보] 버튼을 눌렀을 때(또는 10분 동안
// 아무것도 안 눌러서 자동으로 무효 처리될 때) 무슨 일이 일어나는지를 담당한다.
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type ButtonInteraction,
  type Message,
} from 'discord.js';
import { MessageFlags } from 'discord.js';
import { buildResultEmbed, buildVoidEmbed } from '../discord/rpsView';
import type { RpsChoice } from '../services/rps';
import { resolveRpsChallenge } from '../services/rpsGame';
import { pendingRpsChallenges } from './rpsState';

const CUSTOM_ID_PREFIX = 'rps:';
export const RPS_ACTION_TIMEOUT_MS = 10 * 60 * 1000; // 💡 10분 (디스코드 인터랙션 토큰 15분 제약보다 짧음)

type RpsButtonAction = 'reject' | 'scissors' | 'rock' | 'paper';

// 💡 customId에는 "가위/바위/보 중 무엇을 눌렀는지"만 담긴다 - 이건 상대방이 지금 막 누른
// 값이라 공개되어도 상관없다. 챌린저가 미리 낸 선택(challengerChoice)은 여기 절대 안 들어간다.
const ACTION_TO_CHOICE: Record<'scissors' | 'rock' | 'paper', RpsChoice> = {
  scissors: '가위',
  rock: '바위',
  paper: '보',
};

export function isRpsActionButton(customId: string): boolean {
  return customId.startsWith(CUSTOM_ID_PREFIX);
}

// 💡 [거절하기]/[가위]/[바위]/[보] 4개 버튼 줄을 만든다. customId에는 challengeId(무작위 문자열)만
// 실어 보낸다 - 이 문자열 자체로는 챌린저가 뭘 냈는지 절대 알아낼 수 없다.
export function buildActionRow(challengeId: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${CUSTOM_ID_PREFIX}reject:${challengeId}`)
      .setLabel('거절하기')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`${CUSTOM_ID_PREFIX}scissors:${challengeId}`)
      .setLabel('가위')
      .setEmoji('✂️')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`${CUSTOM_ID_PREFIX}rock:${challengeId}`)
      .setLabel('바위')
      .setEmoji('🪨')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`${CUSTOM_ID_PREFIX}paper:${challengeId}`)
      .setLabel('보')
      .setEmoji('📄')
      .setStyle(ButtonStyle.Primary)
  );
}

export class UnauthorizedResponderError extends Error {}

// 💡 이 버튼을 누른 사람이 정말 "지목된 상대방 본인"이 맞는지 확인한다. 디스코드는 "이 버튼은
// 이 사람만 눌러야 한다"는 걸 기본으로 막아주지 않기 때문에, 코드에서 직접 확인해야 한다.
export function assertAuthorizedResponder(clickerId: string, opponentId: string): void {
  if (clickerId !== opponentId) {
    throw new UnauthorizedResponderError(
      `${clickerId} is not authorized to respond (expected ${opponentId})`
    );
  }
}

// 💡 10분 타임아웃 전용: 그 시점엔 살아있는 interaction이 없으므로(그냥 타이머라서),
// discord.js의 Message 객체를 직접 받아서 그걸로 메시지를 수정(edit)한다.
export async function voidRpsChallengeByTimeout(params: {
  challengeId: string;
  message: Message;
}): Promise<void> {
  const challenge = pendingRpsChallenges.get(params.challengeId);
  if (!challenge) {
    // 💡 이미 다른 경로(거절/수락)로 끝나서 Map에서 지워진 도전이면 아무것도 하지 않는다.
    return;
  }

  clearTimeout(challenge.timeout);
  pendingRpsChallenges.delete(params.challengeId);

  const embed = buildVoidEmbed({
    challengerId: challenge.challengerId,
    opponentId: challenge.opponentId,
    betAmount: challenge.betAmount,
    reason: 'TIMEOUT',
  });

  await params.message.edit({ embeds: [embed], components: [] }).catch((error) => {
    console.error('가위바위보 타임아웃 메시지 갱신 실패', error);
  });
}

export async function handleRpsActionButton(interaction: ButtonInteraction): Promise<void> {
  const [, action, challengeId] = interaction.customId.split(':') as [string, RpsButtonAction, string];

  const challenge = pendingRpsChallenges.get(challengeId);
  if (!challenge) {
    await interaction.reply({ content: '이미 종료된 도전입니다.', flags: MessageFlags.Ephemeral });
    return;
  }

  try {
    assertAuthorizedResponder(interaction.user.id, challenge.opponentId);
  } catch {
    await interaction.reply({
      content: '이 버튼은 당신을 위한 것이 아닙니다.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // 💡 이 도전은 이제 끝나는 거니까(거절이든 수락이든), 10분 타이머는 취소하고 대기 목록에서 뺀다.
  clearTimeout(challenge.timeout);
  pendingRpsChallenges.delete(challengeId);

  if (action === 'reject') {
    await interaction.deferUpdate();
    const embed = buildVoidEmbed({
      challengerId: challenge.challengerId,
      opponentId: challenge.opponentId,
      betAmount: challenge.betAmount,
      reason: 'REJECTED',
    });
    await interaction.editReply({ embeds: [embed], components: [] });
    return;
  }

  // 💡 가위/바위/보 중 하나를 눌렀다 = 대결을 수락했다는 뜻. 이제 챌린저의 선택(메모리에만
  // 있던 값)과 방금 상대방이 누른 선택을 합쳐서 정산까지 한 번에 처리한다.
  const opponentChoice = ACTION_TO_CHOICE[action as 'scissors' | 'rock' | 'paper'];
  await interaction.deferUpdate();

  try {
    const settled = await resolveRpsChallenge({
      challengerId: challenge.challengerId,
      opponentId: challenge.opponentId,
      betAmount: challenge.betAmount,
      challengerChoice: challenge.challengerChoice,
      opponentChoice,
    });

    const embed = buildResultEmbed({
      challengerId: challenge.challengerId,
      opponentId: challenge.opponentId,
      challengerChoice: challenge.challengerChoice,
      opponentChoice,
      betAmount: challenge.betAmount,
      result: settled.result,
      challengerBalanceAfter: settled.challengerBalanceAfter,
      opponentBalanceAfter: settled.opponentBalanceAfter,
    });
    await interaction.editReply({ embeds: [embed], components: [] });
  } catch (error) {
    // 💡 도전 시작 이후 시간이 지나는 동안 누군가의 잔액이 바뀌어서(다른 곳에 다 써버림 등)
    // 정산 시점 재검증에 실패한 경우. 트랜잭션이 통째로 취소되므로 실제 차감은 없었다.
    console.error('가위바위보 정산 실패 - 무효 처리', error);
    const embed = buildVoidEmbed({
      challengerId: challenge.challengerId,
      opponentId: challenge.opponentId,
      betAmount: challenge.betAmount,
      reason: 'INVALID_BALANCE',
    });
    await interaction.editReply({ embeds: [embed], components: [] });
  }
}
