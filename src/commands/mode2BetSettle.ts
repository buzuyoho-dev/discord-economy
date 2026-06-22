import { type ChatInputCommandInteraction, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { normalizeLabel } from '../services/betShared';
import { prisma } from '../db/client';
import { logBetEvent } from '../discord/betLog';
import { formatMode2Settle } from '../discord/betLogMessages';
import { settleMode2Bet } from '../services/mode2Bet';
import { mode2BetErrorMessage } from './mode2BetView';

export const data = new SlashCommandBuilder()
  .setName('모드2베팅정산')
  .setDescription('내가 개설한 모드2 베팅을 결과에 따라 정산합니다.')
  .addIntegerOption((opt) => opt.setName('베팅id').setDescription('베팅 ID').setRequired(true))
  .addStringOption((opt) =>
    opt.setName('결과').setDescription('실제 결과에 해당하는 사이드 이름').setRequired(true)
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  const betId = interaction.options.getInteger('베팅id', true);
  const resultLabel = interaction.options.getString('결과', true);

  const bet = await prisma.mode2Bet.findUnique({ where: { id: betId } });
  if (!bet) {
    await interaction.reply({ content: '해당 베팅을 찾을 수 없습니다.', flags: MessageFlags.Ephemeral });
    return;
  }

  let winningSide: 'A' | 'B';
  if (normalizeLabel(bet.sideALabel) === normalizeLabel(resultLabel)) {
    winningSide = 'A';
  } else if (normalizeLabel(bet.sideBLabel) === normalizeLabel(resultLabel)) {
    winningSide = 'B';
  } else {
    await interaction.reply({
      content: `"${resultLabel}"와 일치하는 사이드가 없습니다. 옵션: ${bet.sideALabel}, ${bet.sideBLabel}`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  try {
    const settled = await settleMode2Bet({ betId, requestedBy: interaction.user.id, winningSide });
    const winningLabel = winningSide === 'A' ? bet.sideALabel : bet.sideBLabel;
    await interaction.reply(
      `모드2 베팅 #${settled.id} (${bet.title}) 정산 완료! 정답: ${winningLabel}`
    );

    await logBetEvent(
      interaction.client,
      formatMode2Settle(settled, bet.sideALabel, bet.sideBLabel, winningSide)
    );
  } catch (error) {
    const message = mode2BetErrorMessage(error);
    if (!message) {
      throw error;
    }
    await interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
  }
}
