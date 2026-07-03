# 미니게임 플레이 횟수 지급 커맨드 (`/횟수지급`) 설계

## 배경 / 목적

오픈 기념 이벤트로 블랙잭 잔여 플레이 횟수를 +2 지급하기 위해 1회성 스크립트
(`src/scripts/grantBlackjackBonus.ts`)를 만들어 실행했다. 앞으로도 이런 "미니게임
플레이 횟수 지급" 요청이 반복될 것으로 예상되므로, 매번 스크립트를 새로 짜는 대신
상시 관리자 슬래시 커맨드로 처리한다.

## 범위 확정 (브레인스토밍 중 확인된 사실)

이 프로젝트에서 "오늘 플레이 횟수"라는 개념(`MinigamePlayLog` 기반, 매일 초기화)은
**현재 블랙잭에만 존재한다**:
- 블랙잭: `MinigamePlayLog` + `gameType: 'BLACKJACK'`, 하루 최대 5회 (`MAX_PLAYS_PER_DAY`)
- 가위바위보(RPS): `rps-minigame-spec.md`에 "일일 플레이 횟수 제한: 없음 (PvP 특성상
  자연스럽게 제한됨)"으로 명시. 실제 `rpsGame.ts` 코드도 `MinigamePlayLog`를 전혀
  쓰지 않음.
- 복권: `LotteryTicket` 모델(유저당 하루 1장 구매) — "잔여 횟수" 개념 자체가 없는
  완전히 다른 시스템.

**결정**: `/횟수지급`의 "게임" 선택지는 **블랙잭만** 우선 지원한다. 다만 내부 구조는
"같은 `MinigamePlayLog` 패턴을 쓰는 게임이 나중에 추가되면 레지스트리에 한 줄만
추가하면 되는" 확장 가능한 형태로 만든다. RPS에 새로 일일 제한을 도입하거나 복권을
이 시스템에 억지로 끼워 맞추는 것은 이번 작업 범위 밖이다.

## 데이터 모델 변경

- `prisma/schema.prisma`의 `TransactionType` enum에 `MINIGAME_PLAY_GRANT` 추가.
  SQLite라 마이그레이션 파일은 필요 없고 `prisma generate`만 다시 돌리면 된다
  (이 프로젝트에서 이미 확인된 사실).
- `src/discord/transactionView.ts`의 `TRANSACTION_TYPE_LABELS`에
  `MINIGAME_PLAY_GRANT: '미니게임 횟수 지급'` 추가 → 기존 `/포인트내역` 커맨드가
  별도 수정 없이 이 지급 내역을 그대로 조회해준다.
- 새 테이블은 만들지 않는다. 기존 `MinigamePlayLog`(오늘 플레이 횟수)와
  `Transaction`(감사 이력)만 재사용한다.

### `Transaction.amount`를 0으로 기록하는 이유

플레이 횟수 지급은 포인트 잔액과 무관하다. 하지만 요구사항상 "Transaction 테이블 +
`applyTransaction`으로 기록해서 나중에 `/포인트내역`처럼 조회 가능하게" 해야 한다.
그래서 `amount: 0`으로 기록하고(잔액 변동 없음), 몇 회를 지급했는지·사유가 뭔지는
`description`에 텍스트로 남긴다.
예: `블랙잭 잔여 횟수 +2 지급 (오픈 기념 이벤트)`

## 서비스 계층 — `src/services/minigamePlayGrant.ts` (신규)

```ts
export const MINIGAME_REGISTRY = {
  BLACKJACK: { label: '블랙잭', gameType: BLACKJACK_GAME_TYPE, maxPlaysPerDay: MAX_PLAYS_PER_DAY },
  // 향후 같은 패턴(MinigamePlayLog) 쓰는 게임이 추가되면 여기 한 줄만 추가
} as const;
export type MinigameChoice = keyof typeof MINIGAME_REGISTRY;
```

두 계층으로 나눈다:

1. **코어 함수** (대상 목록을 인자로 받음 — "누가 대상인지"는 모른다):
   - `buildMinigamePlayGrantPlan(db, { game, targetUserIds, count, now })`
     — 읽기 전용. 유저별 before/after 잔여 횟수 미리보기만 계산한다.
     `db`는 `Prisma.TransactionClient | typeof prisma` (기존 `distributionBatch.ts`의
     `Db` 타입 패턴 재사용).
   - `applyMinigamePlayGrant(tx, { game, targetUserIds, count, reason, now })`
     — 실제 반영. 유저마다 `MinigamePlayLog.upsert(count -= N)` +
     `applyTransaction(MINIGAME_PLAY_GRANT, amount: 0, description)`을 수행하고
     plan을 반환한다. 반드시 `prisma.$transaction` 안에서 호출되는 `tx`를 받는다.

   이렇게 "대상 결정"과 "실제 반영"을 분리하는 이유는 `distributionBatch.ts`가
   `getLowerTierUserIds()`(대상 결정)와 `issueCouponsForUsers()`(반영)를 분리한 것과
   동일하다 — 호출하는 쪽(슬래시 커맨드 vs 1회성 스크립트)마다 "대상을 누구로
   정할지"가 다르기 때문이다 (커맨드: 특정 유저 1명 또는 DB 전체, 스크립트: 최근
   N일 활동 유저).

2. **커맨드 전용 래퍼** (관리자 인증 + 대상 결정 + 유효성 검사까지 포함):
   - `previewMinigamePlayGrant(params)` — 미리보기용. 관리자 인증
     (`NotAdminError` 재사용) → `count` 유효성 검사(`InvalidPlayGrantCountError`,
     1 이상 정수) → 대상 결정(`targetUserId` 지정 시 그 1명, 아니면 DB의 모든 유저)
     → `buildMinigamePlayGrantPlan(prisma, ...)` 호출.
   - `grantMinigamePlays(params)` — 실제 반영용. 위와 동일한 인증/검증/대상 결정을
     거친 뒤 `prisma.$transaction(tx => applyMinigamePlayGrant(tx, ...))` 호출.
     `targetUserId`가 지정된 경우, `applyTransaction`이 존재하지 않는 유저에게
     실패하지 않도록 트랜잭션 진입 전에 `getOrCreateUser(targetUserId)`를 먼저
     호출한다(`adminGrant.ts`의 기존 패턴과 동일).

### 기존 `grantBlackjackBonus.ts` 스크립트 리팩터

스크립트의 "대상 선정"(`--active-days`로 최근 활동 유저 거르기) 로직은 그대로
스크립트 안에 남긴다. 다만 실제로 `MinigamePlayLog`를 갱신하고 미리보기를 계산하는
부분은 새 코어 함수(`buildMinigamePlayGrantPlan` / `applyMinigamePlayGrant`)를
호출하도록 바꿔서 중복 로직을 제거한다.

부수 효과: 스크립트도 이제 `Transaction` 테이블에 `MINIGAME_PLAY_GRANT` 기록을
남기게 된다 (기존에는 로그 파일에만 남겼음). 오늘 새로 정한 방식과 일관되도록
하는, 의도된 동작 변화다.

## 커맨드 & 버튼 UX

### `/횟수지급` (`src/commands/minigamePlayGrant.ts`, 신규)

```
/횟수지급 게임:<블랙잭> 횟수:<1 이상 정수> [유저:<선택>] [사유:<선택 텍스트>]
```

- `.setDefaultMemberPermissions(PermissionFlagsBits.Administrator)` +
  `NotAdminError` 체크 — `/환급설정`과 동일한 이중 방어(Discord 레벨 권한 +
  서비스 레벨 관리자 ID 체크).
- **`유저` 옵션을 지정한 경우**: 그 유저 1명에게 즉시 반영한다. 확인 버튼 없음
  (요구사항상 "전체" 대상일 때만 confirm 필요).
- **`유저` 옵션을 생략한 경우("전체")**: 먼저 미리보기(대상 인원수 + 게임/횟수/사유)를
  에페메럴 메시지로 보여주고, "확인"/"취소" 버튼(`/정산취소`와 동일한
  Danger/Secondary 스타일)을 누른 뒤에만 실제로 반영된다.

### Pending 상태 저장 — `src/events/minigamePlayGrantState.ts` (신규)

"전체" 지급의 `사유`는 자유 텍스트라 버튼 `customId`(100자 제한)에 안전하게 넣을 수
없다. RPS의 `pendingRpsChallenges`(서버 메모리 Map, key는 `crypto.randomUUID()`)와
동일한 패턴을 재사용한다:

```ts
interface PendingPlayGrant {
  game: MinigameChoice;
  count: number;
  reason?: string;
  requestedBy: string;
}
const pendingPlayGrants = new Map<string, PendingPlayGrant>();
```

`customId`에는 `playgrant:confirm:<uuid>` / `playgrant:cancel:<uuid>`처럼
무작위 id만 넣는다. 봇이 재시작되면 pending 상태가 사라지는 것은 다른 in-memory
상태(블랙잭/RPS)와 동일하게 감수한다 — 별도 만료 타이머는 두지 않는다
(`/정산취소`도 타이머 없이 단순 confirm/cancel만 지원하는 것과 동일).

### 버튼 핸들러 — `src/events/minigamePlayGrantButton.ts` (신규)

- 취소 버튼: pending 제거 후 "취소했습니다" 메시지로 갱신.
- 확인 버튼: pending을 꺼내 쓰고(`consume`, 중복 클릭 방지를 위해 즉시 삭제),
  **이 시점에 "전체 유저" 목록을 다시 조회**해서 반영한다(미리보기 시점의 스냅샷이
  아니라 최신 목록 기준) — `/정산취소`의 confirm 핸들러가 DB를 재조회하는 것과
  같은 이유(미리보기와 확인 사이에 상태가 바뀔 수 있음).
- pending이 없으면(만료/중복 클릭) "만료되었거나 이미 처리된 요청입니다."로 응답.

### 등록

- `src/commands/index.ts`에 `minigamePlayGrant` 추가.
- `src/events/interactionCreate.ts`에 `isPlayGrantButton` / `handlePlayGrantButton`
  분기 추가 (기존 `settlementcancel:` 분기와 동일한 위치/스타일).

## 에러 처리

| 에러 | 사용자 메시지 |
|---|---|
| `NotAdminError` | 관리자만 사용할 수 있습니다. |
| `InvalidPlayGrantCountError` (횟수가 1 미만이거나 정수가 아님) | 횟수는 1 이상의 정수여야 합니다. |
| confirm 버튼인데 pending 없음 (만료/중복 클릭) | 만료되었거나 이미 처리된 요청입니다. 명령어를 다시 실행해주세요. |

## 테스트 계획 (TDD)

`tests/services/minigamePlayGrant.test.ts` — 기존 `settlementCancellation.test.ts` /
`pointHistory.test.ts` 스타일(describe로 권한/유효성/단일유저/전체유저 그룹,
`expect(...).rejects.toThrow(ErrorClass)`)을 따른다.

- 관리자가 아니면 preview/apply 둘 다 거부
- `count`가 0, 음수, 정수가 아니면 거부
- 오늘 기록이 없던 유저(`MinigamePlayLog` row 없음) → `count: -N`으로 신규 생성,
  before/after가 `maxPlaysPerDay` 기준으로 정확한지
- 오늘 이미 몇 판 플레이한 유저 → `count`가 정확히 `decrement`되는지
- 여러 유저 대상(`targetUserIds` 배열)일 때 각 유저에게 개별 `Transaction`
  (`type: MINIGAME_PLAY_GRANT`, `amount: 0`, `balanceAfter`가 기존 잔액과 동일)이
  기록되는지
- `buildMinigamePlayGrantPlan`(preview)은 DB를 변경하지 않고, `applyMinigamePlayGrant`
  만 실제로 반영하는지
- `reason`이 있을 때/없을 때 `description` 텍스트 차이

커맨드(`minigamePlayGrant.ts`)와 버튼 핸들러(`minigamePlayGrantButton.ts`) 자체는
기존 관례상(`settlementCancel`에 커맨드/버튼 레벨 테스트가 없는 것과 동일) 별도
테스트를 만들지 않는다 — Discord.js interaction 객체는 mocking하지 않는다.
`rpsButton.test.ts`처럼 순수 로직만 분리되어 있다면(예: pending Map의
register/consume) 그 부분만 필요시 테스트한다.

## 기존 스크립트와의 관계 요약

| | `grantBlackjackBonus.ts` (기존 1회성 스크립트) | `/횟수지급` (신규 상시 커맨드) |
|---|---|---|
| 대상 선정 | `--active-days N` (최근 활동), 또는 전체 | 특정 유저 1명, 또는 전체 |
| 실행 방식 | CLI (`railway ssh`로 실행) | 디스코드 슬래시 커맨드 |
| 확인 절차 | dry-run 콘솔 출력 → `--confirm` | 전체 대상일 때만 버튼 confirm |
| 실제 반영 로직 | `applyMinigamePlayGrant` 재사용 (신규) | `applyMinigamePlayGrant` 재사용 |
| 게임 범위 | 블랙잭 고정 | `MINIGAME_REGISTRY`로 확장 가능 |
