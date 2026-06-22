import { type ChatInputCommandInteraction, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { logBetEvent } from '../discord/betLog';
import { formatMode1Close } from '../discord/betLogMessages';
import { closeBet } from '../services/mode1Bet';
import { mode1BetErrorMessage } from './mode1BetView';

export const data = new SlashCommandBuilder()
  .setName('베팅마감')
  .setDescription('내가 개설한 베팅의 참가를 마감합니다.')
  .addIntegerOption((opt) => opt.setName('베팅id').setDescription('베팅 ID').setRequired(true));

export async function execute(interaction: ChatInputCommandInteraction) {
  const betId = interaction.options.getInteger('베팅id', true);

  try {
    const bet = await closeBet({ betId, requestedBy: interaction.user.id });
    await interaction.reply(
      `베팅 #${bet.id} (${bet.title}) 참가가 마감되었습니다. 결과가 나오면 \`/베팅정산\`으로 정산해주세요.`
    );

    await logBetEvent(interaction.client, formatMode1Close(bet));
  } catch (error) {
    const message = mode1BetErrorMessage(error);
    if (!message) {
      throw error;
    }
    await interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
  }
}
