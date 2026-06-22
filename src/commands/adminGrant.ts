import { type ChatInputCommandInteraction, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { env } from '../config/env';
import { logBetEvent } from '../discord/betLog';
import { formatAdminGrant } from '../discord/betLogMessages';
import { grantPoints, InvalidGrantAmountError, NotAdminError } from '../services/adminGrant';

export const data = new SlashCommandBuilder()
  .setName('포인트지급')
  .setDescription('(관리자 전용) 특정 유저에게 포인트를 무상 지급합니다.')
  .addUserOption((opt) => opt.setName('대상').setDescription('포인트를 받을 유저').setRequired(true))
  .addIntegerOption((opt) =>
    opt.setName('금액').setDescription('지급할 포인트').setRequired(true).setMinValue(1)
  )
  .addStringOption((opt) => opt.setName('사유').setDescription('지급 사유').setRequired(true));

export async function execute(interaction: ChatInputCommandInteraction) {
  const target = interaction.options.getUser('대상', true);
  const amount = interaction.options.getInteger('금액', true);
  const reason = interaction.options.getString('사유', true);

  try {
    const user = await grantPoints({
      requestedBy: interaction.user.id,
      adminDiscordId: env.ADMIN_DISCORD_ID,
      targetId: target.id,
      amount,
      reason,
    });

    await interaction.reply(
      `${target.username}님에게 ${amount.toLocaleString()} 포인트를 지급했습니다. (사유: ${reason}, 현재 잔액 ${user.balance.toLocaleString()})`
    );

    await logBetEvent(interaction.client, formatAdminGrant(target.id, amount, reason));
  } catch (error) {
    if (error instanceof NotAdminError) {
      await interaction.reply({ content: '관리자만 사용할 수 있습니다.', flags: MessageFlags.Ephemeral });
      return;
    }
    if (error instanceof InvalidGrantAmountError) {
      await interaction.reply({ content: '금액은 1 이상의 정수여야 합니다.', flags: MessageFlags.Ephemeral });
      return;
    }
    throw error;
  }
}
