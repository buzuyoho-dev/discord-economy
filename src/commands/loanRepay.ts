import { type ChatInputCommandInteraction, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { repayLoan } from '../services/loan';
import { loanErrorMessage } from './loanView';

export const data = new SlashCommandBuilder()
  .setName('대출상환')
  .setDescription('내가 빌린 대출을 전액 상환합니다.')
  .addIntegerOption((opt) => opt.setName('대출id').setDescription('대출 ID').setRequired(true));

export async function execute(interaction: ChatInputCommandInteraction) {
  const loanId = interaction.options.getInteger('대출id', true);

  try {
    const result = await repayLoan({ loanId, repaidBy: interaction.user.id });

    const interestNote =
      result.interest > 0
        ? ` (연체 ${result.overdueDays}일, 이자 ${result.interest.toLocaleString()} 포함)`
        : ' (연체 없음, 이자 없음)';

    await interaction.reply({
      content: `대출 #${loanId} 상환 완료! 총 ${result.totalRepaid.toLocaleString()} 포인트 상환${interestNote}`,
      flags: MessageFlags.Ephemeral,
    });
  } catch (error) {
    const message = loanErrorMessage(error);
    if (!message) {
      throw error;
    }
    await interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
  }
}
