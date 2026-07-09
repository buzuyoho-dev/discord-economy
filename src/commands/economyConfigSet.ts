import {
  type ChatInputCommandInteraction,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { env } from '../config/env';
import { NotAdminError } from '../services/adminGrant';
import { InvalidEconomyConfigError, updateEconomyConfig } from '../services/economyConfig';

export const data = new SlashCommandBuilder()
  .setName('환급설정')
  .setDescription('(관리자 전용) 하위 플레이어 가중치와 하우스 캡 비율을 설정합니다.')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addNumberOption((opt) =>
    opt
      .setName('가중치')
      .setDescription('하위 플레이어 가중치 (1 이상, 예: 1.5 = 1.5배)')
      .setRequired(true)
      .setMinValue(1)
  )
  .addNumberOption((opt) =>
    opt
      .setName('캡비율')
      .setDescription('하우스 잔고 상한 비율 (0 초과 1 이하, 예: 0.4 = 40%)')
      .setRequired(true)
      .setMinValue(0.01)
      .setMaxValue(1)
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  const lowerTierWeight = interaction.options.getNumber('가중치', true);
  const houseBalanceCapRatio = interaction.options.getNumber('캡비율', true);

  try {
    const updated = await updateEconomyConfig({
      requestedBy: interaction.user.id,
      adminDiscordId: env.ADMIN_DISCORD_ID,
      lowerTierWeight,
      houseBalanceCapRatio,
    });

    await interaction.reply({
      content: [
        '✅ 환급 설정을 변경했습니다. 다음 배치부터 즉시 반영됩니다.',
        `하위 플레이어 가중치: ${updated.lowerTierWeight}배`,
        `하우스 캡 비율: ${(updated.houseBalanceCapRatio * 100).toFixed(1)}%`,
      ].join('\n'),
      flags: MessageFlags.Ephemeral,
    });
  } catch (error) {
    if (error instanceof NotAdminError) {
      await interaction.reply({ content: '관리자만 사용할 수 있습니다.', flags: MessageFlags.Ephemeral });
      return;
    }
    if (error instanceof InvalidEconomyConfigError) {
      await interaction.reply({
        content: '가중치는 1 이상, 캡 비율은 0 초과 1 이하여야 합니다.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    throw error;
  }
}
