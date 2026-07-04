// 💡 대출 요청(/대출요청)에 달린 [수락]/[거절] 버튼을 처리한다. RPS(rpsButton.ts)와 같은
// customId 패턴(접두사:행동:참조id)과 "클릭한 사람이 진짜 권한자인지 서버에서 재확인한다"는
// 철학을 그대로 따르되, 참조id는 무작위 Map 키가 아니라 이미 DB에 영속화된 Loan.id를 그대로
// 쓴다 - 대출 요청은 RPS 도전과 달리 처음부터 DB 레코드(PENDING)로 존재하는 금융 데이터라
// 봇이 재시작돼도 사라지면 안 된다. Loan.id 자체는 숨겨야 할 비밀(RPS의 챌린저 선택 같은)이
// 아니라 그냥 참조 번호라 customId에 노출해도 안전하다. "클릭한 사람 = lender 본인"인지는
// acceptLoan/declineLoan이 DB에서 조회한 진짜 lenderId와 비교해서 검증한다.
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, type ButtonInteraction, MessageFlags } from 'discord.js';
import { InsufficientBalanceError } from '../services/ledger';
import {
  acceptLoan,
  declineLoan,
  LOAN_ORIGINATION_FEE_RATE,
  LoanNotFoundError,
  LoanNotPendingError,
  LoanRequestExpiredError,
  NotLenderError,
} from '../services/loan';

const CUSTOM_ID_PREFIX = 'loan:';

export function isLoanActionButton(customId: string): boolean {
  return customId.startsWith(CUSTOM_ID_PREFIX);
}

export function buildLoanActionRow(loanId: number): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${CUSTOM_ID_PREFIX}accept:${loanId}`)
      .setLabel('수락')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`${CUSTOM_ID_PREFIX}decline:${loanId}`)
      .setLabel('거절')
      .setStyle(ButtonStyle.Secondary)
  );
}

export async function handleLoanActionButton(interaction: ButtonInteraction): Promise<void> {
  const [, action, loanIdRaw] = interaction.customId.split(':');
  const loanId = Number(loanIdRaw);

  try {
    if (action === 'accept') {
      const loan = await acceptLoan({ loanId, acceptedBy: interaction.user.id });
      const fee = Math.floor(loan.principal * LOAN_ORIGINATION_FEE_RATE);
      const netToBorrower = loan.principal - fee;
      await interaction.update({
        content: `✅ <@${loan.lenderId}>님이 대출 #${loan.id} 요청을 수락했습니다. ${netToBorrower.toLocaleString()}P가 지급되었습니다 (상환 기한: ${loan.dueAt!.toLocaleDateString('ko-KR')}). 상환 시 \`/대출상환 ${loan.id}\`을 사용하세요.`,
        components: [],
      });
      return;
    }

    if (action === 'decline') {
      const loan = await declineLoan({ loanId, declinedBy: interaction.user.id });
      await interaction.update({
        content: `❌ <@${loan.lenderId}>님이 대출 #${loan.id} 요청을 거절했습니다.`,
        components: [],
      });
      return;
    }
  } catch (error) {
    if (error instanceof NotLenderError) {
      await interaction.reply({
        content: '이 버튼은 당신을 위한 것이 아닙니다.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (error instanceof LoanRequestExpiredError) {
      await interaction.reply({ content: '요청이 만료되었습니다.', flags: MessageFlags.Ephemeral });
      return;
    }
    if (error instanceof LoanNotPendingError) {
      await interaction.reply({ content: '이미 처리된 요청입니다.', flags: MessageFlags.Ephemeral });
      return;
    }
    if (error instanceof LoanNotFoundError) {
      await interaction.reply({
        content: '해당 대출 요청을 찾을 수 없습니다.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (error instanceof InsufficientBalanceError) {
      await interaction.reply({
        content: '대출자의 잔액이 부족해 처리할 수 없습니다.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    throw error;
  }
}
