import { type ChatInputCommandInteraction, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { logBetEvent } from '../discord/betLog';
import { formatMode2Close } from '../discord/betLogMessages';
import { closeMode2Bet } from '../services/mode2Bet';
import { mode2BetErrorMessage } from './mode2BetView';

export const data = new SlashCommandBuilder()
  .setName('모드2베팅마감')
  .setDescription('내가 개설한 모드2 베팅의 참가를 마감합니다.')
  .addIntegerOption((opt) => opt.setName('베팅id').setDescription('베팅 ID').setRequired(true));

export async function execute(interaction: ChatInputCommandInteraction) {
  const betId = interaction.options.getInteger('베팅id', true);

  try {
    const bet = await closeMode2Bet({ betId, requestedBy: interaction.user.id });
    await interaction.reply(
      `모드2 베팅 #${bet.id} (${bet.title}) 참가가 마감되었습니다. 결과가 나오면 \`/모드2베팅정산\`으로 정산해주세요.`
    );

    await logBetEvent(interaction.client, formatMode2Close(bet));
  } catch (error) {
    const message = mode2BetErrorMessage(error);
    if (!message) {
      throw error;
    }
    await interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
  }
}
