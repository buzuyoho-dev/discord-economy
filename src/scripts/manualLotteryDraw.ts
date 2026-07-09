import { Client, GatewayIntentBits } from 'discord.js';
import { LotteryDrawSource } from '@prisma/client';
import { env } from '../config/env';
import { runDailyLotteryDraw } from '../jobs/lotteryDraw';

// 매일 낮 12시(KST) cron이 실제로 도는지, 채널 공지 권한이 제대로 걸려 있는지를
// 다음 정오까지 기다리지 않고 바로 확인하기 위한 수동 실행 스크립트.
//
// 오늘 회차가 이미 정산(settled)된 상태라면 대상 티켓이 0장이라 잭팟/유저 잔액에는
// 아무 영향이 없다 - "결과 공지 메시지가 채널에 정상적으로 올라오는지"만 확인하는 용도로
// 여러 번 실행해도 안전하다. (아직 정산 전이라면 실제 오늘자 추첨이 그대로 실행되니 주의)
//
// 다만 매번 실제 crypto 난수 추첨을 한 번씩 소모하고 LotteryDrawLog에 기록을 남긴다 -
// 반복 실행할수록 "실제 정오 추첨"과 무관한 표본이 감사 로그에 섞이므로, 실수로 습관적으로
// 돌리는 걸 막기 위해 --confirm 플래그 없이는 아무 것도 하지 않고 종료한다.
// (기록되는 source는 MANUAL이라 CRON 정규 추첨과는 분석 시 구분 가능하다)
//
// 실행: railway run tsx src/scripts/manualLotteryDraw.ts --confirm
//   또는 로컬 .env가 채워져 있다면: tsx src/scripts/manualLotteryDraw.ts --confirm
async function main() {
  if (!process.argv.includes('--confirm')) {
    console.log(
      '이 스크립트는 실제 복권 추첨(crypto 난수 소모 + DB 반영 + 채널 공지)을 1회 실행합니다.\n' +
        '반복 실행하면 LotteryDrawLog 감사 로그에 실제 정오 추첨과 무관한 표본이 섞이니,\n' +
        '의도한 실행이 맞다면 --confirm 플래그를 붙여 다시 실행하세요.\n' +
        '  예) tsx src/scripts/manualLotteryDraw.ts --confirm'
    );
    return;
  }

  const client = new Client({ intents: [GatewayIntentBits.Guilds] });

  await new Promise<void>((resolve, reject) => {
    client.once('ready', () => resolve());
    client.login(env.DISCORD_TOKEN).catch(reject);
  });

  console.log(`Logged in as ${client.user?.tag} — 복권 추첨을 수동으로 실행합니다. (source: MANUAL)`);
  await runDailyLotteryDraw(client, LotteryDrawSource.MANUAL);
  console.log('실행 완료. 위 로그에 오류가 없고, 디스코드 채널에 공지 메시지가 올라왔는지 확인하세요.');

  await client.destroy();
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
