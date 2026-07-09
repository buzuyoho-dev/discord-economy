# 환급 결과 투명 공지 시스템 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 주간 정기 배치와 catch-up CLI 스크립트 양쪽에서, 환급 지급 후 총액/유저별 지급 내역/하우스 잔고 상태를 담은 임베드(Embed) 공지를 지정된 채널에 자동으로 보낸다.

**Architecture:** `src/discord/rebateAnnouncement.ts`에 순수 함수 `buildRebateAnnouncementEmbed()`(임베드/첨부파일 조립, DB·Discord API 호출 없음)와 얇은 I/O 래퍼 `sendRebateAnnouncement()`(채널 조회 + 전송)를 만들어 두 호출부가 공유한다. `EconomyConfig.rebateAnnounceChannelId`가 채널 설정의 단일 기준이 되고, 기존 env 기반 치문 텍스트 공지는 완전히 제거된다. 지급(DB) 로직과 공지(Discord) 로직은 항상 별도 try-catch로 분리되어, 공지가 실패해도 이미 커밋된 지급 결과에는 영향이 없다.

**Tech Stack:** TypeScript, Prisma(SQLite), discord.js v14, Vitest.

## Global Constraints

- **선행 조건**: 이 계획은 `house-balance-cap` PR이 `main`에 머지된 이후의 코드베이스를 전제로 작성되었다. 구현 착수 전 반드시 `main`(머지 완료 상태)에서 새 워크트리를 만들 것.
- `EconomyConfig.rebateAnnounceChannelId`가 채널 설정의 단일 기준이다. 기존 `env.REBATE_ANNOUNCEMENT_CHANNEL_ID`는 완전히 제거한다(코드 어디에서도 참조하지 않게 됨).
- 주간 정기 배치의 기존 치문 텍스트 공지(`announceDistribution()`)는 새 임베드 공지로 완전히 대체한다 — 같은 채널에 메시지 2개를 보내지 않는다.
- 관리용 슬래시 커맨드는 만들지 않는다. `rebateAnnounceChannelId`는 마이그레이션으로 기본값(`"1518506716164259910"`)만 시딩한다.
- 대규모 유저 처리: 하나의 임베드 안에서 여러 유저를 필드 하나에 묶어 담는다(필드 값 1000자 이내 안전 마진). 필드 수가 25개를 넘으면 전체 명단을 `.txt` 첨부파일로 대체한다. 여러 임베드로 쪼개지 않는다.
- 주간 정기 배치는 환급이 없었던("스킵") 회차에도 계속 공지한다(간단한 임베드). catch-up 스크립트는 `execute=true`이고 실제 지급액이 0보다 클 때만 공지한다.
- 지급 로직과 공지 로직은 항상 별도 try-catch로 분리하고, 공지 실패가 지급 결과에 영향을 주지 않게 한다.
- 참고 스펙: `docs/superpowers/specs/2026-07-10-rebate-announcement-design.md`

---

### Task 1: `EconomyConfig.rebateAnnounceChannelId` 추가 + 마이그레이션

**Files:**
- Modify: `prisma/schema.prisma` (`EconomyConfig` model)
- Test: `tests/services/economyConfig.test.ts`

**Interfaces:**
- Produces: `EconomyConfig.rebateAnnounceChannelId: string` (Prisma 타입, 기본값 `"1518506716164259910"`)

- [ ] **Step 1: `prisma/schema.prisma`의 `EconomyConfig` 모델에 필드 추가**

다음 부분을 찾는다:

```prisma
model EconomyConfig {
  id                   String   @id @default("SINGLETON")
  rebateRate           Float    @default(0.05)
  lowerTierWeight      Float    @default(1.5)
  houseBalanceCapRatio Float    @default(0.4)
  updatedAt            DateTime @updatedAt
}
```

다음으로 교체한다:

```prisma
model EconomyConfig {
  id                      String   @id @default("SINGLETON")
  rebateRate              Float    @default(0.05)
  lowerTierWeight         Float    @default(1.5)
  houseBalanceCapRatio    Float    @default(0.4)
  rebateAnnounceChannelId String   @default("1518506716164259910")
  updatedAt               DateTime @updatedAt
}
```

- [ ] **Step 2: 마이그레이션 생성 및 적용**

Run: `npx prisma migrate dev --name add_rebate_announce_channel_id`
Expected: `prisma/migrations/<timestamp>_add_rebate_announce_channel_id/migration.sql` 생성, Prisma Client 자동 재생성(`✔ Generated Prisma Client`).

- [ ] **Step 3: 실패하는 테스트 작성 — `tests/services/economyConfig.test.ts`의 기본값 테스트 확장**

다음 부분을 찾는다:

```ts
  test('row가 없으면 기본값(5%, 1.5배, 캡비율 40%)으로 지연 생성한다', async () => {
    const config = await getOrCreateEconomyConfig();

    expect(config.id).toBe(ECONOMY_CONFIG_ID);
    expect(config.rebateRate).toBe(0.05);
    expect(config.lowerTierWeight).toBe(1.5);
    expect(config.houseBalanceCapRatio).toBe(0.4);
  });
```

다음으로 교체한다:

```ts
  test('row가 없으면 기본값(5%, 1.5배, 캡비율 40%, 환급공지채널)으로 지연 생성한다', async () => {
    const config = await getOrCreateEconomyConfig();

    expect(config.id).toBe(ECONOMY_CONFIG_ID);
    expect(config.rebateRate).toBe(0.05);
    expect(config.lowerTierWeight).toBe(1.5);
    expect(config.houseBalanceCapRatio).toBe(0.4);
    expect(config.rebateAnnounceChannelId).toBe('1518506716164259910');
  });
```

- [ ] **Step 4: 테스트 실행해서 통과 확인**

Run: `npx vitest run tests/services/economyConfig.test.ts`
Expected: PASS (마이그레이션으로 이미 필드가 생겼으므로 구현 코드 변경 없이 바로 통과함 — `getOrCreateEconomyConfig()`는 Prisma가 반환하는 row를 그대로 돌려주는 함수라 스키마 필드 추가만으로 충분하다)

- [ ] **Step 5: 전체 테스트 스위트 + 타입체크 실행**

Run: `npx vitest run && npx tsc --noEmit`
Expected: 둘 다 통과 (기존에 통과하던 다른 테스트들도 회귀 없이 계속 통과해야 함). 참고: 이 브랜치가 시작되는 시점(`main`, 머지 완료 상태) 기준으로 알려진 실패가 없어야 정상이다 — 만약 무관해 보이는 기존 실패가 있다면 계속 진행하기 전에 컨트롤러에게 보고할 것.

- [ ] **Step 6: 커밋**

```bash
git add prisma/schema.prisma prisma/migrations tests/services/economyConfig.test.ts
git commit -m "feat: EconomyConfig에 rebateAnnounceChannelId 추가"
```

---

### Task 2: `src/discord/rebateAnnouncement.ts` 신규 — 임베드 조립 + 전송

**Files:**
- Create: `src/discord/rebateAnnouncement.ts`
- Test: `tests/discord/rebateAnnouncement.test.ts`

**Interfaces:**
- Produces: `RebateReason = 'WEEKLY_BATCH' | 'CATCH_UP'`
- Produces: `RebateAnnouncementUserAmount = { discordId: string; amount: number }`
- Produces: `RebateAnnouncementParams = { reason: RebateReason; distributed: boolean; totalDistributed: number; perUserAmounts: RebateAnnouncementUserAmount[]; houseBalanceAfter: number; totalEconomy: number; capRatio: number }`
- Produces: `buildRebateAnnouncementEmbed(params: RebateAnnouncementParams): { embed: EmbedBuilder; file?: AttachmentBuilder }` — 순수 함수. Task 3, Task 4에서 간접적으로(아래 `sendRebateAnnouncement`을 통해) 재사용됨.
- Produces: `sendRebateAnnouncement(client: Client, channelId: string, params: RebateAnnouncementParams): Promise<void>` — Task 3, Task 4에서 직접 호출됨. 채널을 찾을 수 없거나 전송 불가능하면 `Error`를 던짐(호출부에서 잡아 처리).

- [ ] **Step 1: 실패하는 테스트 작성 — `tests/discord/rebateAnnouncement.test.ts` 신규 생성**

```ts
import { AttachmentBuilder, EmbedBuilder } from 'discord.js';
import { describe, expect, test } from 'vitest';
import { buildRebateAnnouncementEmbed } from '../../src/discord/rebateAnnouncement';

describe('buildRebateAnnouncementEmbed - 정상 지급', () => {
  test('소수 유저면 필드 1개에 금액 내림차순으로 담긴다', () => {
    const { embed, file } = buildRebateAnnouncementEmbed({
      reason: 'WEEKLY_BATCH',
      distributed: true,
      totalDistributed: 500_000,
      perUserAmounts: [
        { discordId: 'u1', amount: 300_000 },
        { discordId: 'u2', amount: 200_000 },
      ],
      houseBalanceAfter: 37_000_003,
      totalEconomy: 92_500_000,
      capRatio: 0.4,
    });

    expect(embed).toBeInstanceOf(EmbedBuilder);
    expect(embed.data.title).toBe('💰 환급 지급 완료 (주간 정기 배치)');
    expect(embed.data.description).toContain('500,000P');
    expect(embed.data.description).toContain('37,000,003P');
    expect(embed.data.description).toContain('40.0%'); // 37,000,003/92,500,000 ≈ 40.0%
    expect(embed.data.description).toContain('목표 40% 이하');
    expect(embed.data.fields).toHaveLength(1);
    expect(embed.data.fields![0].name).toBe('지급 내역');
    expect(embed.data.fields![0].value.indexOf('u1')).toBeLessThan(
      embed.data.fields![0].value.indexOf('u2')
    );
    expect(embed.data.fields![0].value).toContain('<@u1>: 300,000P');
    expect(embed.data.fields![0].value).toContain('<@u2>: 200,000P');
    expect(file).toBeUndefined();
  });

  test('CATCH_UP 사유면 제목이 다르다', () => {
    const { embed } = buildRebateAnnouncementEmbed({
      reason: 'CATCH_UP',
      distributed: true,
      totalDistributed: 100,
      perUserAmounts: [{ discordId: 'u1', amount: 100 }],
      houseBalanceAfter: 1000,
      totalEconomy: 10_000,
      capRatio: 0.4,
    });

    expect(embed.data.title).toBe('💰 하우스 캡 초과분 catch-up 정산 완료');
  });
});

describe('buildRebateAnnouncementEmbed - 환급 없음', () => {
  test('distributed=false면 간단한 임베드만 만들고 유저별 내역 필드가 없다', () => {
    const { embed, file } = buildRebateAnnouncementEmbed({
      reason: 'WEEKLY_BATCH',
      distributed: false,
      totalDistributed: 0,
      perUserAmounts: [],
      houseBalanceAfter: 1_000_000,
      totalEconomy: 6_000_000,
      capRatio: 0.4,
    });

    expect(embed.data.title).toBe('📭 이번 회차 환급 없음');
    expect(embed.data.description).toContain('환급이 지급되지 않았습니다');
    expect(embed.data.fields ?? []).toHaveLength(0);
    expect(file).toBeUndefined();
  });
});

describe('buildRebateAnnouncementEmbed - 필드 여러 개로 분할 (25개 이내)', () => {
  test('유저가 많으면 여러 필드로 나뉘지만 25개를 넘지 않는다', () => {
    const perUserAmounts = Array.from({ length: 60 }, (_, i) => ({
      discordId: `user${i + 1}`,
      amount: 1_000_000 + i,
    }));

    const { embed, file } = buildRebateAnnouncementEmbed({
      reason: 'WEEKLY_BATCH',
      distributed: true,
      totalDistributed: perUserAmounts.reduce((sum, u) => sum + u.amount, 0),
      perUserAmounts,
      houseBalanceAfter: 37_000_000,
      totalEconomy: 92_500_000,
      capRatio: 0.4,
    });

    expect(file).toBeUndefined();
    expect(embed.data.fields!.length).toBeGreaterThan(1);
    expect(embed.data.fields!.length).toBeLessThanOrEqual(25);
    for (const field of embed.data.fields!) {
      expect(field.value.length).toBeLessThanOrEqual(1024);
    }
    const allFieldText = embed.data.fields!.map((f) => f.value).join('\n');
    for (const user of perUserAmounts) {
      expect(allFieldText).toContain(`<@${user.discordId}>`);
    }
  });
});

describe('buildRebateAnnouncementEmbed - 필드 25개 초과 시 첨부파일 폴백', () => {
  test('유저가 매우 많으면(필드 25개 초과) 전체 명단을 .txt 첨부파일로 대신 보낸다', () => {
    const perUserAmounts = Array.from({ length: 2000 }, (_, i) => ({
      discordId: `user${i + 1}`,
      amount: 1_000_000,
    }));

    const { embed, file } = buildRebateAnnouncementEmbed({
      reason: 'WEEKLY_BATCH',
      distributed: true,
      totalDistributed: perUserAmounts.length * 1_000_000,
      perUserAmounts,
      houseBalanceAfter: 37_000_000,
      totalEconomy: 92_500_000,
      capRatio: 0.4,
    });

    expect(file).toBeInstanceOf(AttachmentBuilder);
    expect(file!.name).toBe('rebate-recipients.txt');
    expect(embed.data.fields).toHaveLength(1);
    expect(embed.data.fields![0].value).toContain('2000명');
    expect(embed.data.fields![0].value).toContain('첨부파일 참고');
  });
});

describe('buildRebateAnnouncementEmbed - 전체 경제 규모 0', () => {
  test('totalEconomy가 0이면 퍼센트가 0%로 안전하게 표시된다', () => {
    const { embed } = buildRebateAnnouncementEmbed({
      reason: 'WEEKLY_BATCH',
      distributed: false,
      totalDistributed: 0,
      perUserAmounts: [],
      houseBalanceAfter: 0,
      totalEconomy: 0,
      capRatio: 0.4,
    });

    expect(embed.data.description).toContain('0.0%');
  });
});
```

- [ ] **Step 2: 테스트 실행해서 실패 확인**

Run: `npx vitest run tests/discord/rebateAnnouncement.test.ts`
Expected: FAIL — `src/discord/rebateAnnouncement.ts` 파일이 없어서 모듈을 찾을 수 없다는 에러(`Cannot find module`)

- [ ] **Step 3: `src/discord/rebateAnnouncement.ts` 신규 생성**

```ts
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
```

- [ ] **Step 4: 테스트 실행해서 통과 확인**

Run: `npx vitest run tests/discord/rebateAnnouncement.test.ts`
Expected: PASS (7개 테스트 모두 통과)

- [ ] **Step 5: 전체 테스트 스위트 + 타입체크 실행**

Run: `npx vitest run && npx tsc --noEmit`
Expected: 둘 다 통과 (에러 0건, 회귀 없음)

- [ ] **Step 6: 커밋**

```bash
git add src/discord/rebateAnnouncement.ts tests/discord/rebateAnnouncement.test.ts
git commit -m "feat: 환급 결과 임베드 공지 조립/전송 함수 추가"
```

---

### Task 3: `src/jobs/distributionBatch.ts` — 임베드 공지로 교체 + env 정리

**Files:**
- Modify: `src/jobs/distributionBatch.ts`
- Modify: `src/config/env.ts`

**Interfaces:**
- Consumes: `sendRebateAnnouncement()` (Task 2), `getEconomySnapshot()`(기존), `getOrCreateEconomyConfig()`(기존)

이 파일은 기존에도 전용 테스트가 없다(Discord 전송이 필요한 코드는 이 프로젝트 컨벤션상 자동 테스트 대상에서 제외 — Task 2의 순수 함수만 테스트하고, 이 파일은 타입체크 + 수동 확인으로 검증한다).

- [ ] **Step 1: `src/jobs/distributionBatch.ts` 전체 교체**

```ts
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
```

- [ ] **Step 2: `src/config/env.ts`에서 `REBATE_ANNOUNCEMENT_CHANNEL_ID` 제거**

다음 줄을 찾아서 삭제한다:

```ts
  REBATE_ANNOUNCEMENT_CHANNEL_ID: process.env.REBATE_ANNOUNCEMENT_CHANNEL_ID,
```

- [ ] **Step 3: 전체 테스트 스위트 + 타입체크 실행**

Run: `npx vitest run && npx tsc --noEmit`
Expected: 둘 다 통과 (에러 0건). `env.REBATE_ANNOUNCEMENT_CHANNEL_ID`를 참조하던 곳이 이제
없어야 하므로, `tsc --noEmit`이 이를 확인해준다.

- [ ] **Step 4: 커밋**

```bash
git add src/jobs/distributionBatch.ts src/config/env.ts
git commit -m "feat: 주간 배치 공지를 임베드로 교체, REBATE_ANNOUNCEMENT_CHANNEL_ID 제거"
```

---

### Task 4: `src/scripts/houseBalanceCapCatchUp.ts` — 조건부 임베드 공지 추가

**Files:**
- Modify: `src/scripts/houseBalanceCapCatchUp.ts`

**Interfaces:**
- Consumes: `sendRebateAnnouncement()` (Task 2), `getEconomySnapshot()`(기존), `getOrCreateEconomyConfig()`(기존)
- `runCatchUp()`/`buildCatchUpPlan()`은 **변경하지 않는다** — 기존 `tests/scripts/houseBalanceCapCatchUp.test.ts`가 그대로 통과해야 함.

이 파일의 `main()`도 전용 테스트가 없다(스크립트 진입점, `manualLotteryDraw.ts`와 동일한 컨벤션).

- [ ] **Step 1: `main()` 함수와 그 위 import를 교체**

파일 최상단 import를 다음으로 교체한다:

```ts
import { Client, DiscordAPIError, GatewayIntentBits } from 'discord.js';
import { Prisma, TransactionType } from '@prisma/client';
import { sendRebateAnnouncement } from '../discord/rebateAnnouncement';
import { prisma } from '../db/client';
import { computeRebateDistribution, getLowerTierUserIds } from '../services/distributionBatch';
import { getOrCreateEconomyConfig } from '../services/economyConfig';
import { applyHouseTransaction, computeHouseCapExcess, getEconomySnapshot } from '../services/house';
import { applyTransaction } from '../services/ledger';

// Discord API 오류 코드: https://discord.com/developers/docs/topics/opcodes-and-status-codes#json
const MISSING_ACCESS = 50001;
const MISSING_PERMISSIONS = 50013;
```

`type Db = ...`, `CatchUpPlanItem`, `CatchUpPlan`, `buildCatchUpPlan()`, `runCatchUp()`는
**그대로 둔다** (변경 없음).

기존 `main()` 함수 전체를 다음으로 교체한다:

```ts
async function main() {
  // 💡 '../config/env'의 env 객체는 DISCORD_TOKEN 등을 import 시점에 즉시 검증(없으면 throw)한다 -
  // 이 스크립트는 테스트가 직접 import하므로(runCatchUp/buildCatchUpPlan 단위 테스트), 거기서
  // env를 정적 import하면 .env가 없는 환경(새 워크트리, CI 등)에서 테스트 스위트 전체가 깨진다.
  // main()이 실제로 실행될 때만(= 이 스크립트를 직접 실행할 때만) dotenv를 동적으로 로드한다.
  await import('dotenv/config');
  const execute = process.argv.includes('--execute');
  // 봇 자신은 절대 catch-up 지급 대상이 되면 안 되므로, 봇의 Discord ID(=DISCORD_CLIENT_ID)를
  // 명시적으로 제외한다. (runDistributionBatch()의 client.user?.id 제외와 동일한 취지)
  const plan = await runCatchUp(execute, undefined, { excludeUserId: process.env.DISCORD_CLIENT_ID });

  if (!execute || plan.totalDistributed <= 0) {
    // dry-run이거나 실제 지급액이 없으면 디스코드 공지 없이 콘솔 출력만으로 충분하다 -
    // 불필요한 로그인 자체를 생략해 더 가볍게 만든다.
    return;
  }

  // 💡 이 스크립트는 상시 실행 중인 봇 프로세스가 아니라 관리자가 직접 실행하는 CLI라서,
  // 공지를 보내야 할 때만 잠깐 로그인했다가 바로 끊는다. (manualLotteryDraw.ts와 동일한 패턴)
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  try {
    await new Promise<void>((resolve, reject) => {
      client.once('ready', () => resolve());
      client.login(process.env.DISCORD_TOKEN).catch(reject);
    });

    const config = await getOrCreateEconomyConfig();
    const { house, totalEconomy } = await getEconomySnapshot();
    await sendRebateAnnouncement(client, config.rebateAnnounceChannelId, {
      reason: 'CATCH_UP',
      distributed: true,
      totalDistributed: plan.totalDistributed,
      perUserAmounts: plan.items,
      houseBalanceAfter: house.balance,
      totalEconomy,
      capRatio: config.houseBalanceCapRatio,
    });
    console.log('디스코드 채널에 공지 메시지를 보냈습니다.');
  } catch (error) {
    // 공지 실패는 지급(DB 처리) 결과에 영향을 주지 않는다 - runCatchUp()이 이미 끝난 뒤이므로.
    if (
      error instanceof DiscordAPIError &&
      (error.code === MISSING_PERMISSIONS || error.code === MISSING_ACCESS)
    ) {
      console.error(
        `지급 처리는 정상적으로 완료되었지만, 공지 메시지 전송에 실패했습니다. 봇에게 채널의 ` +
          `"메시지 보내기" 권한이 있는지 확인해주세요. (Discord error code ${error.code})`
      );
    } else {
      console.error('지급 처리는 정상적으로 완료되었지만, 공지 메시지 전송 중 오류가 발생했습니다.', error);
    }
  } finally {
    await client.destroy();
  }
}

if (require.main === module) {
  main()
    .catch((e) => {
      console.error(e);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
```

- [ ] **Step 2: 기존 테스트가 그대로 통과하는지 확인 (회귀 없음)**

Run: `npx vitest run tests/scripts/houseBalanceCapCatchUp.test.ts`
Expected: PASS — `runCatchUp`/`buildCatchUpPlan`은 변경하지 않았으므로 기존 5개 테스트가
수정 없이 그대로 통과해야 한다.

- [ ] **Step 3: 전체 테스트 스위트 + 타입체크 실행**

Run: `npx vitest run && npx tsc --noEmit`
Expected: 둘 다 통과 (에러 0건, 회귀 없음)

- [ ] **Step 4: 커밋**

```bash
git add src/scripts/houseBalanceCapCatchUp.ts
git commit -m "feat: catch-up 스크립트에 조건부 임베드 공지 추가 (execute && 실제 지급 시에만)"
```

---

### Task 5: `PROGRESS.md`에 변경 사항 요약

**Files:**
- Modify: `PROGRESS.md`

- [ ] **Step 1: 최상단 날짜 갱신 + 새 섹션 삽입**

Run: `date +%Y-%m-%d` (오늘 날짜를 `YYYY-MM-DD` 형식으로 확인)

`PROGRESS.md` 3번째 줄의 `> 최종 업데이트: ...`를 위 명령으로 확인한 오늘 날짜로 바꾼다.

가장 최근 섹션(House Balance Cap 요약) 바로 앞(구분선 `---` 다음 줄)에 다음 섹션을 삽입한다.
아래 예시의 `2026-07-10` 부분은 실제로는 위에서 확인한 오늘 날짜로 채운다:

```markdown
## 환급 결과 투명 공지 시스템 구현 (2026-07-10)

**배경**: 하우스 캡 기반 환급이 주간 정기 배치와 catch-up 스크립트 양쪽에서 발생하는데,
누가 얼마를 받았는지 디스코드에서 투명하게 알 수 있는 방법이 없었음(정기 배치는 요약
치문 텍스트뿐, catch-up은 공지 자체가 없었음).

**변경 사항**:
- `EconomyConfig.rebateAnnounceChannelId`(기본값 `1518506716164259910`) 추가 - 환급
  공지 채널의 단일 기준. 기존 `env.REBATE_ANNOUNCEMENT_CHANNEL_ID`는 완전히 제거.
- `src/discord/rebateAnnouncement.ts` (신규): 총 환급액/유저별 지급 내역(금액 내림차순,
  멘션 표시)/환급 후 하우스 잔고 및 캡 대비 퍼센트를 담은 임베드를 조립하는
  `buildRebateAnnouncementEmbed()`(순수 함수)와, 채널을 조회해 실제 전송하는
  `sendRebateAnnouncement()`. 유저가 많으면(필드 25개 초과, 대략 375명 이상) 전체
  명단을 `.txt` 첨부파일로 대체.
- 주간 정기 배치(`src/jobs/distributionBatch.ts`)는 기존 치문 텍스트 공지를 이 임베드로
  완전히 교체. 환급이 없었던 회차도 계속 공지(간단한 임베드).
- catch-up 스크립트(`src/scripts/houseBalanceCapCatchUp.ts`)는 `--execute`로 실행해
  실제 지급이 있었을 때만 잠깐 디스코드에 로그인해 공지를 보내고 바로 로그아웃.
- 지급(DB) 로직과 공지(Discord) 로직은 항상 분리된 try-catch로 감싸서, 공지 전송이
  실패해도(권한 문제 등) 이미 완료된 지급 결과에는 영향이 없음.

**설계 문서**: `docs/superpowers/specs/2026-07-10-rebate-announcement-design.md`
**구현 계획**: `docs/superpowers/plans/2026-07-10-rebate-announcement.md`

**다음 세션에서 확인 필요**:
- [ ] `.env`/Railway 설정에서 이제 안 쓰는 `REBATE_ANNOUNCEMENT_CHANNEL_ID`는 그냥
      정리되지 않은 채로 남아있어도 무해함(코드가 더 이상 읽지 않음) - 원하면 정리
- [ ] 채널 `1518506716164259910`에 봇의 "메시지 보내기"/"파일 첨부" 권한이 있는지 확인
- [ ] 실제 디스코드에서 주간 배치(또는 catch-up dry-run 없이 소액 execute)로 임베드가
      의도한 대로(총액/유저별 내역/하우스 잔고%) 표시되는지 수동 확인
- [ ] 유저 수가 매우 많을 때(수백 명 이상) `.txt` 첨부파일 폴백이 실제로도 정상 동작하는지
      수동 확인(유닛 테스트로는 검증했지만 실제 디스코드 전송은 미확인)
```

- [ ] **Step 2: 커밋**

```bash
git add PROGRESS.md
git commit -m "docs: 환급 결과 투명 공지 시스템 구현 내역을 PROGRESS.md에 요약"
```

---

## Self-Review 체크리스트 (계획 작성자용, 참고)

- **스펙 커버리지**: 스펙의 "데이터 모델 변경"→Task1, "`buildRebateAnnouncementEmbed`/
  `sendRebateAnnouncement`"→Task2, "주간 배치 교체"→Task3, "catch-up 스크립트 확장"→Task4,
  "PROGRESS.md 요약"→Task5. 스펙의 "영향받지 않는 부분"(`distributionBatch()`/`runCatchUp()`의
  DB 로직, 기존 커맨드, 쿠폰/하위 30% 로직)은 의도적으로 어떤 Task에서도 건드리지 않음.
- **플레이스홀더 없음**: 모든 스텝에 실제 코드/명령어가 포함되어 있음.
- **타입 일관성**: `RebateAnnouncementParams`의 필드 구성이 Task2(정의)·Task3·Task4(사용)
  전부 동일. `CatchUpPlanItem`(`{discordId, amount}`)이 `RebateAnnouncementUserAmount`와
  구조적으로 호환되어 Task4에서 `plan.items`를 그대로 `perUserAmounts`에 넘길 수 있음을 확인.
