import type { Client } from 'discord.js';
import { env } from '../config/env';
import { distributionBatch, type DistributionBatchResult } from '../services/distributionBatch';

const DISTRIBUTION_BATCH_CRON_EXPRESSION = '0 0 * * 1,3,5'; // 매주 월/수/금 자정
const TIMEZONE = 'Asia/Seoul';

export async function scheduleDistributionBatch(client: Client) {
  const { schedule } = await import('node-cron');
  schedule(DISTRIBUTION_BATCH_CRON_EXPRESSION, () => runDistributionBatch(client), {
    timezone: TIMEZONE,
  });
}

export async function runDistributionBatch(client: Client) {
  try {
    const result = await distributionBatch();
    await announceDistribution(client, result);
  } catch (error) {
    console.error('환급/쿠폰 배치 처리 중 오류 발생', error);
  }
}

async function announceDistribution(client: Client, result: DistributionBatchResult) {
  const channelId = env.REBATE_ANNOUNCEMENT_CHANNEL_ID;
  if (!channelId) {
    console.warn(
      'REBATE_ANNOUNCEMENT_CHANNEL_ID가 설정되지 않아 환급/쿠폰 안내 메시지를 보내지 않습니다.'
    );
    return;
  }

  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isTextBased() || !channel.isSendable()) {
    console.warn(`채널 ${channelId}을 찾을 수 없거나 메시지를 보낼 수 없습니다.`);
    return;
  }

  const lines: string[] = ['**[정산 배치] 하우스 환급 & 베팅2배쿠폰 발급**'];

  if (result.distributed) {
    const perUserCount = result.perUserAmounts.size;
    lines.push(
      `순증가분 기준 환급 재원: ${result.fundAmount.toLocaleString()}P`,
      `대상 ${perUserCount}명에게 지급 완료 (\`/잔액\`으로 정확한 지급액 확인 가능)`
    );
  } else {
    lines.push('이번 배치는 순증가분이 없어 환급이 지급되지 않았습니다.');
  }

  lines.push(
    `📮 베팅2배쿠폰: 하위 ${result.lowerTierCount}명 중 ${result.couponsIssued}명 신규 발급, ${result.couponsSkipped}명은 이미 2장 보유로 스킵 (7일간 유효, \`/쿠폰함\`으로 확인).`
  );

  await channel.send(lines.join('\n'));
}
