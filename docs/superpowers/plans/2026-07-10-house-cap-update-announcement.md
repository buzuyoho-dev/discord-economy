# 하우스 캡 업데이트 공지 스크립트 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 플레이어들에게 하우스 잔고 상한 시스템 개편을 안내하는, 정확히 한 번만 실행할 일회성 CLI 스크립트를 만든다.

**Architecture:** `src/scripts/announceUpdate.ts` 신규 파일 하나. `manualLotteryDraw.ts`의 Discord `Client` 생성/로그인/종료 패턴을 그대로 따르고, `getOrCreateEconomyConfig()`로 읽은 `rebateAnnounceChannelId` 채널에 정적 임베드 하나를 보낸다. 새 계산/DB 로직은 없다.

**Tech Stack:** TypeScript, discord.js v14, Prisma(간접적으로, `getOrCreateEconomyConfig()` 통해서만).

## Global Constraints

- **선행 조건**: `EconomyConfig.rebateAnnounceChannelId`는 `rebate-announcement` PR에서 추가된 필드로, 이 계획은 그 PR이 `main`에 머지된 이후의 코드베이스를 전제로 작성되었다. 구현 착수 전 반드시 머지 완료 상태의 `main`에서 새 워크트리를 만들 것.
- 채널 ID는 `getOrCreateEconomyConfig()`로 읽은 `config.rebateAnnounceChannelId`를 그대로 쓴다 — 하드코딩하지 않는다.
- 슬래시 커맨드로 만들지 않는다 — 딱 이 스크립트 파일 하나로 끝낸다.
- 테스트는 만들지 않는다 — 정적 텍스트를 한 채널에 한 번 보내는 스크립트라 이 프로젝트의 기존 컨벤션(`jobs/`·`scripts/`의 Discord 전송 코드는 자동 테스트 대상 아님)과 일치한다.
- 참고 스펙: `docs/superpowers/specs/2026-07-10-house-cap-update-announcement.md`

---

### Task 1: `src/scripts/announceUpdate.ts` 신규 작성

**Files:**
- Create: `src/scripts/announceUpdate.ts`
- Modify: `PROGRESS.md`

**Interfaces:**
- Consumes: `getOrCreateEconomyConfig()`(기존, `src/services/economyConfig.ts`)

이 파일은 테스트가 없다(위 Global Constraints 참고). 타입체크로만 검증한다.

- [ ] **Step 1: `src/scripts/announceUpdate.ts` 신규 생성**

```ts
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
```

- [ ] **Step 2: 타입체크 실행**

Run: `npx tsc --noEmit`
Expected: 에러 0건

- [ ] **Step 3: 전체 테스트 스위트 실행 (회귀 확인)**

Run: `npx vitest run`
Expected: 새 파일은 테스트 대상이 아니므로 기존과 동일한 결과. 이 브랜치가 시작되는
시점(`main`, 머지 완료 상태) 기준으로 알려진 실패가 없어야 정상이다 — 만약 무관해
보이는 기존 실패가 있다면 계속 진행하기 전에 컨트롤러에게 보고할 것.

- [ ] **Step 4: 커밋**

```bash
git add src/scripts/announceUpdate.ts
git commit -m "feat: 하우스 잔고 상한 시스템 업데이트 안내 공지 스크립트 추가"
```

---

### Task 2: `PROGRESS.md`에 한 줄 요약

**Files:**
- Modify: `PROGRESS.md`

- [ ] **Step 1: 최상단 날짜 갱신 + 한 줄 요약 추가**

Run: `date +%Y-%m-%d` (오늘 날짜를 `YYYY-MM-DD` 형식으로 확인)

`PROGRESS.md` 3번째 줄의 `> 최종 업데이트: ...`를 위 명령으로 확인한 오늘 날짜로 바꾼다.

가장 최근 섹션(환급 결과 투명 공지 시스템 요약) 바로 앞(구분선 `---` 다음 줄)에 다음
한 줄짜리 항목을 삽입한다:

```markdown
## 하우스 캡 업데이트 안내 공지 스크립트 실행 (실행한 날짜로 교체)

`src/scripts/announceUpdate.ts`(일회성)로 플레이어들에게 하우스 잔고 상한 시스템 개편
안내를 `EconomyConfig.rebateAnnounceChannelId` 채널에 공지 완료. 재사용 불필요한
일회성 스크립트라 슬래시 커맨드로는 만들지 않음.

---
```

`(실행한 날짜로 교체)` 부분은 위에서 확인한 오늘 날짜로 채운다.

- [ ] **Step 2: 커밋**

```bash
git add PROGRESS.md
git commit -m "docs: 하우스 캡 업데이트 공지 스크립트 실행 내역을 PROGRESS.md에 요약"
```

---

## Self-Review 체크리스트 (계획 작성자용, 참고)

- **스펙 커버리지**: 스펙의 "메시지 내용"·"파일 구조"·"실행 방법"이 모두 Task1에 반영됨.
  "PROGRESS.md 한 줄 요약"(사용자 원 요청사항)은 Task2로 별도 분리.
- **플레이스홀더 없음**: 모든 스텝에 실제 코드/명령어가 포함되어 있음. Task2의
  "(실행한 날짜로 교체)"는 이전 계획들과 동일하게 `date` 명령으로 실제 값을 구해
  채우도록 명시적으로 지시했으므로 방치된 플레이스홀더가 아님.
- **타입 일관성**: 해당 없음(단일 신규 파일, 다른 파일과 인터페이스를 주고받지 않음).
