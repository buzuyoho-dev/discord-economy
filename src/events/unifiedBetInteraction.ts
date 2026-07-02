import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type ButtonInteraction,
  MessageFlags,
  ModalBuilder,
  type ModalSubmitInteraction,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { buildBetAnnouncement, mode1BetErrorMessage } from '../commands/mode1BetView';
import { prisma } from '../db/client';
import { findValidCouponForUser } from '../services/coupon';
import { joinUnifiedBet } from '../services/mode1Bet';

const CHOOSE_PREFIX = 'unifiedbet:choose:';
const COUPON_YES_PREFIX = 'unifiedbet:couponyes:';
const COUPON_NO_PREFIX = 'unifiedbet:couponno:';
const AMOUNT_PREFIX = 'unifiedbet:amount:';
const NO_COUPON = 'none';

export function isUnifiedBetChooseButton(customId: string): boolean {
  return customId.startsWith(CHOOSE_PREFIX);
}

export function isUnifiedBetCouponChoiceButton(customId: string): boolean {
  return customId.startsWith(COUPON_YES_PREFIX) || customId.startsWith(COUPON_NO_PREFIX);
}

export function isUnifiedBetAmountModal(customId: string): boolean {
  return customId.startsWith(AMOUNT_PREFIX);
}

// 참가 흐름 전체(옵션 버튼 -> 쿠폰 선택 버튼 -> 금액 모달)에 걸쳐 원본 공지 메시지 ID를 그대로
// 실어 나른다 - 쿠폰 선택 단계가 끼면 모달 제출 시점의 interaction.message가 더 이상 공지
// 메시지가 아니게 되므로(중간에 별도 에페메럴 메시지를 거침), 메시지 ID로 직접 채널에서 찾아
// 갱신해야 한다.
function buildAmountModal(betId: string, optionId: string, couponId: string, messageId: string): ModalBuilder {
  const modal = new ModalBuilder()
    .setCustomId(`${AMOUNT_PREFIX}${betId}:${optionId}:${couponId}:${messageId}`)
    .setTitle('베팅 금액 입력');

  const amountInput = new TextInputBuilder()
    .setCustomId('amount')
    .setLabel('베팅할 포인트 금액 (정수, 1 이상, 상한 없음)')
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(amountInput));
  return modal;
}

// 1단계: 옵션 버튼 클릭 - 유효한 베팅2배쿠폰이 있으면 사용 여부를 먼저 물어보고,
// 없으면 기존처럼 바로 금액 입력 모달을 띄운다.
export async function handleUnifiedBetChooseButton(interaction: ButtonInteraction) {
  const [, , betId, optionId] = interaction.customId.split(':');
  const messageId = interaction.message.id;

  const coupon = await findValidCouponForUser(interaction.user.id);
  if (!coupon) {
    await interaction.showModal(buildAmountModal(betId, optionId, NO_COUPON, messageId));
    return;
  }

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${COUPON_YES_PREFIX}${betId}:${optionId}:${coupon.id}:${messageId}`)
      .setLabel('🎟️ 쿠폰 사용하고 참가')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`${COUPON_NO_PREFIX}${betId}:${optionId}:${messageId}`)
      .setLabel('쿠폰 없이 참가')
      .setStyle(ButtonStyle.Secondary)
  );

  await interaction.reply({
    content:
      '보유하신 베팅2배쿠폰이 있습니다. 이번 참가에 사용하시겠어요? (이길 때만 순수익이 2배가 되고, 지면 쿠폰은 그대로 보존됩니다)',
    components: [row],
    flags: MessageFlags.Ephemeral,
  });
}

// 2단계: 쿠폰 사용 여부 선택 - 선택 결과를 모달 customId에 실어 금액 입력으로 넘어간다.
export async function handleUnifiedBetCouponChoiceButton(interaction: ButtonInteraction) {
  const isYes = interaction.customId.startsWith(COUPON_YES_PREFIX);
  const rest = interaction.customId.slice(
    isYes ? COUPON_YES_PREFIX.length : COUPON_NO_PREFIX.length
  );
  const parts = rest.split(':');
  const [betId, optionId, couponId, messageId] = isYes
    ? [parts[0], parts[1], parts[2], parts[3]]
    : [parts[0], parts[1], NO_COUPON, parts[2]];

  await interaction.showModal(buildAmountModal(betId, optionId, couponId, messageId));
}

// 3단계: 금액 입력 - 실제 참가 처리.
export async function handleUnifiedBetAmountModal(interaction: ModalSubmitInteraction) {
  const [, , betIdRaw, optionIdRaw, couponIdRaw, messageId] = interaction.customId.split(':');
  const betId = Number(betIdRaw);
  const optionId = Number(optionIdRaw);
  const couponId = couponIdRaw === NO_COUPON ? undefined : couponIdRaw;
  const rawAmount = interaction.fields.getTextInputValue('amount');
  const amount = Number(rawAmount);

  if (!Number.isInteger(amount) || amount <= 0) {
    await interaction.reply({
      content: '올바른 금액(1 이상의 정수)을 입력해주세요.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  try {
    await joinUnifiedBet({ betId, userId: interaction.user.id, optionId, amount, couponId });
    await interaction.reply({
      content: couponId ? '베팅 참가 완료! (쿠폰은 이겼을 때만 사용 처리됩니다)' : '베팅 참가 완료!',
      flags: MessageFlags.Ephemeral,
    });

    if (interaction.channel?.isTextBased()) {
      const bet = await prisma.bet.findUniqueOrThrow({
        where: { id: betId },
        include: { options: true },
      });
      const entries = await prisma.betEntry.findMany({
        where: { betId },
        orderBy: { joinedAt: 'asc' },
        select: { userId: true },
      });
      const participantUserIds = entries.map((entry) => entry.userId);

      await interaction.channel.messages
        .edit(messageId, {
          content: buildBetAnnouncement(bet, participantUserIds),
          allowedMentions: { users: [] },
        })
        .catch((error) => console.error('베팅 공지 메시지 갱신 실패', error));
    }
  } catch (error) {
    const message = mode1BetErrorMessage(error);
    if (!message) {
      throw error;
    }
    await interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
  }
}
