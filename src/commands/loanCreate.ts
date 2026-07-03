import { type ChatInputCommandInteraction, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { buildLoanActionRow } from '../events/loanButton';
import { DEFAULT_DUE_DAYS, LOAN_REQUEST_EXPIRY_HOURS, requestLoan } from '../services/loan';
import { loanErrorMessage } from './loanView';

export const data = new SlashCommandBuilder()
  .setName('대출개설')
  .setDescription('다른 유저에게 대출을 요청합니다 (최대 3,000만, 개설 수수료 2%, 상대가 수락해야 실행됩니다).')
  .addUserOption((opt) => opt.setName('빌릴사람').setDescription('포인트를 빌려줄 유저').setRequired(true))
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
    const loan = await requestLoan({
      lenderId: interaction.user.id,
      borrowerId: borrower.id,
      borrowerIsBot: borrower.bot,
      principal,
      dueDays: dueDays ?? undefined,
    });

    // 💡 lender에게 별도 알림은 없다 - 이 메시지 자체가 공개 요청이고, borrower가 버튼을
    // 누르면 이 메시지가 결과로 수정(edit)된다.
    await interaction.reply({
      content: `<@${borrower.id}>님, <@${interaction.user.id}>님이 ${principal.toLocaleString()} 포인트를 상환 기한 ${loan.dueDays}일로 대출 요청했습니다 (개설 수수료 2% 제외 후 지급). 아래 버튼으로 응답해주세요 (${LOAN_REQUEST_EXPIRY_HOURS}시간 내 미응답 시 만료).`,
      components: [buildLoanActionRow(loan.id)],
    });
  } catch (error) {
    const message = loanErrorMessage(error);
    if (!message) {
      throw error;
    }
    await interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
  }
}
