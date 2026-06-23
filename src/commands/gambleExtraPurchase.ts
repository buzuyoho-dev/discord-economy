import { type ChatInputCommandInteraction, MessageFlags, SlashCommandBuilder } from 'discord.js';
import {
  AlreadyPurchasedGambleExtraError,
  GAMBLE_EXTRA_PURCHASE_PRICE,
  InsufficientBalanceForGambleExtraPurchaseError,
  purchaseGambleExtra,
} from '../services/gamble';

export const data = new SlashCommandBuilder()
  .setName('도박추가')
  .setDescription(
    `${GAMBLE_EXTRA_PURCHASE_PRICE.toLocaleString()} 포인트로 오늘 도박 가능 횟수를 1회 추가 구매합니다 (1일 1회).`
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  try {
    const result = await purchaseGambleExtra({ discordId: interaction.user.id });

    await interaction.reply({
      content: `🎲 도박추가 구매 완료! -${GAMBLE_EXTRA_PURCHASE_PRICE.toLocaleString()} 포인트 (현재 잔액 ${result.balanceAfter.toLocaleString()}). 오늘 도박을 1회 더 할 수 있습니다.`,
      flags: MessageFlags.Ephemeral,
    });
  } catch (error) {
    if (error instanceof AlreadyPurchasedGambleExtraError) {
      await interaction.reply({
        content: '오늘은 이미 도박추가를 구매했습니다. 내일 다시 시도해주세요.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (error instanceof InsufficientBalanceForGambleExtraPurchaseError) {
      await interaction.reply({
        content: `포인트가 부족하여 도박추가를 구매할 수 없습니다 (필요 ${GAMBLE_EXTRA_PURCHASE_PRICE.toLocaleString()} 포인트).`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    throw error;
  }
}
