import { type ChatInputCommandInteraction, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { logBetEvent } from '../discord/betLog';
import { formatGamble } from '../discord/betLogMessages';
import {
  DailyGambleLimitExceededError,
  GAMBLE_AMOUNT,
  gamble,
  InsufficientBalanceForGambleError,
  MAX_GAMBLES_PER_DAY,
} from '../services/gamble';

export const data = new SlashCommandBuilder()
  .setName('도박')
  .setDescription(
    `50% 확률로 ${GAMBLE_AMOUNT.toLocaleString()} 포인트를 따거나 잃습니다 (하루 최대 ${MAX_GAMBLES_PER_DAY}회).`
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  try {
    const result = await gamble({ discordId: interaction.user.id });

    const message = result.won
      ? `🎲 도박 성공! +${GAMBLE_AMOUNT.toLocaleString()} 포인트 (현재 잔액 ${result.balanceAfter.toLocaleString()})`
      : `🎲 도박 실패... -${GAMBLE_AMOUNT.toLocaleString()} 포인트 (현재 잔액 ${result.balanceAfter.toLocaleString()})`;

    await interaction.reply(message);

    await logBetEvent(interaction.client, formatGamble(interaction.user.id, result));
  } catch (error) {
    if (error instanceof DailyGambleLimitExceededError) {
      await interaction.reply({
        content: `오늘 도박 횟수(${MAX_GAMBLES_PER_DAY}회)를 모두 사용했습니다. 내일 다시 시도해주세요.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (error instanceof InsufficientBalanceForGambleError) {
      await interaction.reply({
        content: '포인트가 부족하여 도박할 수 없습니다.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    throw error;
  }
}
