import { AttachmentBuilder, EmbedBuilder, type Client } from 'discord.js';

export type RebateReason = 'WEEKLY_BATCH' | 'CATCH_UP';

export interface RebateAnnouncementUserAmount {
  discordId: string;
  amount: number;
}

export interface RebateAnnouncementParams {
  reason: RebateReason;
  distributed: boolean;
  totalDistributed: number;
  perUserAmounts: RebateAnnouncementUserAmount[];
  houseBalanceAfter: number;
  totalEconomy: number;
  capRatio: number;
}

export interface RebateAnnouncementMessage {
  embed: EmbedBuilder;
  file?: AttachmentBuilder;
}

const REASON_TITLE: Record<RebateReason, string> = {
  WEEKLY_BATCH: '💰 환급 지급 완료 (주간 정기 배치)',
  CATCH_UP: '💰 하우스 캡 초과분 catch-up 정산 완료',
};

const MAX_FIELD_VALUE_LENGTH = 1000; // 디스코드 임베드 필드 값 제한(1024자)보다 여유를 둔 안전 마진
const MAX_FIELDS = 25; // 디스코드 임베드 필드 개수 제한

// 유저별 지급 내역 줄들을 필드 값 1000자 이내로 묶는다 (필드 하나에 여러 명씩 담는다).
function chunkUserLines(lines: string[]): string[] {
  const chunks: string[] = [];
  let current = '';

  for (const line of lines) {
    const next = current ? `${current}\n${line}` : line;
    if (next.length > MAX_FIELD_VALUE_LENGTH && current) {
      chunks.push(current);
      current = line;
    } else {
      current = next;
    }
  }
  if (current) {
    chunks.push(current);
  }

  return chunks;
}

function formatSharePercent(houseBalanceAfter: number, totalEconomy: number): string {
  const share = totalEconomy > 0 ? (houseBalanceAfter / totalEconomy) * 100 : 0;
  return share.toFixed(1);
}

export function buildRebateAnnouncementEmbed(
  params: RebateAnnouncementParams
): RebateAnnouncementMessage {
  const embed = new EmbedBuilder().setTimestamp(new Date());
  const sharePercent = formatSharePercent(params.houseBalanceAfter, params.totalEconomy);
  const capPercent = (params.capRatio * 100).toFixed(0);

  if (!params.distributed) {
    embed
      .setTitle('📭 이번 회차 환급 없음')
      .setColor(0xa0aec0)
      .setDescription(
        [
          '이번 회차는 하우스 잔고가 이미 캡 이하라 환급이 지급되지 않았습니다.',
          `🏦 현재 하우스 잔고: ${params.houseBalanceAfter.toLocaleString()}P (전체 경제의 ${sharePercent}%, 목표 ${capPercent}% 이하)`,
        ].join('\n')
      );
    return { embed };
  }

  embed
    .setTitle(REASON_TITLE[params.reason])
    .setColor(0x38a169)
    .setDescription(
      [
        `💸 총 환급액: **${params.totalDistributed.toLocaleString()}P**`,
        `🏦 환급 후 하우스 잔고: ${params.houseBalanceAfter.toLocaleString()}P (전체 경제의 ${sharePercent}%, 목표 ${capPercent}% 이하)`,
        `👥 지급 대상: ${params.perUserAmounts.length}명`,
      ].join('\n')
    );

  const sortedUsers = [...params.perUserAmounts].sort((a, b) => b.amount - a.amount);
  const lines = sortedUsers.map((u) => `<@${u.discordId}>: ${u.amount.toLocaleString()}P`);
  const chunks = chunkUserLines(lines);

  if (chunks.length <= MAX_FIELDS) {
    chunks.forEach((chunk, index) => {
      embed.addFields({
        name: chunks.length > 1 ? `지급 내역 (${index + 1}/${chunks.length})` : '지급 내역',
        value: chunk,
      });
    });
    return { embed };
  }

  // 필드 25개로도 다 못 담을 만큼 유저가 많으면(대략 375명 이상) 전체 명단을 첨부파일
  // (Attachment - 디스코드 메시지에 문서를 덧붙이는 기능)로 대신 보낸다.
  embed.addFields({
    name: '지급 내역',
    value: `지급 대상 ${sortedUsers.length}명 (첨부파일 참고)`,
  });
  const file = new AttachmentBuilder(Buffer.from(lines.join('\n'), 'utf-8'), {
    name: 'rebate-recipients.txt',
  });
  return { embed, file };
}

// 실제 전송 담당 - 채널 조회/전송 실패 시 에러를 그대로 던진다 (호출부가 지급 로직과
// 분리된 자체 try-catch로 잡아서, 공지 실패가 이미 끝난 지급 결과에 영향을 주지 않게 한다).
export async function sendRebateAnnouncement(
  client: Client,
  channelId: string,
  params: RebateAnnouncementParams
): Promise<void> {
  const channel = await client.channels.fetch(channelId);
  if (!channel || !channel.isTextBased() || !channel.isSendable()) {
    throw new Error(`채널 ${channelId}을 찾을 수 없거나 메시지를 보낼 수 없습니다.`);
  }

  const { embed, file } = buildRebateAnnouncementEmbed(params);
  await channel.send({ embeds: [embed], files: file ? [file] : [] });
}
