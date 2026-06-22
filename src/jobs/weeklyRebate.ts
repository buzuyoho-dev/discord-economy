import type { Client } from 'discord.js';
import { env } from '../config/env';
import { applyWeeklyRebate, type WeeklyRebateResult } from '../services/rebate';

const WEEKLY_REBATE_CRON_EXPRESSION = '0 0 * * 0'; // 매주 일요일 자정
const TIMEZONE = 'Asia/Seoul';

export async function scheduleWeeklyRebate(client: Client) {
  const { schedule } = await import('node-cron');
  schedule(WEEKLY_REBATE_CRON_EXPRESSION, () => runWeeklyRebate(client), {
    timezone: TIMEZONE,
  });
}

export async function runWeeklyRebate(client: Client) {
  try {
    const result = await applyWeeklyRebate();
    if (result.rebated) {
      await announceRebate(client, result);
    }
  } catch (error) {
    console.error('주간 환원 처리 중 오류 발생', error);
  }
}

async function announceRebate(client: Client, result: WeeklyRebateResult) {
  const channelId = env.REBATE_ANNOUNCEMENT_CHANNEL_ID;
  if (!channelId) {
    console.warn(
      'REBATE_ANNOUNCEMENT_CHANNEL_ID가 설정되지 않아 환원 안내 메시지를 보내지 않습니다.'
    );
    return;
  }

  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isTextBased() || !channel.isSendable()) {
    console.warn(`채널 ${channelId}을 찾을 수 없거나 메시지를 보낼 수 없습니다.`);
    return;
  }

  const perUserCount = result.perUserAmounts.size;
  const averagePerUser = perUserCount > 0 ? Math.floor(result.rebateAmount / perUserCount) : 0;

  await channel.send(
    [
      '**[정산일] 하우스 점유율 환원 이벤트 발생!**',
      '이번 주 하우스 점유율이 25%를 초과해, 초과분의 절반을 전체 유저에게 환원합니다.',
      `총 환원액: ${result.rebateAmount.toLocaleString()} 포인트 (대상 ${perUserCount}명, 1인당 약 ${averagePerUser.toLocaleString()} 포인트)`,
      '정확한 지급액은 `/잔액`으로 확인해보세요!',
    ].join('\n')
  );
}
