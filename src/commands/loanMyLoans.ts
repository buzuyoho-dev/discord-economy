import { type ChatInputCommandInteraction, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { formatMyLoans } from './loanView';
import { getUserLoans } from '../services/loan';

export const data = new SlashCommandBuilder()
  .setName('내대출')
  .setDescription('내가 빌려준/빌린 대출 목록과 대기중인 요청을 확인합니다.')
  .addBooleanOption((opt) =>
    opt.setName('전체보기').setDescription('완료된(상환/거절/무효화) 대출도 전부 보여줍니다').setRequired(false)
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  const showAll = interaction.options.getBoolean('전체보기') ?? false;

  const { asLender, asBorrower } = await getUserLoans(interaction.user.id);
  const content = formatMyLoans({ asLender, asBorrower, showAll });

  await interaction.reply({ content, flags: MessageFlags.Ephemeral });
}
