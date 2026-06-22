import { type ChatInputCommandInteraction, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { createLoan, DEFAULT_DUE_DAYS } from '../services/loan';
import { loanErrorMessage } from './loanView';

export const data = new SlashCommandBuilder()
  .setName('대출개설')
  .setDescription('다른 유저에게 포인트를 대출해줍니다 (최대 3,000만, 개설 수수료 2%).')
  .addUserOption((opt) => opt.setName('빌릴사람').setDescription('포인트를 빌려갈 유저').setRequired(true))
  .addIntegerOption((opt) =>
    opt.setName('금액').setDescription('대출 금액').setRequired(true).setMinValue(1)
  )
  .addIntegerOption((opt) =>
    opt
      .setName('상환일수')
      .setDescription(`상환 기한 (일 단위, 기본 ${DEFAULT_DUE_DAYS}일)`)
      .setRequired(false)
      .setMinValue(1)
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  const borrower = interaction.options.getUser('빌릴사람', true);
  const principal = interaction.options.getInteger('금액', true);
  const dueDays = interaction.options.getInteger('상환일수');

  try {
    const now = new Date();
    const dueAt = dueDays ? new Date(now.getTime() + dueDays * 24 * 60 * 60 * 1000) : undefined;

    const loan = await createLoan({
      lenderId: interaction.user.id,
      borrowerId: borrower.id,
      principal,
      dueAt,
      now,
    });

    await interaction.reply({
      content: `대출 #${loan.id} 개설 완료! ${borrower.username}님에게 ${principal.toLocaleString()} 포인트 대출 (상환 기한: ${loan.dueAt.toLocaleDateString('ko-KR')}). 상환 시 \`/대출상환 ${loan.id}\`을 사용하세요.`,
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
