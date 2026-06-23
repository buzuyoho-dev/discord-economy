import { type ChatInputCommandInteraction, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { env } from '../config/env';
import { logBetEvent } from '../discord/betLog';
import { formatGamble } from '../discord/betLogMessages';
import { GAMBLE_AMOUNT, gamble, MAX_GAMBLES_PER_DAY } from '../services/gamble';
import { gambleErrorMessage } from './gambleView';

export const data = new SlashCommandBuilder()
  .setName('도박')
  .setDescription(
    `50% 확률로 ${GAMBLE_AMOUNT.toLocaleString()} 포인트를 따거나 잃습니다 (하루 최대 ${MAX_GAMBLES_PER_DAY}회).`
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  if (!env.GAMBLE_ENABLED) {
    await interaction.reply({ content: '현재 점검 중입니다. 잠시 후 다시 시도해주세요.', flags: MessageFlags.Ephemeral });
    return;
  }

  try {
    const result = await gamble({ discordId: interaction.user.id });

    const message = result.won
      ? `🎲 도박 성공! +${GAMBLE_AMOUNT.toLocaleString()} 포인트 (현재 잔액 ${result.balanceAfter.toLocaleString()})`
      : `🎲 도박 실패... -${GAMBLE_AMOUNT.toLocaleString()} 포인트 (현재 잔액 ${result.balanceAfter.toLocaleString()})`;

    await interaction.reply(message);

    await logBetEvent(interaction.client, formatGamble(interaction.user.id, result));
  } catch (error) {
    const message = gambleErrorMessage(error);
    if (!message) {
      throw error;
    }
    await interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
  }
}
