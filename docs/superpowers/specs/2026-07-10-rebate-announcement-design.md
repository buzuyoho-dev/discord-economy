# 환급 결과 투명 공지 시스템 설계

## 배경 / 목적

`House Balance Cap` 작업(이 저장소의 직전 브랜치)으로 하우스 잔고 상한(`houseBalanceCapRatio`)
기반 환급 방식이 도입됐다. 환급은 두 경로로 발생한다: ① 매주 정기 배치(`distributionBatch()`),
② 현재 75%→40% 격차를 한 번에 메우는 catch-up CLI 스크립트(`houseBalanceCapCatchUp.ts`).
지금은 정기 배치만 치문 텍스트로 간단히 공지하고("순증가분 기준 환급 재원: N포인트, 대상 M명에게
지급 완료"), catch-up은 콘솔 출력만 있고 디스코드 공지가 전혀 없다. 둘 다 누가 얼마를 받았는지
투명하게 알 수 없다.

이 설계는 두 경로 모두에서, 지급 후 **총 환급액 + 유저별 지급 내역 + 하우스 잔고 상태**를 담은
임베드(Embed, 디스코드에서 제목·설명·표 형태 필드를 갖춘 카드 형태의 풍부한 메시지) 공지를
자동으로 보내도록 만든다.

## 선행 조건

이 스펙/계획은 `worktree-house-balance-cap` 브랜치(하우스 캡 PR, 아직 `main`에 머지 안 됨)가
**머지된 이후**, 새 워크트리에서 구현을 시작하는 것을 전제로 작성됐다. 이 문서가 참조하는
`EconomyConfig`, `getEconomySnapshot()`, `computeRebateDistribution()`, `computeHouseCapExcess()`,
`houseBalanceCapCatchUp.ts` 등은 모두 그 브랜치에서 만들어진 것들이다.

## 범위 확정 (브레인스토밍 중 확인된 사실 / 결정 사항)

- **`EconomyConfig.rebateAnnounceChannelId`가 채널 설정의 단일 기준**이 된다. 기존
  `env.REBATE_ANNOUNCEMENT_CHANNEL_ID`는 완전히 제거한다(더 이상 아무 코드에서도 참조하지
  않음 — DB 컬럼과 달리 env 변수는 이력 보존 가치가 없어 남겨둘 이유가 없음).
- **주간 정기 배치의 기존 치문 텍스트 공지(`announceDistribution()`)는 새 임베드 공지로
  완전히 대체**한다(같은 채널에 메시지 2개가 뜨는 것을 피함).
- **관리용 슬래시 커맨드는 이번 범위 밖**이다. `rebateAnnounceChannelId`는 마이그레이션으로
  기본값(`"1518506716164259910"`)만 시딩하고, 조회/변경 UI는 만들지 않는다(필요하면 나중에
  `/환급설정`에 옵션을 추가하는 후속 작업으로 분리).
- **대규모 유저 처리**: 하나의 임베드 안에서 여러 유저를 필드 하나에 묶어 담는다(필드당 약
  15명, 필드 값 1000자 이내로 안전 마진). 그래도 필드 수가 25개를 넘으면(수백 명 단위)
  전체 명단을 `.txt` 첨부파일로 보내고 임베드에는 요약 필드만 남긴다. 임베드를 여러 개로
  쪼개는 방식은 채택하지 않는다.
- **환급이 없었던 회차("스킵")의 처리**: 주간 정기 배치는 기존과 동일하게 스킵이어도 계속
  공지한다(사유만 다른 간단한 임베드). catch-up 스크립트는 `execute=true`이고
  `totalDistributed > 0`일 때만 디스코드에 공지한다 — dry-run이거나 초과분이 없을 때는
  터미널 콘솔 출력만으로 충분하고, 운영자가 직접 실행하는 CLI라 매번 디스코드에 알릴
  필요가 없다.
- **지급 로직과 공지 로직은 완전히 분리**하고, 공지가 실패해도 지급(DB 트랜잭션)은 이미 커밋된
  상태를 유지한다 — 기존 `runDistributionBatch()`의 `DiscordAPIError`(50001/50013) 처리
  패턴을 그대로 재사용한다.

## 데이터 모델 변경

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

SQLite 프로젝트라 컬럼 추가는 마이그레이션 파일 하나로 처리하고
(`npx prisma migrate dev --name add_rebate_announce_channel_id`), 기존 싱글톤 row에
기본값이 자동으로 채워진다(House Balance Cap 작업 때 `houseBalanceCapRatio` 추가와 동일한
패턴). `getOrCreateEconomyConfig()`는 변경 없이 이 필드도 함께 반환한다.

## 서비스/Discord 계층 변경

### 1. `src/discord/rebateAnnouncement.ts` (신규)

**순수 함수 — Discord API 호출 없음, 단위 테스트 가능:**

```ts
export type RebateReason = 'WEEKLY_BATCH' | 'CATCH_UP';

export interface RebateAnnouncementParams {
  reason: RebateReason;
  distributed: boolean; // false면 "이번엔 환급 없음" 간단 임베드
  totalDistributed: number;
  perUserAmounts: { discordId: string; amount: number }[];
  houseBalanceAfter: number;
  totalEconomy: number;
  capRatio: number;
}

export function buildRebateAnnouncementEmbed(
  params: RebateAnnouncementParams
): { embed: EmbedBuilder; file?: AttachmentBuilder }
```

- **제목**: 사유별로 다름 — `WEEKLY_BATCH`는 "💰 환급 지급 완료 (주간 정기 배치)",
  `CATCH_UP`은 "💰 하우스 캡 초과분 catch-up 정산 완료". `distributed === false`일 땐
  "📭 이번 회차 환급 없음"으로 별도 처리.
- **설명(description)**: 총 환급액(`totalDistributed.toLocaleString()`P), 환급 후 하우스
  잔고 + 전체 경제 대비 퍼센트(`totalEconomy > 0 ? houseBalanceAfter/totalEconomy*100 : 0`,
  소수 1자리, 0으로 나누기 방지), 목표 캡 비율(`capRatio*100`%)과 비교, 지급 대상 인원수.
- **유저별 내역 필드**: `perUserAmounts`를 금액 내림차순 정렬 후 `<@discordId>: N,NNN,NNNP`
  줄들을 필드 값 1000자 이내로 묶어 여러 `field`에 담는다(필드당 대략 15명, 정확한
  묶음 개수는 각 줄의 실제 길이에 따라 달라짐). 필드 수가 25개를 넘어서면(→ 대략 375명
  이상) 전체 명단을 `AttachmentBuilder`(디스코드 메시지에 파일을 덧붙이는 기능)로 만든
  `.txt` 파일로 대체하고, 임베드에는 "지급 대상 N명 (첨부파일 참고)" 요약 필드 하나만
  넣는다.
- `distributed === false`일 땐 유저별 내역 필드 없이 사유 설명만 담는다.

**부수효과 있음 — 실제 전송 담당:**

```ts
export async function sendRebateAnnouncement(
  client: Client,
  channelId: string,
  params: RebateAnnouncementParams
): Promise<void>
```

`client.channels.fetch(channelId)` → 텍스트 채널/전송 가능 여부 확인(`isTextBased()`,
`isSendable()`) → `buildRebateAnnouncementEmbed()`로 만든 `{ embed, file }`을
`channel.send({ embeds: [embed], files: file ? [file] : [] })`로 전송. 채널을 못 찾거나
권한이 없으면 에러를 그대로 던진다(호출부에서 잡아 처리).

**참고**: `DistributionBatchResult`/`CatchUpPlan`은 `houseBalanceAfter`/`totalEconomy`를
직접 담고 있지 않다(각각 `fundAmount`/`houseBalanceBefore` 등만 있음). 이 값들을 위해
새 필드를 추가하지 않고, 호출부(잡/스크립트)에서 지급 트랜잭션이 끝난 뒤
`getEconomySnapshot()`을 한 번 더 호출해 그 시점의 실제 `house.balance`/`totalEconomy`를
읽는다 — 환급은 하우스→유저 이동일 뿐 `totalEconomy` 자체는 바꾸지 않으므로(House Balance
Cap 스펙의 "캡 도달 후 연속 실행" 테스트로 이미 검증됨) 이 추가 조회는 저렴하고 정확하다.
핵심 결과 타입들은 변경하지 않아 기존 소비자(테스트 등)에 영향이 없다.

### 2. `src/jobs/distributionBatch.ts` 수정

기존 `announceDistribution()` 함수(치문 텍스트 조립 + 전송)를 삭제하고, `runDistributionBatch()`
안에서 `distributionBatch()` 실행 결과로 `getOrCreateEconomyConfig()`를 다시 조회해
`rebateAnnounceChannelId`를 얻은 뒤 `sendRebateAnnouncement()`를 호출한다.
`distributed === false`(스킵)일 때도 기존과 동일하게 계속 호출하되, `params.distributed = false`로
넘겨 간단한 임베드가 나가게 한다. 기존 `DiscordAPIError`(50001/50013) 구분 처리 로직은
그대로 유지한다("지급/스킵 자체는 정상 처리됐고 공지만 실패했다"는 걸 명확히 로그로 남김).

### 3. `src/scripts/houseBalanceCapCatchUp.ts` 수정

`main()`을 `manualLotteryDraw.ts`와 동일한 패턴으로 확장한다: `Client` 생성 →
`client.login(env.DISCORD_TOKEN)` → `runCatchUp()` 실행(**변경 없음**, DB 로직은 그대로) →
`execute && plan.totalDistributed > 0`일 때만 별도 try-catch로 감싼
`sendRebateAnnouncement()` 호출(채널 ID는 `getOrCreateEconomyConfig()`로 조회) →
`client.destroy()`. dry-run이거나 초과분이 없으면 Discord 클라이언트 로그인/공지 없이
기존처럼 콘솔 출력만 한다(불필요한 로그인 자체를 생략해 더 가볍게 만듦).

### 4. `src/config/env.ts` 수정

`REBATE_ANNOUNCEMENT_CHANNEL_ID` 필드를 제거한다(더 이상 아무 코드에서도 참조하지 않음).

## 테스트 전략

- `buildRebateAnnouncementEmbed()`: 순수 함수라 Discord 연결 없이 유닛 테스트
  (`tests/discord/rebateAnnouncement.test.ts`, 신규). 케이스:
  - 소수 유저(필드 1개)
  - 필드 여러 개로 나뉘지만 25개 이내(수십~백 명대)
  - 25필드 초과 → `.txt` 첨부파일 폴백 + 요약 필드로 전환
  - `distributed: false`(환급 없음) 케이스의 간단 임베드
  - `WEEKLY_BATCH`/`CATCH_UP` 사유별 제목 차이
  - `totalEconomy = 0`일 때 퍼센트 계산이 0%로 안전하게 처리되는지
- `sendRebateAnnouncement()`: 실제 Discord API 호출이 필요해서 이 프로젝트의 기존
  `jobs/`·채널 전송 코드들과 동일하게 자동 테스트 대상에서 제외한다(`src/jobs/distributionBatch.ts`,
  `src/jobs/lotteryDraw.ts`도 전용 테스트가 없는 것과 동일한 컨벤션). 배포 후
  `manualLotteryDraw.ts`처럼 수동으로 채널에 메시지가 뜨는지 확인한다.

## 영향받지 않는 부분 (명시적 범위 제외)

- `distributionBatch()`/`runCatchUp()`의 DB 로직(재원 계산, 분배, 감사 로그 기록)은 전혀
  건드리지 않는다 — 이번 작업은 순수하게 "결과를 어떻게 알리는가"에 관한 것.
- `/환급설정`, `/환급설정조회` 등 기존 커맨드는 변경하지 않는다.
- 베팅2배쿠폰 발급 로직, 하위 30% 판정 로직 등은 변경 없음.
