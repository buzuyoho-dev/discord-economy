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

const OPTION_FIELDS = ['옵션1', '옵션2', '옵션3', '옵션4', '옵션5'] as const;

export const data = new SlashCommandBuilder()
  .setName('베팅개설')
  .setDescription('모드1(동일 금액) 베팅을 개설합니다.')
  .addStringOption((opt) => opt.setName('제목').setDescription('베팅 주제').setRequired(true))
  .addIntegerOption((opt) =>
    opt.setName('금액').setDescription('참가 금액 (전원 동일)').setRequired(true).setMinValue(1)
  )
  .addStringOption((opt) => opt.setName('옵션1').setDescription('선택지 1').setRequired(true))
  .addStringOption((opt) => opt.setName('옵션2').setDescription('선택지 2').setRequired(true))
  .addStringOption((opt) => opt.setName('옵션3').setDescription('선택지 3').setRequired(false))
  .addStringOption((opt) => opt.setName('옵션4').setDescription('선택지 4').setRequired(false))
  .addStringOption((opt) => opt.setName('옵션5').setDescription('선택지 5').setRequired(false));

export async function execute(interaction: ChatInputCommandInteraction) {
  const title = interaction.options.getString('제목', true);
  const amount = interaction.options.getInteger('금액', true);
  const options = OPTION_FIELDS.map((name) => interaction.options.getString(name)).filter(
    (label): label is string => label !== null
  );

  try {
    const bet = await createBet({ creatorId: interaction.user.id, title, amount, options });

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      bet.options.map((option) =>
        new ButtonBuilder()
          .setCustomId(`mode1bet:join:${bet.id}:${option.id}`)
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
