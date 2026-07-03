import {
  type ChatInputCommandInteraction,
  MessageFlags,
  SlashCommandBuilder,
} from 'discord.js';
import { formatTransactionLine } from '../discord/transactionView';
import { getBalanceSummary } from '../services/balance';

export const data = new SlashCommandBuilder()
  .setName('잔액')
  .setDescription('내 포인트 잔액과 최근 거래 내역을 확인합니다.');

export async function execute(interaction: ChatInputCommandInteraction) {
  const summary = await getBalanceSummary(interaction.user.id);

  const historyLines = summary.recentTransactions.length
    ? summary.recentTransactions.map(formatTransactionLine).join('\n')
    : '거래 내역이 없습니다.';

  await interaction.reply({
    content: `**현재 잔액: ${summary.balance.toLocaleString()} 포인트**\n\n최근 거래 내역\n${historyLines}`,
    flags: MessageFlags.Ephemeral,
  });
}
