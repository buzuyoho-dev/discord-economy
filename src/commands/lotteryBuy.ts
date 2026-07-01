import { type ChatInputCommandInteraction, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { prisma } from '../db/client';
import { getLotteryStatusChannel } from '../discord/lotteryStatusChannel';
import {
  AlreadyPurchasedLotteryError,
  InsufficientBalanceForLotteryError,
  InvalidLotteryNumberError,
  LOTTERY_MAX_NUMBER,
  LOTTERY_MIN_NUMBER,
  LOTTERY_TICKET_PRICE,
  purchaseLottery,
} from '../services/lottery';
import { updateLotteryStatusMessage } from '../services/lotteryStatusMessage';

export const data = new SlashCommandBuilder()
  .setName('복권구매')
  .setDescription(
    `${LOTTERY_TICKET_PRICE.toLocaleString()} 포인트로 오늘 회차 복권 1장을 구매합니다. 매일 낮 12시 추첨.`
  )
  .addIntegerOption((option) =>
    option
      .setName('숫자')
      .setDescription(
        `${LOTTERY_MIN_NUMBER}~${LOTTERY_MAX_NUMBER} 중 당첨 번호로 맞힐 숫자를 고르세요.`
      )
      .setRequired(true)
      .setMinValue(LOTTERY_MIN_NUMBER)
      .setMaxValue(LOTTERY_MAX_NUMBER)
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  console.log('복권구매 핸들러 진입', { user: interaction.user.id });

  const chosenNumber = interaction.options.getInteger('숫자', true);

  // getOrCreateUser + purchaseLottery의 트랜잭션 2회 + lotteryState 조회까지
  // DB 왕복이 3번이라 3초 응답 제한을 넘길 수 있어 먼저 defer로 ACK한다.
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    let result;
    try {
      result = await purchaseLottery({
        discordId: interaction.user.id,
        chosenNumber,
      });
    } catch (error) {
      console.error('purchaseLottery 호출 중 오류 발생', error);
      throw error;
    }

    const state = await prisma.lotteryState.findUnique({ where: { id: 1 } });
    const carryover = state?.currentJackpot ?? 0;

    const statusChannel = await getLotteryStatusChannel(interaction.client);
    if (statusChannel) {
      await updateLotteryStatusMessage({ drawDate: result.drawDate, channel: statusChannel });
    }

    await interaction.editReply({
      content: [
        `🎟️ **복권 구매 완료!** 선택 번호: **${result.chosenNumber}**`,
        `-${LOTTERY_TICKET_PRICE.toLocaleString()}P | 현재 잔액: ${result.balanceAfter.toLocaleString()}P`,
        `이월 잭팟: ${carryover.toLocaleString()}P | 추첨: 매일 낮 12시`,
      ].join('\n'),
    });
  } catch (error) {
    if (error instanceof InvalidLotteryNumberError) {
      await interaction.editReply({
        content: `숫자는 ${LOTTERY_MIN_NUMBER}~${LOTTERY_MAX_NUMBER} 사이여야 합니다.`,
      });
      return;
    }
    if (error instanceof InsufficientBalanceForLotteryError) {
      await interaction.editReply({
        content: `포인트가 부족합니다. 복권 구매에는 ${LOTTERY_TICKET_PRICE.toLocaleString()} 포인트가 필요합니다.`,
      });
      return;
    }
    if (error instanceof AlreadyPurchasedLotteryError) {
      await interaction.editReply({
        content:
          '이미 이번 회차 복권을 구매했습니다. 다음 회차(오늘 낮 12시 이후)에 다시 시도해주세요.',
      });
      return;
    }
    console.error('복권구매 핸들러에서 처리되지 않은 오류 발생', error);
    throw error;
  }
}
