import {
  type ChatInputCommandInteraction,
  MessageFlags,
  SlashCommandBuilder,
} from 'discord.js';
import { getBalanceSummary } from '../services/balance';

const TYPE_LABELS: Record<string, string> = {
  INITIAL: '시작 지급',
  ATTENDANCE: '출석',
  BET: '베팅',
  TRANSFER: '양도',
  LOAN: '대출',
  TAX: '세금',
};

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

function formatTransactionLine(tx: {
  type: string;
  amount: number;
  balanceAfter: number;
  description: string | null;
  createdAt: Date;
}) {
  const sign = tx.amount >= 0 ? '+' : '';
  const date = tx.createdAt.toISOString().slice(0, 19).replace('T', ' ');
  const label = TYPE_LABELS[tx.type] ?? tx.type;
  const desc = tx.description ? ` - ${tx.description}` : '';
  return `\`${date}\` ${label} ${sign}${tx.amount.toLocaleString()} (잔액 ${tx.balanceAfter.toLocaleString()})${desc}`;
}
