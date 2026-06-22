import { type ChatInputCommandInteraction, SlashCommandBuilder } from 'discord.js';
import { getHouseStatus } from '../services/house';

export const data = new SlashCommandBuilder()
  .setName('하우스')
  .setDescription('하우스의 현재 잔액과 전체 경제 점유율을 확인합니다.');

export function formatHouseStatusMessage(balance: number, share: number): string {
  const sharePercent = (share * 100).toFixed(1);
  return `🏦 하우스 현재 잔액: ${balance.toLocaleString()} 포인트 (전체 경제의 ${sharePercent}%)`;
}

export async function execute(interaction: ChatInputCommandInteraction) {
  const { balance, share } = await getHouseStatus();
  await interaction.reply(formatHouseStatusMessage(balance, share));
}
