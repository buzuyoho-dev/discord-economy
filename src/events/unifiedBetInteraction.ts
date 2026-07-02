import {
  ActionRowBuilder,
  type ButtonInteraction,
  MessageFlags,
  ModalBuilder,
  type ModalSubmitInteraction,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { buildBetAnnouncement, mode1BetErrorMessage } from '../commands/mode1BetView';
import { prisma } from '../db/client';
import { joinUnifiedBet } from '../services/mode1Bet';

const CHOOSE_PREFIX = 'unifiedbet:choose:';
const AMOUNT_PREFIX = 'unifiedbet:amount:';

export function isUnifiedBetChooseButton(customId: string): boolean {
  return customId.startsWith(CHOOSE_PREFIX);
}

export function isUnifiedBetAmountModal(customId: string): boolean {
  return customId.startsWith(AMOUNT_PREFIX);
}

export async function handleUnifiedBetChooseButton(interaction: ButtonInteraction) {
  const [, , betId, optionId] = interaction.customId.split(':');

  const modal = new ModalBuilder()
    .setCustomId(`${AMOUNT_PREFIX}${betId}:${optionId}`)
    .setTitle('베팅 금액 입력');

  const amountInput = new TextInputBuilder()
    .setCustomId('amount')
    .setLabel('베팅할 포인트 금액 (정수, 1 이상, 상한 없음)')
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(amountInput));

  await interaction.showModal(modal);
}

export async function handleUnifiedBetAmountModal(interaction: ModalSubmitInteraction) {
  const [, , betIdRaw, optionIdRaw] = interaction.customId.split(':');
  const betId = Number(betIdRaw);
  const optionId = Number(optionIdRaw);
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
    await joinUnifiedBet({ betId, userId: interaction.user.id, optionId, amount });
    await interaction.reply({ content: '베팅 참가 완료!', flags: MessageFlags.Ephemeral });

    if (interaction.message) {
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

      await interaction.message.edit({
        content: buildBetAnnouncement(bet, participantUserIds),
        allowedMentions: { users: [] },
      });
    }
  } catch (error) {
    const message = mode1BetErrorMessage(error);
    if (!message) {
      throw error;
    }
    await interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
  }
}
