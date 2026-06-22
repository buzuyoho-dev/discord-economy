import type { Client } from 'discord.js';
import { env } from '../config/env';

export async function logBetEvent(client: Client, message: string) {
  const channelId = env.BET_LOG_CHANNEL_ID;
  if (!channelId) {
    console.warn('BET_LOG_CHANNEL_ID가 설정되지 않아 베팅 기록을 남기지 않습니다.');
    return;
  }

  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel || !channel.isTextBased() || !channel.isSendable()) {
      console.warn(`채널 ${channelId}을 찾을 수 없거나 메시지를 보낼 수 없습니다.`);
      return;
    }

    await channel.send(message);
  } catch (error) {
    console.error('베팅 기록 채널에 메시지를 남기는 중 오류 발생', error);
  }
}
