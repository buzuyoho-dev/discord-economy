import {
  type ChatInputCommandInteraction,
  MessageFlags,
  SlashCommandBuilder,
} from 'discord.js';
import { AlreadyCheckedInError, ATTENDANCE_REWARD, checkIn } from '../services/attendance';

export const data = new SlashCommandBuilder()
  .setName('출석')
  .setDescription('하루 한 번 출석체크하고 포인트를 받습니다.');

export async function execute(interaction: ChatInputCommandInteraction) {
  try {
    const user = await checkIn(interaction.user.id);
    await interaction.reply({
      content: `출석체크 완료! +${ATTENDANCE_REWARD.toLocaleString()} 포인트 (현재 잔액 ${user.balance.toLocaleString()})`,
      flags: MessageFlags.Ephemeral,
    });
  } catch (error) {
    if (error instanceof AlreadyCheckedInError) {
      await interaction.reply({
        content: '오늘은 이미 출석체크를 했습니다. 내일 다시 시도해주세요.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    throw error;
  }
}
