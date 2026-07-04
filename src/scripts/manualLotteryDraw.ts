import { Client, GatewayIntentBits } from 'discord.js';
import { env } from '../config/env';
import { runDailyLotteryDraw } from '../jobs/lotteryDraw';

// 매일 낮 12시(KST) cron이 실제로 도는지, 채널 공지 권한이 제대로 걸려 있는지를
// 다음 정오까지 기다리지 않고 바로 확인하기 위한 수동 실행 스크립트.
//
// 오늘 회차가 이미 정산(settled)된 상태라면 대상 티켓이 0장이라 잭팟/유저 잔액에는
// 아무 영향이 없다 - "결과 공지 메시지가 채널에 정상적으로 올라오는지"만 확인하는 용도로
// 여러 번 실행해도 안전하다. (아직 정산 전이라면 실제 오늘자 추첨이 그대로 실행되니 주의)
//
// 실행: railway run tsx src/scripts/manualLotteryDraw.ts
//   또는 로컬 .env가 채워져 있다면: tsx src/scripts/manualLotteryDraw.ts
async function main() {
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });

  await new Promise<void>((resolve, reject) => {
    client.once('ready', () => resolve());
    client.login(env.DISCORD_TOKEN).catch(reject);
  });

  console.log(`Logged in as ${client.user?.tag} — 복권 추첨을 수동으로 실행합니다.`);
  await runDailyLotteryDraw(client);
  console.log('실행 완료. 위 로그에 오류가 없고, 디스코드 채널에 공지 메시지가 올라왔는지 확인하세요.');

  await client.destroy();
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
