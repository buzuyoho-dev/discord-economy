import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type ChatInputCommandInteraction,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { env } from '../config/env';
import { formatSettlementCancelPreview } from '../discord/betLogMessages';
import { NotAdminError } from '../services/adminGrant';
import { BetNotFoundError, BetNotSettledError } from '../services/betShared';
import { previewSettlementCancellation } from '../services/settlementCancellation';

export const data = new SlashCommandBuilder()
  .setName('정산취소')
  .setDescription('(관리자 전용) 잘못 정산된 베팅을 취소하고 참가자 잔액을 상쇄합니다.')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addIntegerOption((opt) => opt.setName('베팅id').setDescription('베팅 ID').setRequired(true));

export async function execute(interaction: ChatInputCommandInteraction) {
  const betId = interaction.options.getInteger('베팅id', true);

  try {
    const plan = await previewSettlementCancellation({
      betId,
      requestedBy: interaction.user.id,
      adminDiscordId: env.ADMIN_DISCORD_ID,
    });

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`settlementcancel:confirm:${betId}`)
        .setLabel('확인')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(`settlementcancel:cancel:${betId}`)
        .setLabel('취소')
        .setStyle(ButtonStyle.Secondary)
    );

    await interaction.reply({
      content: formatSettlementCancelPreview(plan),
      components: [row],
      flags: MessageFlags.Ephemeral,
    });
  } catch (error) {
    if (error instanceof NotAdminError) {
      await interaction.reply({ content: '관리자만 사용할 수 있습니다.', flags: MessageFlags.Ephemeral });
      return;
    }
    if (error instanceof BetNotFoundError) {
      await interaction.reply({ content: '해당 베팅을 찾을 수 없습니다.', flags: MessageFlags.Ephemeral });
      return;
    }
    if (error instanceof BetNotSettledError) {
      await interaction.reply({ content: '정산되지 않은 베팅입니다.', flags: MessageFlags.Ephemeral });
      return;
    }
    throw error;
  }
}
