import { type ChatInputCommandInteraction, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { prisma } from '../db/client';
import { logBetEvent } from '../discord/betLog';
import { formatMode1Settle } from '../discord/betLogMessages';
import { normalizeLabel, settleBet, settleUnifiedBet } from '../services/mode1Bet';
import { mode1BetErrorMessage } from './mode1BetView';

export const data = new SlashCommandBuilder()
  .setName('베팅정산')
  .setDescription('내가 개설한 베팅을 결과에 따라 정산합니다.')
  .addIntegerOption((opt) => opt.setName('베팅id').setDescription('베팅 ID').setRequired(true))
  .addStringOption((opt) =>
    opt.setName('결과').setDescription('실제 결과에 해당하는 옵션 이름').setRequired(true)
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  const betId = interaction.options.getInteger('베팅id', true);
  const resultLabel = interaction.options.getString('결과', true);

  const bet = await prisma.bet.findUnique({ where: { id: betId }, include: { options: true } });
  if (!bet) {
    await interaction.reply({ content: '해당 베팅을 찾을 수 없습니다.', flags: MessageFlags.Ephemeral });
    return;
  }

  const winningOption = bet.options.find(
    (option) => normalizeLabel(option.label) === normalizeLabel(resultLabel)
  );
  if (!winningOption) {
    const optionList = bet.options.map((option) => option.label).join(', ');
    await interaction.reply({
      content: `"${resultLabel}"와 일치하는 옵션이 없습니다. 옵션: ${optionList}`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  try {
    // 이 배포 이전에 이미 열려있던 레거시 모드1 베팅은 기존 로직 그대로 정산한다.
    const settled =
      bet.mode === 'UNIFIED'
        ? await settleUnifiedBet({
            betId,
            requestedBy: interaction.user.id,
            winningOptionId: winningOption.id,
          })
        : await settleBet({
            betId,
            requestedBy: interaction.user.id,
            winningOptionId: winningOption.id,
          });

    const message =
      settled.status === 'VOID' || settled.status === 'VOIDED'
        ? `베팅 #${settled.id} (${bet.title})는 무효 처리되어 참가자 전원에게 환불되었습니다.`
        : `베팅 #${settled.id} (${bet.title}) 정산 완료! 정답: ${winningOption.label}`;

    await interaction.reply(message);

    await logBetEvent(
      interaction.client,
      formatMode1Settle(settled, bet.options, winningOption.id)
    );
  } catch (error) {
    const message = mode1BetErrorMessage(error);
    if (!message) {
      throw error;
    }
    await interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
  }
}
