import { DiscordAPIError, type Client } from 'discord.js';
import { sendRebateAnnouncement } from '../discord/rebateAnnouncement';
import { distributionBatch } from '../services/distributionBatch';
import { getOrCreateEconomyConfig } from '../services/economyConfig';
import { getEconomySnapshot } from '../services/house';

// Discord API 오류 코드: https://discord.com/developers/docs/topics/opcodes-and-status-codes#json
const MISSING_ACCESS = 50001;
const MISSING_PERMISSIONS = 50013;

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
    const config = await getOrCreateEconomyConfig();
    // 💡 봇 자신은 절대 환급/쿠폰 대상이 되면 안 되므로, 봇의 Discord ID를 명시적으로 제외한다.
    const result = await distributionBatch(new Date(), { excludeUserId: client.user?.id });

    try {
      // 지급(DB 처리)이 끝난 뒤 하우스 잔고/전체 경제 규모를 다시 읽는다 - 환급은
      // 하우스→유저 이동일 뿐 totalEconomy 자체는 바뀌지 않으므로 이 조회는 정확하다.
      const { house, totalEconomy } = await getEconomySnapshot();
      await sendRebateAnnouncement(client, config.rebateAnnounceChannelId, {
        reason: 'WEEKLY_BATCH',
        distributed: result.distributed,
        totalDistributed: result.fundAmount,
        perUserAmounts: [...result.perUserAmounts].map(([discordId, amount]) => ({
          discordId,
          amount,
        })),
        houseBalanceAfter: house.balance,
        totalEconomy,
        capRatio: config.houseBalanceCapRatio,
      });
    } catch (error) {
      // 공지 실패는 지급(DB 처리) 결과에 영향을 주지 않는다 - 이미 커밋된 상태를 그대로 유지.
      if (
        error instanceof DiscordAPIError &&
        (error.code === MISSING_PERMISSIONS || error.code === MISSING_ACCESS)
      ) {
        console.error(
          `[환급/쿠폰 배치] 지급 처리는 정상적으로 완료되었지만, 공지 메시지 전송에 실패했습니다. ` +
            `봇에게 채널(${config.rebateAnnounceChannelId})의 "메시지 보내기" 권한이 있는지 확인해주세요. (Discord error code ${error.code})`
        );
        return;
      }
      console.error(
        '[환급/쿠폰 배치] 지급 처리는 정상적으로 완료되었지만, 공지 메시지 전송 중 오류가 발생했습니다.',
        error
      );
    }
  } catch (error) {
    console.error('환급/쿠폰 배치 처리 중 오류 발생', error);
  }
}
