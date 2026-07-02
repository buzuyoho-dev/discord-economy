import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type ChatInputCommandInteraction,
  MessageFlags,
  SlashCommandBuilder,
} from 'discord.js';
import { logBetEvent } from '../discord/betLog';
import { formatMode1Create } from '../discord/betLogMessages';
import { createBet } from '../services/mode1Bet';
import { buildBetAnnouncement, mode1BetErrorMessage } from './mode1BetView';

export const data = new SlashCommandBuilder()
  .setName('베팅개설')
  .setDescription('베팅을 개설합니다 (자유 금액, 진 쪽 총액을 이긴 쪽이 베팅액 비율로 나눠 가짐).')
  .addStringOption((opt) => opt.setName('제목').setDescription('베팅 주제').setRequired(true))
  .addStringOption((opt) => opt.setName('옵션1').setDescription('선택지 1').setRequired(true))
  .addStringOption((opt) => opt.setName('옵션2').setDescription('선택지 2').setRequired(true));

export async function execute(interaction: ChatInputCommandInteraction) {
  const title = interaction.options.getString('제목', true);
  const option1 = interaction.options.getString('옵션1', true);
  const option2 = interaction.options.getString('옵션2', true);

  try {
    const bet = await createBet({
      creatorId: interaction.user.id,
      title,
      options: [option1, option2],
    });

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      bet.options.map((option) =>
        new ButtonBuilder()
          .setCustomId(`unifiedbet:choose:${bet.id}:${option.id}`)
          .setLabel(option.label)
          .setStyle(ButtonStyle.Primary)
      )
    );

    await interaction.reply({
      content: buildBetAnnouncement(bet, []),
      components: [row],
      allowedMentions: { users: [] },
    });

    await logBetEvent(interaction.client, formatMode1Create(bet));
  } catch (error) {
    const message = mode1BetErrorMessage(error);
    if (!message) {
      throw error;
    }
    await interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
  }
}
