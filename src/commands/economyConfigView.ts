import { type ChatInputCommandInteraction, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { getOrCreateEconomyConfig } from '../services/economyConfig';

export const data = new SlashCommandBuilder()
  .setName('환급설정조회')
  .setDescription('현재 주간 환급 비율과 하위 플레이어 가중치를 확인합니다.');

export async function execute(interaction: ChatInputCommandInteraction) {
  const config = await getOrCreateEconomyConfig();

  await interaction.reply({
    content: [
      '**현재 환급 설정**',
      `비율: ${(config.rebateRate * 100).toFixed(1)}%`,
      `하위 플레이어 가중치: ${config.lowerTierWeight}배`,
    ].join('\n'),
    flags: MessageFlags.Ephemeral,
  });
}
