import type { Client } from 'discord.js';
import { env } from '../config/env';
import type { LotteryStatusChannel } from '../services/lotteryStatusMessage';

export async function getLotteryStatusChannel(client: Client): Promise<LotteryStatusChannel | null> {
  const channelId = env.LOTTERY_CHANNEL_ID;
  if (!channelId) {
    console.warn('LOTTERY_CHANNEL_ID가 설정되지 않아 복권 구매 현황 메시지를 보내지 않습니다.');
    return null;
  }

  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isTextBased() || !channel.isSendable()) {
    console.warn(`채널 ${channelId}을 찾을 수 없거나 메시지를 보낼 수 없습니다.`);
    return null;
  }

  return {
    sendMessage: async (content: string) => {
      const message = await channel.send(content);
      return { id: message.id };
    },
    editMessage: async (messageId: string, content: string) => {
      await channel.messages.edit(messageId, content);
    },
  };
}
