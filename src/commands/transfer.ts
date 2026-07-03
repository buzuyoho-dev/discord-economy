import { type ChatInputCommandInteraction, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { transferPoints } from '../services/transfer';
import { transferErrorMessage } from './transferView';

export const data = new SlashCommandBuilder()
  .setName('양도')
  .setDescription('다른 유저에게 포인트를 양도합니다 (1일 1회, 최대 5,000만, 수수료 5%).')
  .addUserOption((opt) => opt.setName('받는사람').setDescription('포인트를 받을 유저').setRequired(true))
  .addIntegerOption((opt) =>
    opt.setName('금액').setDescription('양도할 포인트').setRequired(true).setMinValue(1)
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  const recipient = interaction.options.getUser('받는사람', true);
  const amount = interaction.options.getInteger('금액', true);

  try {
    const result = await transferPoints({
      senderId: interaction.user.id,
      recipientId: recipient.id,
      recipientIsBot: recipient.bot,
      amount,
    });

    await interaction.reply({
      content: `${recipient.username}님에게 ${amount.toLocaleString()} 포인트를 양도했습니다. (수수료 ${result.fee.toLocaleString()} 차감, 수령액 ${result.netAmount.toLocaleString()})`,
      flags: MessageFlags.Ephemeral,
    });
  } catch (error) {
    const message = transferErrorMessage(error);
    if (!message) {
      throw error;
    }
    await interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
  }
}
