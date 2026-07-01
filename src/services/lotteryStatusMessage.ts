import { prisma } from '../db/client';
import { formatParticipantsLine } from '../discord/participants';

export interface LotteryStatusChannel {
  sendMessage(content: string): Promise<{ id: string }>;
  editMessage(messageId: string, content: string): Promise<void>;
}

export function formatLotteryStatusMessage(params: {
  drawDate: Date;
  roundNumber: number;
  participantUserIds: string[];
  carryoverJackpot: number;
}): string {
  const dateLabel = `${params.drawDate.getUTCMonth() + 1}/${params.drawDate.getUTCDate()}`;

  return [
    `[복권 ${dateLabel} ${params.roundNumber}회차] 구매 현황`,
    formatParticipantsLine(params.participantUserIds),
    `이월 잭팟: ${params.carryoverJackpot.toLocaleString()}P | 추첨: 매일 낮 12시`,
  ].join('\n');
}

async function allocateNextRoundNumber(): Promise<number> {
  return prisma.$transaction(async (tx) => {
    const state = await tx.lotteryState.upsert({
      where: { id: 1 },
      update: {},
      create: { id: 1 },
    });
    await tx.lotteryState.update({
      where: { id: 1 },
      data: { nextRoundNumber: state.nextRoundNumber + 1 },
    });
    return state.nextRoundNumber;
  });
}

async function getParticipantUserIds(drawDate: Date): Promise<string[]> {
  const tickets = await prisma.lotteryTicket.findMany({
    where: { drawDate },
    orderBy: { purchasedAt: 'asc' },
    select: { userId: true },
  });
  return tickets.map((ticket) => ticket.userId);
}

async function getCarryoverJackpot(): Promise<number> {
  const state = await prisma.lotteryState.findUnique({ where: { id: 1 } });
  return state?.currentJackpot ?? 0;
}

export async function updateLotteryStatusMessage(params: {
  drawDate: Date;
  channel: LotteryStatusChannel;
}): Promise<void> {
  try {
    const existing = await prisma.lotteryStatusMessage.findUnique({
      where: { drawDate: params.drawDate },
    });
    const carryoverJackpot = await getCarryoverJackpot();
    const participantUserIds = await getParticipantUserIds(params.drawDate);

    if (!existing) {
      const roundNumber = await allocateNextRoundNumber();
      const content = formatLotteryStatusMessage({
        drawDate: params.drawDate,
        roundNumber,
        participantUserIds,
        carryoverJackpot,
      });
      const sent = await params.channel.sendMessage(content);
      await prisma.lotteryStatusMessage.create({
        data: { drawDate: params.drawDate, roundNumber, channelMessageId: sent.id },
      });
      return;
    }

    const content = formatLotteryStatusMessage({
      drawDate: params.drawDate,
      roundNumber: existing.roundNumber,
      participantUserIds,
      carryoverJackpot,
    });
    await params.channel.editMessage(existing.channelMessageId, content);
  } catch (error) {
    console.error('복권 구매 현황 메시지 갱신 중 오류 발생', error);
  }
}
