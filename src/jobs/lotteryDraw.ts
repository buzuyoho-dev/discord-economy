import { DiscordAPIError, type Client } from 'discord.js';
import { LotteryDrawSource } from '@prisma/client';
import { env } from '../config/env';
import { kstMidnightUtc } from '../services/kst';
import { runLotteryDraw } from '../services/lotteryDraw';

// Discord API 오류 코드: https://discord.com/developers/docs/topics/opcodes-and-status-codes#json
const MISSING_ACCESS = 50001;
const MISSING_PERMISSIONS = 50013;

const LOTTERY_DRAW_CRON_EXPRESSION = '0 12 * * *'; // 매일 낮 12시
const TIMEZONE = 'Asia/Seoul';

export async function scheduleLotteryDraw(client: Client) {
  const { schedule } = await import('node-cron');
  schedule(LOTTERY_DRAW_CRON_EXPRESSION, () => runDailyLotteryDraw(client), {
    timezone: TIMEZONE,
  });
}

export async function runDailyLotteryDraw(
  client: Client,
  source: LotteryDrawSource = LotteryDrawSource.CRON
) {
  try {
    // 정오 이전/이후를 나누는 getDrawDate()는 여기서 쓰면 안 된다 - cron이 정확히 KST 정오에
    // 실행되므로 그 분기를 타면 "내일"로 계산되어 오늘 마감되는 회차를 찾지 못한다.
    // 여기서는 분기 없이 "지금(=마감 시점) KST 날짜"만 그대로 쓴다.
    const drawDate = kstMidnightUtc(new Date());
    const result = await runLotteryDraw({ drawDate, source });
    await announceLotteryResult(client, result);
  } catch (error) {
    // DiscordAPIError는 announceLotteryResult()의 channel.send()에서만 발생할 수 있다
    // (runLotteryDraw는 순수 DB 트랜잭션이라 Discord API를 호출하지 않는다).
    // 즉 이 분기에 걸렸다는 건 추첨/정산 자체는 이미 정상적으로 끝났고, 결과 공지 메시지만
    // 못 보낸 것이다 - 콘솔에만 남기고 지나가면 "추첨이 아예 안 됐다"고 오해하기 쉬우므로
    // 원인(권한 문제 등)을 명확히 짚어준다.
    if (error instanceof DiscordAPIError && (error.code === MISSING_PERMISSIONS || error.code === MISSING_ACCESS)) {
      console.error(
        `[복권 추첨] 당첨자 산정/정산은 정상적으로 완료되었지만, 결과 공지 메시지 전송에 실패했습니다. ` +
          `봇에게 채널(${env.LOTTERY_CHANNEL_ID})의 "메시지 보내기" 권한이 있는지 확인해주세요. (Discord error code ${error.code})`
      );
      return;
    }
    console.error('복권 추첨 처리 중 오류 발생', error);
  }
}

async function announceLotteryResult(
  client: Client,
  result: Awaited<ReturnType<typeof runLotteryDraw>>
) {
  const channelId = env.LOTTERY_CHANNEL_ID;
  if (!channelId) {
    console.warn('LOTTERY_CHANNEL_ID가 설정되지 않아 복권 결과 메시지를 보내지 않습니다.');
    return;
  }

  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isTextBased() || !channel.isSendable()) {
    console.warn(`채널 ${channelId}을 찾을 수 없거나 메시지를 보낼 수 없습니다.`);
    return;
  }

  const lines: string[] = [`**[복권 추첨] 당첨 번호: ${result.winningNumber}**`];

  if (result.winners.length > 0) {
    const winnerMentions = result.winners.map((id) => `<@${id}>`).join(', ');
    lines.push(
      `🎉 당첨자 ${result.winners.length}명: ${winnerMentions}`,
      `1인당 지급액: ${result.prizePerWinner.toLocaleString()}P (세금 10% 제외)`
    );
  } else if (result.ticketCount === 0) {
    lines.push('😴 이번 회차 참여자가 없습니다.');
    if (result.carriedOver > 0) {
      lines.push(`다음 회차 잭팟: ${result.carriedOver.toLocaleString()}P`);
    }
  } else {
    lines.push(
      `😢 당첨 번호 [${result.winningNumber}]를 맞춘 사람이 없습니다.`,
      `다음 회차 잭팟: ${result.carriedOver.toLocaleString()}P`
    );
  }

  await channel.send(lines.join('\n'));
}
