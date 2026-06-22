import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type ChatInputCommandInteraction,
  MessageFlags,
  SlashCommandBuilder,
} from 'discord.js';
import { logBetEvent } from '../discord/betLog';
import { formatMode2Create } from '../discord/betLogMessages';
import { createMode2Bet } from '../services/mode2Bet';
import { buildMode2BetAnnouncement, mode2BetErrorMessage } from './mode2BetView';

export const data = new SlashCommandBuilder()
  .setName('모드2베팅개설')
  .setDescription('모드2(자유 금액) 베팅을 개설합니다.')
  .addStringOption((opt) => opt.setName('제목').setDescription('베팅 주제').setRequired(true))
  .addStringOption((opt) => opt.setName('사이드a').setDescription('A쪽 이름').setRequired(true))
  .addStringOption((opt) => opt.setName('사이드b').setDescription('B쪽 이름').setRequired(true));

export async function execute(interaction: ChatInputCommandInteraction) {
  const title = interaction.options.getString('제목', true);
  const sideALabel = interaction.options.getString('사이드a', true);
  const sideBLabel = interaction.options.getString('사이드b', true);

  try {
    const bet = await createMode2Bet({ creatorId: interaction.user.id, title, sideALabel, sideBLabel });

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`mode2bet:choose:${bet.id}:A`)
        .setLabel(bet.sideALabel)
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`mode2bet:choose:${bet.id}:B`)
        .setLabel(bet.sideBLabel)
        .setStyle(ButtonStyle.Primary)
    );

    await interaction.reply({
      content: buildMode2BetAnnouncement(bet, []),
      components: [row],
      allowedMentions: { users: [] },
    });

    await logBetEvent(interaction.client, formatMode2Create(bet));
  } catch (error) {
    const message = mode2BetErrorMessage(error);
    if (!message) {
      throw error;
    }
    await interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
  }
}
