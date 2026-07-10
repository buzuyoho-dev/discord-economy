import { Client, EmbedBuilder, GatewayIntentBits } from 'discord.js';
import { getOrCreateEconomyConfig } from '../services/economyConfig';

// 하우스 잔고 상한 시스템 개편을 플레이어들에게 안내하는 일회성 공지 스크립트.
// 재사용 가능한 슬래시 커맨드가 아니라 정확히 한 번만 실행할 목적이다.
// 실행: npx tsx src/scripts/announceUpdate.ts
async function main() {
  // 💡 '../config/env'의 env 객체는 DISCORD_TOKEN 등을 import 시점에 즉시 검증(없으면
  // throw)한다. 이 스크립트는 테스트가 없어 정적 import해도 문제없지만, 최근 스크립트들
  // (houseBalanceCapCatchUp.ts)과 스타일을 통일하기 위해 동일하게 dotenv를 동적으로 로드한다.
  await import('dotenv/config');

  const config = await getOrCreateEconomyConfig();

  const embed = new EmbedBuilder()
    .setTitle('📢 하우스 잔고 상한 시스템 업데이트 안내')
    .setColor(0x38a169)
    .setDescription(
      [
        '서버 경제 밸런스를 위해 하우스(카지노) 시스템이 개편되었습니다.',
        '',
        '**무엇이 바뀌었나요?**',
        '- 하우스가 보유할 수 있는 잔고를 전체 경제 규모의 40%로 제한합니다.',
        '- 하우스 잔고가 40%를 넘으면, 넘는 만큼 매주 자동으로 플레이어들에게 환급됩니다.',
        '- 이번에 그동안 쌓여있던 초과분(전체 경제의 75%까지 불어났던 하우스 잔고)을 하위 유저 우대 방식으로 일괄 환급했습니다.',
        '',
        '**앞으로는?**',
        '- 매주 환급 시, 총 환급액과 유저별 지급 내역이 이 채널에 투명하게 공지됩니다.',
        '- 하위 30% 유저는 1.5배 가중치로 더 많은 환급을 받습니다.',
        '',
        '궁금한 점은 관리자에게 문의해주세요!',
      ].join('\n')
    );

  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  try {
    await new Promise<void>((resolve, reject) => {
      client.once('ready', () => resolve());
      client.login(process.env.DISCORD_TOKEN).catch(reject);
    });

    const channel = await client.channels.fetch(config.rebateAnnounceChannelId);
    if (!channel || !channel.isTextBased() || !channel.isSendable()) {
      throw new Error(
        `채널 ${config.rebateAnnounceChannelId}을 찾을 수 없거나 메시지를 보낼 수 없습니다.`
      );
    }

    await channel.send({ embeds: [embed] });
    console.log('공지 메시지를 보냈습니다.');
  } finally {
    await client.destroy();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
