import { type ButtonInteraction, MessageFlags } from 'discord.js';
import { buildBetAnnouncement, mode1BetErrorMessage } from '../commands/mode1BetView';
import { prisma } from '../db/client';
import { joinBet } from '../services/mode1Bet';

const CUSTOM_ID_PREFIX = 'mode1bet:join:';

export function isMode1BetJoinButton(customId: string): boolean {
  return customId.startsWith(CUSTOM_ID_PREFIX);
}

export async function handleMode1BetJoinButton(interaction: ButtonInteraction) {
  const [, , betIdRaw, optionIdRaw] = interaction.customId.split(':');
  const betId = Number(betIdRaw);
  const optionId = Number(optionIdRaw);

  try {
    await joinBet({ betId, userId: interaction.user.id, optionId });

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

    await interaction.reply({ content: '베팅 참가 완료!', flags: MessageFlags.Ephemeral });
    await interaction.message.edit({
      content: buildBetAnnouncement(bet, participantUserIds),
      allowedMentions: { users: [] },
    });
  } catch (error) {
    const message = mode1BetErrorMessage(error);
    if (!message) {
      throw error;
    }
    await interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
  }
}
