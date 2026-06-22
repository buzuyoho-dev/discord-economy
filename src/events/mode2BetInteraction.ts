import {
  ActionRowBuilder,
  type ButtonInteraction,
  MessageFlags,
  ModalBuilder,
  type ModalSubmitInteraction,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { buildMode2BetAnnouncement, mode2BetErrorMessage } from '../commands/mode2BetView';
import { prisma } from '../db/client';
import { logBetEvent } from '../discord/betLog';
import { formatMode2Join } from '../discord/betLogMessages';
import { placeMode2Bet } from '../services/mode2Bet';

const CHOOSE_PREFIX = 'mode2bet:choose:';
const AMOUNT_PREFIX = 'mode2bet:amount:';

export function isMode2BetChooseButton(customId: string): boolean {
  return customId.startsWith(CHOOSE_PREFIX);
}

export function isMode2BetAmountModal(customId: string): boolean {
  return customId.startsWith(AMOUNT_PREFIX);
}

function parseSide(raw: string): 'A' | 'B' | null {
  return raw === 'A' || raw === 'B' ? raw : null;
}

export async function handleMode2BetChooseButton(interaction: ButtonInteraction) {
  const [, , betId, sideRaw] = interaction.customId.split(':');
  const side = parseSide(sideRaw);
  if (!side) {
    return;
  }

  const modal = new ModalBuilder()
    .setCustomId(`${AMOUNT_PREFIX}${betId}:${side}`)
    .setTitle('베팅 금액 입력');

  const amountInput = new TextInputBuilder()
    .setCustomId('amount')
    .setLabel('베팅할 포인트 금액 (정수, 1 이상)')
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(amountInput));

  await interaction.showModal(modal);
}

export async function handleMode2BetAmountModal(interaction: ModalSubmitInteraction) {
  const [, , betIdRaw, sideRaw] = interaction.customId.split(':');
  const betId = Number(betIdRaw);
  const side = parseSide(sideRaw);
  const rawAmount = interaction.fields.getTextInputValue('amount');
  const amount = Number(rawAmount);

  if (!side) {
    return;
  }

  if (!Number.isInteger(amount) || amount <= 0) {
    await interaction.reply({
      content: '올바른 금액(1 이상의 정수)을 입력해주세요.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  try {
    await placeMode2Bet({ betId, userId: interaction.user.id, side, amount });
    await interaction.reply({ content: '베팅 참가 완료!', flags: MessageFlags.Ephemeral });

    const bet = await prisma.mode2Bet.findUniqueOrThrow({ where: { id: betId } });
    await logBetEvent(interaction.client, formatMode2Join(bet, interaction.user.id, amount));

    if (interaction.message) {
      const entries = await prisma.mode2Entry.findMany({
        where: { betId },
        orderBy: { joinedAt: 'asc' },
        select: { userId: true },
      });
      const participantUserIds = entries.map((entry) => entry.userId);

      await interaction.message.edit({
        content: buildMode2BetAnnouncement(bet, participantUserIds),
        allowedMentions: { users: [] },
      });
    }
  } catch (error) {
    const message = mode2BetErrorMessage(error);
    if (!message) {
      throw error;
    }
    await interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
  }
}
