import { type ChatInputCommandInteraction, SlashCommandBuilder } from 'discord.js';
import { getRankings } from '../services/ranking';

export const data = new SlashCommandBuilder()
  .setName('순위')
  .setDescription('보유 포인트 기준 실시간 순위를 확인합니다.');

export async function execute(interaction: ChatInputCommandInteraction) {
  const rankings = await getRankings();

  if (rankings.length === 0) {
    await interaction.reply('아직 등록된 유저가 없습니다.');
    return;
  }

  const lines = rankings.map(
    (entry) =>
      `**${entry.rank}위** [${entry.tier}] <@${entry.discordId}> — ${entry.balance.toLocaleString()} 포인트`
  );

  await interaction.reply({
    content: lines.join('\n'),
    allowedMentions: { users: [] },
  });
}
