# /횟수지급 미니게임 플레이 횟수 지급 커맨드 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 관리자가 `/횟수지급` 슬래시 커맨드 하나로 미니게임(현재는 블랙잭)의 "오늘 잔여 플레이 횟수"를 특정 유저 또는 전체 유저에게 지급할 수 있게 한다.

**Architecture:** `MinigamePlayLog`(오늘 플레이 횟수)와 `Transaction`(감사 이력, `applyTransaction` 경유)만 재사용하고 새 테이블은 만들지 않는다. "대상이 누구인지 결정하는 로직"과 "실제로 반영하는 로직"을 분리한 코어 함수(`buildMinigamePlayGrantPlan`/`applyMinigamePlayGrant`) 위에, 커맨드 전용 인증+대상결정 래퍼(`previewMinigamePlayGrant`/`grantMinigamePlays`)를 얹는다. 기존 1회성 스크립트 `grantBlackjackBonus.ts`도 이 코어 함수를 재사용하도록 리팩터한다. "전체 유저" 지급은 버튼 확인(confirm) 절차를 거치고, 확인 버튼을 누르기 전까지 필요한 상태(사유 등)는 RPS 도전과 동일한 서버 메모리 Map에 잠깐 보관한다.

**Tech Stack:** TypeScript, discord.js v14, Prisma (SQLite), Vitest.

## Global Constraints

- SQLite 프로젝트라 `TransactionType` enum에 값을 추가해도 마이그레이션 파일은 필요 없다 — `prisma/schema.prisma` 수정 후 `npx prisma generate`만 실행하면 된다.
- 관리자 인증은 기존 `src/services/adminGrant.ts`의 `NotAdminError`를 재사용한다 (새 에러 클래스를 만들지 않는다).
- "게임" 선택지는 **블랙잭만** 지원한다 (RPS는 일부러 일일 제한이 없고, 복권은 다른 모델이라 이번 범위 밖). 대신 `MINIGAME_REGISTRY`로 향후 확장 가능한 구조로 만든다.
- 대상 유저를 지정하면 즉시 반영(확인 버튼 없음), 지정하지 않으면 "전체 유저" 대상이며 반드시 버튼 확인을 거쳐야 반영된다.
- `횟수`는 1 이상의 정수만 허용한다 (Discord 옵션 레벨 `setMinValue(1)` + 서비스 레벨 `InvalidPlayGrantCountError` 이중 검증).
- 지급 내역은 `Transaction` 테이블에 `type: MINIGAME_PLAY_GRANT`, `amount: 0`(포인트 잔액 불변)으로 기록하고, 몇 회·왜 지급했는지는 `description`에 텍스트로 남긴다. → 별도 수정 없이 기존 `/포인트내역`으로 조회 가능해야 한다.
- 커맨드/버튼 핸들러 파일 자체는 이 프로젝트 관례상(`settlementCancel`/`settlementCancelButton`도 동일) 별도 테스트를 작성하지 않는다 — Discord.js interaction 객체는 mocking하지 않는다. 서비스 계층(`minigamePlayGrant.ts`)은 TDD로 철저히 테스트한다.

---

### Task 1: `TransactionType.MINIGAME_PLAY_GRANT` 추가 + 라벨 매핑

**Files:**
- Modify: `prisma/schema.prisma`
- Modify: `src/discord/transactionView.ts`
- Test: `tests/discord/transactionView.test.ts`

**Interfaces:**
- Produces: `TransactionType.MINIGAME_PLAY_GRANT` (Prisma Client에서 사용 가능한 enum 멤버) — Task 2 이후 모든 태스크가 이 값을 `import { TransactionType } from '@prisma/client'`로 가져와 쓴다.
- Produces: `TRANSACTION_TYPE_LABELS.MINIGAME_PLAY_GRANT === '미니게임 횟수 지급'` — `/포인트내역`이 자동으로 이 라벨을 쓴다.

- [ ] **Step 1: 실패하는 테스트를 먼저 작성한다**

`tests/discord/transactionView.test.ts` 맨 아래 `describe('formatTransactionLineWithUser', ...)` 블록 뒤에 새 블록을 추가한다:

```ts
describe('MINIGAME_PLAY_GRANT 라벨', () => {
  test('미니게임 횟수 지급 타입은 전용 한글 라벨로 보여준다', () => {
    const line = formatTransactionLine({
      type: 'MINIGAME_PLAY_GRANT',
      amount: 0,
      balanceAfter: 10_000_000,
      description: '블랙잭 잔여 횟수 +2 지급 (오픈 기념 이벤트)',
      createdAt: new Date('2026-07-06T03:00:00.000Z'),
    });

    expect(line).toContain('미니게임 횟수 지급');
    expect(line).toContain('블랙잭 잔여 횟수 +2 지급 (오픈 기념 이벤트)');
  });
});
```

- [ ] **Step 2: 테스트가 실패하는지 확인한다**

Run: `npx vitest run tests/discord/transactionView.test.ts`
Expected: FAIL — `expect(line).toContain('미니게임 횟수 지급')`에서 실패 (현재는 라벨이 없어서 원본 타입 문자열 `MINIGAME_PLAY_GRANT`가 그대로 라벨 자리에 들어간다).

- [ ] **Step 3: `prisma/schema.prisma`의 `TransactionType` enum에 값 추가**

`RPS_VOID` 다음 줄에 추가한다 (현재 enum은 `RPS_VOID`로 끝난다):

```prisma
enum TransactionType {
  INITIAL
  ATTENDANCE
  BET
  TRANSFER
  LOAN
  TAX
  REBATE
  GAMBLE_WIN
  GAMBLE_LOSE
  ADMIN_GRANT
  GAMBLE_ROLLBACK
  ADMIN_RESET
  GAMBLE_EXTRA_PURCHASE
  LOTTERY_PURCHASE
  LOTTERY_WIN
  LOTTERY_TAX
  SETTLEMENT_CORRECTION
  BLACKJACK_BET
  BLACKJACK_WIN
  BLACKJACK_LOSE
  BLACKJACK_PUSH
  RPS_BET
  RPS_WIN
  RPS_LOSE
  RPS_VOID
  MINIGAME_PLAY_GRANT
}
```

- [ ] **Step 4: Prisma Client 재생성**

Run: `npx prisma generate`
Expected: `✔ Generated Prisma Client ...` 출력, 에러 없음.

- [ ] **Step 5: `src/discord/transactionView.ts`의 `TRANSACTION_TYPE_LABELS`에 라벨 추가**

`RPS_VOID: '가위바위보 무효',` 다음 줄에 추가:

```ts
export const TRANSACTION_TYPE_LABELS: Record<string, string> = {
  INITIAL: '시작 지급',
  ATTENDANCE: '출석',
  BET: '베팅',
  TRANSFER: '양도',
  LOAN: '대출',
  TAX: '세금',
  REBATE: '환급',
  GAMBLE_WIN: '도박 승리',
  GAMBLE_LOSE: '도박 패배',
  ADMIN_GRANT: '관리자 지급',
  GAMBLE_ROLLBACK: '도박 롤백',
  ADMIN_RESET: '관리자 초기화',
  GAMBLE_EXTRA_PURCHASE: '도박 추가횟수 구매',
  LOTTERY_PURCHASE: '복권 구매',
  LOTTERY_WIN: '복권 당첨',
  LOTTERY_TAX: '복권 세금',
  SETTLEMENT_CORRECTION: '정산 정정',
  BLACKJACK_BET: '블랙잭 베팅',
  BLACKJACK_WIN: '블랙잭 승리',
  BLACKJACK_LOSE: '블랙잭 패배',
  BLACKJACK_PUSH: '블랙잭 무승부',
  RPS_BET: '가위바위보 베팅',
  RPS_WIN: '가위바위보 승리',
  RPS_LOSE: '가위바위보 패배',
  RPS_VOID: '가위바위보 무효',
  MINIGAME_PLAY_GRANT: '미니게임 횟수 지급',
};
```

- [ ] **Step 6: 테스트가 통과하는지 확인한다**

Run: `npx vitest run tests/discord/transactionView.test.ts`
Expected: PASS (전체 테스트).

- [ ] **Step 7: 커밋**

```bash
git add prisma/schema.prisma src/discord/transactionView.ts tests/discord/transactionView.test.ts
git commit -m "Add MINIGAME_PLAY_GRANT transaction type and label"
```

---

### Task 2: 코어 서비스 — `src/services/minigamePlayGrant.ts`

**Files:**
- Create: `src/services/minigamePlayGrant.ts`
- Test: `tests/services/minigamePlayGrant.test.ts`

**Interfaces:**
- Consumes: `BLACKJACK_GAME_TYPE`, `MAX_PLAYS_PER_DAY` (`src/services/blackjackGame.ts`), `kstMidnightUtc` (`src/services/kst.ts`), `applyTransaction`, `getOrCreateUser` (`src/services/ledger.ts`), `NotAdminError` (`src/services/adminGrant.ts`), `TransactionType.MINIGAME_PLAY_GRANT` (Task 1).
- Produces:
  - `MINIGAME_REGISTRY: { BLACKJACK: { label: string; gameType: string; maxPlaysPerDay: number } }`
  - `type MinigameChoice = keyof typeof MINIGAME_REGISTRY`
  - `class InvalidPlayGrantCountError extends Error`
  - `interface MinigamePlayGrantPlanItem { userId: string; playsRemainingBefore: number; playsRemainingAfter: number }`
  - `interface MinigamePlayGrantPlan { targetUserIds: string[]; plan: MinigamePlayGrantPlanItem[] }`
  - `buildMinigamePlayGrantPlan(db, { game, targetUserIds, count, now? }): Promise<MinigamePlayGrantPlan>` — 읽기 전용.
  - `applyMinigamePlayGrant(tx, { game, targetUserIds, count, reason?, now? }): Promise<MinigamePlayGrantPlan>` — 실제 반영, 호출자가 이미 연 `Prisma.TransactionClient`를 받는다.
  - `previewMinigamePlayGrant({ game, targetUserId?, count, requestedBy, adminDiscordId, now? }): Promise<MinigamePlayGrantPlan>` — 인증+대상결정 포함, 읽기 전용.
  - `grantMinigamePlays({ game, targetUserId?, count, reason?, requestedBy, adminDiscordId, now? }): Promise<MinigamePlayGrantPlan>` — 인증+대상결정+실제 반영.
  - Task 3(스크립트), Task 5(커맨드), Task 6(버튼)이 이 함수들을 그대로 가져다 쓴다.

- [ ] **Step 1: 실패하는 테스트를 먼저 작성한다**

Create `tests/services/minigamePlayGrant.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import { prisma } from '../../src/db/client';
import { NotAdminError } from '../../src/services/adminGrant';
import { BLACKJACK_GAME_TYPE, MAX_PLAYS_PER_DAY } from '../../src/services/blackjackGame';
import { kstMidnightUtc } from '../../src/services/kst';
import { getOrCreateUser, STARTING_BALANCE } from '../../src/services/ledger';
import {
  buildMinigamePlayGrantPlan,
  grantMinigamePlays,
  InvalidPlayGrantCountError,
  previewMinigamePlayGrant,
} from '../../src/services/minigamePlayGrant';

const ADMIN_ID = 'admin-1';
const NOW = new Date('2026-07-06T02:00:00.000Z'); // KST 오전 11시
const PLAY_DATE = kstMidnightUtc(NOW);

describe('previewMinigamePlayGrant / grantMinigamePlays - 권한 및 유효성', () => {
  test('관리자가 아니면 preview/grant 둘 다 거부한다', async () => {
    await expect(
      previewMinigamePlayGrant({
        game: 'BLACKJACK',
        count: 2,
        requestedBy: 'not-admin',
        adminDiscordId: ADMIN_ID,
      })
    ).rejects.toThrow(NotAdminError);

    await expect(
      grantMinigamePlays({
        game: 'BLACKJACK',
        count: 2,
        requestedBy: 'not-admin',
        adminDiscordId: ADMIN_ID,
      })
    ).rejects.toThrow(NotAdminError);
  });

  test('횟수가 0이면 거부한다', async () => {
    await expect(
      grantMinigamePlays({ game: 'BLACKJACK', count: 0, requestedBy: ADMIN_ID, adminDiscordId: ADMIN_ID })
    ).rejects.toThrow(InvalidPlayGrantCountError);
  });

  test('횟수가 음수면 거부한다', async () => {
    await expect(
      grantMinigamePlays({ game: 'BLACKJACK', count: -1, requestedBy: ADMIN_ID, adminDiscordId: ADMIN_ID })
    ).rejects.toThrow(InvalidPlayGrantCountError);
  });

  test('횟수가 정수가 아니면 거부한다', async () => {
    await expect(
      grantMinigamePlays({ game: 'BLACKJACK', count: 1.5, requestedBy: ADMIN_ID, adminDiscordId: ADMIN_ID })
    ).rejects.toThrow(InvalidPlayGrantCountError);
  });
});

describe('grantMinigamePlays - 단일 유저 대상', () => {
  test('오늘 기록이 없던 유저는 count가 음수로 새로 생성되고 잔여 횟수가 +N 된다', async () => {
    await getOrCreateUser('grant-single-1');

    const result = await grantMinigamePlays({
      game: 'BLACKJACK',
      targetUserId: 'grant-single-1',
      count: 2,
      reason: '테스트 지급',
      requestedBy: ADMIN_ID,
      adminDiscordId: ADMIN_ID,
      now: NOW,
    });

    expect(result.targetUserIds).toEqual(['grant-single-1']);
    expect(result.plan).toEqual([
      {
        userId: 'grant-single-1',
        playsRemainingBefore: MAX_PLAYS_PER_DAY,
        playsRemainingAfter: MAX_PLAYS_PER_DAY + 2,
      },
    ]);

    const log = await prisma.minigamePlayLog.findUniqueOrThrow({
      where: {
        userId_gameType_playDate: {
          userId: 'grant-single-1',
          gameType: BLACKJACK_GAME_TYPE,
          playDate: PLAY_DATE,
        },
      },
    });
    expect(log.count).toBe(-2);
  });

  test('오늘 이미 몇 판 플레이한 유저는 count가 그만큼 줄어든다', async () => {
    await getOrCreateUser('grant-single-2');
    await prisma.minigamePlayLog.create({
      data: { userId: 'grant-single-2', gameType: BLACKJACK_GAME_TYPE, playDate: PLAY_DATE, count: 3 },
    });

    const result = await grantMinigamePlays({
      game: 'BLACKJACK',
      targetUserId: 'grant-single-2',
      count: 2,
      requestedBy: ADMIN_ID,
      adminDiscordId: ADMIN_ID,
      now: NOW,
    });

    expect(result.plan).toEqual([
      {
        userId: 'grant-single-2',
        playsRemainingBefore: MAX_PLAYS_PER_DAY - 3,
        playsRemainingAfter: MAX_PLAYS_PER_DAY - 1,
      },
    ]);

    const log = await prisma.minigamePlayLog.findUniqueOrThrow({
      where: {
        userId_gameType_playDate: {
          userId: 'grant-single-2',
          gameType: BLACKJACK_GAME_TYPE,
          playDate: PLAY_DATE,
        },
      },
    });
    expect(log.count).toBe(1);
  });

  test('아직 User row가 없는 유저를 지정해도 자동 생성 후 지급된다', async () => {
    const result = await grantMinigamePlays({
      game: 'BLACKJACK',
      targetUserId: 'grant-single-brand-new',
      count: 1,
      requestedBy: ADMIN_ID,
      adminDiscordId: ADMIN_ID,
      now: NOW,
    });

    expect(result.targetUserIds).toEqual(['grant-single-brand-new']);
    const user = await prisma.user.findUniqueOrThrow({ where: { discordId: 'grant-single-brand-new' } });
    expect(user.balance).toBe(STARTING_BALANCE);
  });

  test('Transaction에 amount 0으로 기록되고 사유가 description에 남는다', async () => {
    await getOrCreateUser('grant-single-3');

    await grantMinigamePlays({
      game: 'BLACKJACK',
      targetUserId: 'grant-single-3',
      count: 2,
      reason: '오픈 기념 이벤트',
      requestedBy: ADMIN_ID,
      adminDiscordId: ADMIN_ID,
      now: NOW,
    });

    const txs = await prisma.transaction.findMany({
      where: { userId: 'grant-single-3', type: 'MINIGAME_PLAY_GRANT' },
    });
    expect(txs).toHaveLength(1);
    expect(txs[0].amount).toBe(0);
    expect(txs[0].balanceAfter).toBe(STARTING_BALANCE);
    expect(txs[0].description).toBe('블랙잭 잔여 횟수 +2 지급 (오픈 기념 이벤트)');
  });

  test('사유를 생략하면 description에 괄호가 붙지 않는다', async () => {
    await getOrCreateUser('grant-single-4');

    await grantMinigamePlays({
      game: 'BLACKJACK',
      targetUserId: 'grant-single-4',
      count: 1,
      requestedBy: ADMIN_ID,
      adminDiscordId: ADMIN_ID,
      now: NOW,
    });

    const txs = await prisma.transaction.findMany({
      where: { userId: 'grant-single-4', type: 'MINIGAME_PLAY_GRANT' },
    });
    expect(txs[0].description).toBe('블랙잭 잔여 횟수 +1 지급');
  });
});

describe('grantMinigamePlays - 전체 유저 대상', () => {
  test('targetUserId를 생략하면 DB의 모든 유저에게 각각 지급된다', async () => {
    await getOrCreateUser('grant-all-1');
    await getOrCreateUser('grant-all-2');

    const result = await grantMinigamePlays({
      game: 'BLACKJACK',
      count: 2,
      requestedBy: ADMIN_ID,
      adminDiscordId: ADMIN_ID,
      now: NOW,
    });

    expect(result.targetUserIds.slice().sort()).toEqual(['grant-all-1', 'grant-all-2']);

    const logs = await prisma.minigamePlayLog.findMany({
      where: { gameType: BLACKJACK_GAME_TYPE, playDate: PLAY_DATE },
    });
    expect(logs.map((l) => l.count).sort()).toEqual([-2, -2]);
  });
});

describe('previewMinigamePlayGrant - DB를 바꾸지 않는다', () => {
  test('미리보기 호출 후에도 MinigamePlayLog는 그대로다', async () => {
    await getOrCreateUser('grant-preview-1');

    const preview = await previewMinigamePlayGrant({
      game: 'BLACKJACK',
      targetUserId: 'grant-preview-1',
      count: 2,
      requestedBy: ADMIN_ID,
      adminDiscordId: ADMIN_ID,
      now: NOW,
    });

    expect(preview.plan).toEqual([
      {
        userId: 'grant-preview-1',
        playsRemainingBefore: MAX_PLAYS_PER_DAY,
        playsRemainingAfter: MAX_PLAYS_PER_DAY + 2,
      },
    ]);

    const log = await prisma.minigamePlayLog.findUnique({
      where: {
        userId_gameType_playDate: {
          userId: 'grant-preview-1',
          gameType: BLACKJACK_GAME_TYPE,
          playDate: PLAY_DATE,
        },
      },
    });
    expect(log).toBeNull();
  });
});

describe('buildMinigamePlayGrantPlan - 코어 함수 (임의의 targetUserIds 배열)', () => {
  test('스크립트처럼 특정 유저 목록만 골라서 미리보기를 계산할 수 있다', async () => {
    await getOrCreateUser('grant-core-1');
    await getOrCreateUser('grant-core-2');
    await getOrCreateUser('grant-core-3'); // 대상에서 제외될 유저

    const result = await buildMinigamePlayGrantPlan(prisma, {
      game: 'BLACKJACK',
      targetUserIds: ['grant-core-1', 'grant-core-2'],
      count: 3,
      now: NOW,
    });

    expect(result.targetUserIds).toEqual(['grant-core-1', 'grant-core-2']);
    expect(result.plan.map((p) => p.userId)).toEqual(['grant-core-1', 'grant-core-2']);
  });
});
```

- [ ] **Step 2: 테스트가 실패하는지 확인한다**

Run: `npx vitest run tests/services/minigamePlayGrant.test.ts`
Expected: FAIL — `Cannot find module '../../src/services/minigamePlayGrant'` (파일이 아직 없음).

- [ ] **Step 3: 구현한다**

Create `src/services/minigamePlayGrant.ts`:

```ts
// 💡 이 파일은 "미니게임 오늘 잔여 플레이 횟수를 지급한다"는 로직을 담당한다.
// 코어 함수(buildMinigamePlayGrantPlan/applyMinigamePlayGrant)는 "누가 대상인지"를 모른다 -
// targetUserIds 배열을 그대로 받아서 처리만 한다. "대상을 누구로 정할지"(특정 유저 1명?
// 전체 유저? 최근 활동 유저?)는 호출하는 쪽(슬래시 커맨드, 1회성 스크립트)이 결정한다.
// distributionBatch.ts가 대상 결정(getLowerTierUserIds)과 실행(issueCouponsForUsers)을
// 나눠둔 것과 같은 이유다.
import { Prisma, TransactionType } from '@prisma/client';
import { prisma } from '../db/client';
import { NotAdminError } from './adminGrant';
import { BLACKJACK_GAME_TYPE, MAX_PLAYS_PER_DAY } from './blackjackGame';
import { kstMidnightUtc } from './kst';
import { applyTransaction, getOrCreateUser } from './ledger';

type Db = Prisma.TransactionClient | typeof prisma;

// 💡 "게임 이름 -> MinigamePlayLog의 gameType 문자열 / 하루 최대 횟수 / 화면에 보여줄 한글 이름"
// 매핑표. 앞으로 같은 방식(MinigamePlayLog)으로 일일 횟수를 관리하는 게임이 추가되면
// 여기 한 줄만 추가하면 /횟수지급이 그 게임도 바로 지원하게 된다. 지금은 블랙잭만 이 방식을
// 쓴다 (RPS는 일부러 일일 제한이 없고, 복권은 완전히 다른 모델이라 대상 아님).
export const MINIGAME_REGISTRY = {
  BLACKJACK: { label: '블랙잭', gameType: BLACKJACK_GAME_TYPE, maxPlaysPerDay: MAX_PLAYS_PER_DAY },
} as const;

export type MinigameChoice = keyof typeof MINIGAME_REGISTRY;

export class InvalidPlayGrantCountError extends Error {}

// 💡 count가 1 이상의 정수인지 확인한다. Discord 슬래시 커맨드 옵션에도 setMinValue(1)을
// 걸어두지만, 이 서비스 함수를 스크립트나 테스트에서 직접 호출할 수도 있으므로 여기서도 검증한다.
function assertValidCount(count: number): void {
  if (!Number.isInteger(count) || count < 1) {
    throw new InvalidPlayGrantCountError('count must be a positive integer');
  }
}

function assertAdmin(requestedBy: string, adminDiscordId: string | undefined): void {
  if (!adminDiscordId || requestedBy !== adminDiscordId) {
    throw new NotAdminError(requestedBy);
  }
}

// 💡 MinigamePlayLog.count(오늘 플레이한 횟수)로부터 "오늘 남은 횟수"를 계산한다.
function playsRemainingFromCount(maxPlaysPerDay: number, count: number): number {
  return maxPlaysPerDay - count;
}

export interface MinigamePlayGrantPlanItem {
  userId: string;
  playsRemainingBefore: number;
  playsRemainingAfter: number;
}

export interface MinigamePlayGrantPlan {
  targetUserIds: string[];
  plan: MinigamePlayGrantPlanItem[];
}

// 💡 실제로 DB를 바꾸지 않고 "지급하면 어떻게 될지"만 계산하는 읽기 전용 함수.
// db는 prisma 그 자체여도, $transaction 안의 tx여도 상관없이 받는다.
export async function buildMinigamePlayGrantPlan(
  db: Db,
  params: { game: MinigameChoice; targetUserIds: string[]; count: number; now?: Date }
): Promise<MinigamePlayGrantPlan> {
  assertValidCount(params.count);
  const now = params.now ?? new Date();
  const playDate = kstMidnightUtc(now);
  const config = MINIGAME_REGISTRY[params.game];

  const existingLogs = await db.minigamePlayLog.findMany({
    where: { userId: { in: params.targetUserIds }, gameType: config.gameType, playDate },
  });
  const countByUserId = new Map(existingLogs.map((log) => [log.userId, log.count]));

  const plan: MinigamePlayGrantPlanItem[] = params.targetUserIds.map((userId) => {
    const countBefore = countByUserId.get(userId) ?? 0;
    return {
      userId,
      playsRemainingBefore: playsRemainingFromCount(config.maxPlaysPerDay, countBefore),
      // 💡 "잔여 횟수 +N"은 곧 "오늘 플레이 횟수(count) -N"과 같다 (count가 낮을수록 남은 횟수가 많아짐).
      playsRemainingAfter: playsRemainingFromCount(config.maxPlaysPerDay, countBefore - params.count),
    };
  });

  return { targetUserIds: params.targetUserIds, plan };
}

// 💡 실제로 DB에 반영하는 함수. 반드시 prisma.$transaction 안에서 받은 tx로 호출해야 한다 -
// 이 함수 스스로는 트랜잭션을 열지 않는다(호출하는 쪽이 트랜잭션 범위를 결정한다).
export async function applyMinigamePlayGrant(
  tx: Prisma.TransactionClient,
  params: { game: MinigameChoice; targetUserIds: string[]; count: number; reason?: string; now?: Date }
): Promise<MinigamePlayGrantPlan> {
  assertValidCount(params.count);
  const now = params.now ?? new Date();
  const playDate = kstMidnightUtc(now);
  const config = MINIGAME_REGISTRY[params.game];

  const { plan } = await buildMinigamePlayGrantPlan(tx, {
    game: params.game,
    targetUserIds: params.targetUserIds,
    count: params.count,
    now,
  });

  const description = `${config.label} 잔여 횟수 +${params.count} 지급${params.reason ? ` (${params.reason})` : ''}`;

  for (const userId of params.targetUserIds) {
    // 💡 오늘 기록이 아예 없던 유저는 count: -N으로 새로 만든다.
    // (예: -2로 시작하면 나중에 실제로 2번 플레이해도 count는 0이 되어 기본 회수를 꽉 채워 쓸 수 있다.)
    await tx.minigamePlayLog.upsert({
      where: { userId_gameType_playDate: { userId, gameType: config.gameType, playDate } },
      create: { userId, gameType: config.gameType, playDate, count: -params.count },
      update: { count: { decrement: params.count } },
    });

    // 💡 포인트 잔액은 안 바뀌지만(amount: 0), 몇 회를 왜 지급했는지는 Transaction에 남겨서
    // 나중에 /포인트내역으로 조회할 수 있게 한다.
    await applyTransaction(tx, {
      discordId: userId,
      type: TransactionType.MINIGAME_PLAY_GRANT,
      amount: 0,
      description,
      occurredAt: now,
    });
  }

  return { targetUserIds: params.targetUserIds, plan };
}

// 💡 targetUserId를 지정하면 그 유저 1명, 안 하면 DB에 있는 모든 유저를 대상으로 삼는다.
async function resolveTargetUserIds(db: Db, targetUserId: string | undefined): Promise<string[]> {
  if (targetUserId) {
    return [targetUserId];
  }
  const users = await db.user.findMany({ select: { discordId: true } });
  return users.map((u) => u.discordId);
}

export interface MinigamePlayGrantParams {
  game: MinigameChoice;
  targetUserId?: string;
  count: number;
  requestedBy: string;
  adminDiscordId: string | undefined;
  now?: Date;
}

// 💡 슬래시 커맨드가 "전체 대상" 확인 버튼을 보여주기 전에 쓰는 함수.
// 관리자 인증 -> 대상 결정 -> 미리보기 계산까지 한 번에 처리한다. DB는 바꾸지 않는다.
export async function previewMinigamePlayGrant(
  params: MinigamePlayGrantParams
): Promise<MinigamePlayGrantPlan> {
  assertAdmin(params.requestedBy, params.adminDiscordId);
  assertValidCount(params.count);

  const targetUserIds = await resolveTargetUserIds(prisma, params.targetUserId);
  return buildMinigamePlayGrantPlan(prisma, {
    game: params.game,
    targetUserIds,
    count: params.count,
    now: params.now,
  });
}

export interface GrantMinigamePlaysParams extends MinigamePlayGrantParams {
  reason?: string;
}

// 💡 실제로 지급하는 함수. 유저 1명이 지정됐는데 아직 User row가 없을 수 있으므로
// (adminGrant.ts의 grantPoints와 동일한 패턴으로) 트랜잭션 진입 전에 먼저 만들어둔다.
export async function grantMinigamePlays(
  params: GrantMinigamePlaysParams
): Promise<MinigamePlayGrantPlan> {
  assertAdmin(params.requestedBy, params.adminDiscordId);
  assertValidCount(params.count);

  if (params.targetUserId) {
    await getOrCreateUser(params.targetUserId);
  }

  const now = params.now ?? new Date();

  return prisma.$transaction(async (tx) => {
    const targetUserIds = await resolveTargetUserIds(tx, params.targetUserId);
    return applyMinigamePlayGrant(tx, {
      game: params.game,
      targetUserIds,
      count: params.count,
      reason: params.reason,
      now,
    });
  });
}
```

- [ ] **Step 4: 테스트가 통과하는지 확인한다**

Run: `npx vitest run tests/services/minigamePlayGrant.test.ts`
Expected: PASS (전체 12개 테스트).

- [ ] **Step 5: 타입체크**

Run: `npx tsc --noEmit`
Expected: 에러 없음.

- [ ] **Step 6: 커밋**

```bash
git add src/services/minigamePlayGrant.ts tests/services/minigamePlayGrant.test.ts
git commit -m "Add minigamePlayGrant service (preview/apply, blackjack-only registry)"
```

---

### Task 3: `grantBlackjackBonus.ts` 스크립트가 코어 함수를 재사용하도록 리팩터

**Files:**
- Modify: `src/scripts/grantBlackjackBonus.ts`

**Interfaces:**
- Consumes: `buildMinigamePlayGrantPlan`, `applyMinigamePlayGrant`, `type MinigamePlayGrantPlanItem` (Task 2, `src/services/minigamePlayGrant.ts`).
- Produces: 기존과 동일한 `grantBlackjackBonus(options)` 시그니처 및 `GrantBlackjackBonusResult` 모양 (외부 동작 불변 — CLI 사용법도 그대로).

- [ ] **Step 1: 전체 파일을 교체한다**

`src/scripts/grantBlackjackBonus.ts`의 전체 내용을 다음으로 교체한다 (CLI 옵션 파싱, 로그 파일 작성, `getTargetUserIds`의 `--active-days` 로직은 그대로 두고, 미리보기/반영 부분만 새 서비스 함수 호출로 바꾼다):

```ts
// 💡 "오픈 기념 이벤트" - 전체(혹은 최근 활동) 유저에게 블랙잭 "오늘 하루 잔여 플레이 횟수"를
// +2씩 한 번만 지급하는 1회성 스크립트다. 상시 슬래시 커맨드가 아니라 관리자가 터미널에서
// 딱 한 번 실행하고 끝내는 용도라서 src/commands/index.ts에는 등록하지 않는다.
//
// 실제 "MinigamePlayLog 갱신 + Transaction 기록" 로직은 src/services/minigamePlayGrant.ts의
// 코어 함수를 그대로 재사용한다 - /횟수지급 슬래시 커맨드와 로직이 중복되지 않게 하기 위함이다.
// 이 스크립트만의 역할은 "--active-days로 대상을 고르는 것"과 "CLI/로그 파일 출력"뿐이다.
//
// ⚠️ 중요: 이 보너스는 "영구히 +2"가 아니라 "오늘(KST 기준) 하루만 +2"다.
// 블랙잭 플레이 횟수는 MinigamePlayLog에 날짜별로 따로 저장되고 자정(KST)이 지나면
// 새 날짜 row가 만들어지면서 자연스럽게 초기화되기 때문에, 이 보너스도 딱 오늘치에만 적용된다.
//
// 사용법 (프로젝트 루트에서 실행):
//   npx tsx src/scripts/grantBlackjackBonus.ts                          -> DRY RUN, 전체 유저 대상
//   npx tsx src/scripts/grantBlackjackBonus.ts --confirm                -> 실제 지급, 전체 유저 대상
//   npx tsx src/scripts/grantBlackjackBonus.ts --active-days 7          -> DRY RUN, 최근 7일 내 활동 유저만
//   npx tsx src/scripts/grantBlackjackBonus.ts --active-days 7 --confirm -> 실제 지급, 최근 7일 내 활동 유저만

import fs from 'node:fs';
import path from 'node:path';
import type { Prisma } from '@prisma/client';
import { prisma } from '../db/client';
import {
  applyMinigamePlayGrant,
  buildMinigamePlayGrantPlan,
  type MinigamePlayGrantPlanItem,
} from '../services/minigamePlayGrant';

// 💡 distributionBatch.ts와 동일한 패턴: 트랜잭션 안(tx)/밖(prisma) 어느 쪽에서 불려도 되게 타입을 열어둔다.
type Db = Prisma.TransactionClient | typeof prisma;

export const BONUS_PLAYS = 2; // 💡 오늘 잔여 횟수에 몇 번을 얹어줄지 (이번 이벤트 요청: +2)
export const EVENT_REASON = '오픈 기념 이벤트 - 블랙잭 하루 잔여 횟수 +2 일괄 지급';

export type GrantPlanItem = MinigamePlayGrantPlanItem;

export interface GrantBlackjackBonusResult {
  targetScope: string;
  targetUserIds: string[];
  plan: GrantPlanItem[];
}

// 💡 지급 "대상"을 고르는 함수.
// - activeSinceDays를 안 주면: DB에 있는 모든 유저.
// - activeSinceDays를 주면(N): 최근 N일 안에 포인트 거래(Transaction)가 한 번이라도 있었던 유저만.
//   Transaction 테이블은 베팅/미니게임/양도/환급 등 포인트가 움직이는 모든 경로를 이미 다 기록하고
//   있으므로(PROGRESS.md 참고), "최근 활동 여부"를 판단하는 가장 포괄적인 기준으로 재사용한다.
async function getTargetUserIds(
  tx: Db,
  activeSinceDays: number | undefined,
  now: Date
): Promise<{ scope: string; userIds: string[] }> {
  if (activeSinceDays === undefined) {
    const users = await tx.user.findMany({ select: { discordId: true } });
    return { scope: '전체 유저', userIds: users.map((u) => u.discordId) };
  }

  const cutoff = new Date(now.getTime() - activeSinceDays * 24 * 60 * 60 * 1000);
  const recentTransactions = await tx.transaction.findMany({
    where: { createdAt: { gte: cutoff } },
    distinct: ['userId'],
    select: { userId: true },
  });
  return {
    scope: `최근 ${activeSinceDays}일 내 활동 유저`,
    userIds: recentTransactions.map((t) => t.userId),
  };
}

export async function grantBlackjackBonus(options: {
  execute: boolean;
  activeSinceDays?: number;
  now?: Date;
}): Promise<GrantBlackjackBonusResult> {
  const now = options.now ?? new Date();

  // 💡 전체를 하나의 트랜잭션으로 묶어서, 중간에 에러가 나면 일부만 지급되는 일이 없게 한다
  // (기존 emergencyIssueLowerTierCoupons.ts, resetServerBalances.ts와 동일한 패턴).
  return prisma.$transaction(async (tx) => {
    const { scope, userIds: targetUserIds } = await getTargetUserIds(tx, options.activeSinceDays, now);

    if (options.execute) {
      const { plan } = await applyMinigamePlayGrant(tx, {
        game: 'BLACKJACK',
        targetUserIds,
        count: BONUS_PLAYS,
        reason: EVENT_REASON,
        now,
      });
      return { targetScope: scope, targetUserIds, plan };
    }

    const { plan } = await buildMinigamePlayGrantPlan(tx, {
      game: 'BLACKJACK',
      targetUserIds,
      count: BONUS_PLAYS,
      now,
    });
    return { targetScope: scope, targetUserIds, plan };
  });
}

// 💡 실제 지급(--confirm)이 끝난 뒤에만 호출된다. "언제 / 몇 명에게 / 왜" 지급했는지를
// logs/ 폴더에 파일로 남겨서, 나중에 "그때 그 이벤트 언제 돌렸었지?"를 추적할 수 있게 한다.
// (.gitignore에 *.log가 이미 등록되어 있어서 이 로그 파일은 커밋되지 않는다.)
function writeGrantLog(result: GrantBlackjackBonusResult, activeSinceDays: number | undefined): string {
  const logsDir = path.join(__dirname, '..', '..', 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  const executedAt = new Date();
  const fileTimestamp = executedAt.toISOString().replace(/[:.]/g, '-');
  const logPath = path.join(logsDir, `grantBlackjackBonus-${fileTimestamp}.log`);

  const logBody = {
    executedAt: executedAt.toISOString(),
    reason: EVENT_REASON,
    bonusPlays: BONUS_PLAYS,
    targetScope: result.targetScope,
    targetUserCount: result.targetUserIds.length,
    plan: result.plan,
  };

  fs.writeFileSync(logPath, JSON.stringify(logBody, null, 2), 'utf-8');
  return logPath;
}

async function main() {
  const args = process.argv.slice(2);
  const execute = args.includes('--confirm');

  const activeDaysFlagIndex = args.indexOf('--active-days');
  let activeSinceDays: number | undefined;
  if (activeDaysFlagIndex !== -1) {
    const rawValue = Number(args[activeDaysFlagIndex + 1]);
    if (!Number.isInteger(rawValue) || rawValue <= 0) {
      console.error('--active-days 뒤에는 1 이상의 정수를 입력해주세요. 예: --active-days 7');
      process.exitCode = 1;
      return;
    }
    activeSinceDays = rawValue;
  }

  const result = await grantBlackjackBonus({ execute, activeSinceDays });

  console.log('');
  console.log(execute ? '=== 블랙잭 오픈 기념 보너스 지급 결과 ===' : '=== DRY RUN 결과 (DB에 쓰지 않음) ===');
  console.log(`대상 범위: ${result.targetScope}`);
  console.log(`지급 내용: 블랙잭 오늘(KST) 잔여 횟수 +${BONUS_PLAYS}`);
  console.log(`대상 유저 수: ${result.targetUserIds.length}명`);
  console.log('');
  for (const item of result.plan) {
    console.log(`  ${item.userId}: ${item.playsRemainingBefore} -> ${item.playsRemainingAfter}`);
  }

  if (execute) {
    const logPath = writeGrantLog(result, activeSinceDays);
    console.log('');
    console.log(`실행 로그 저장 완료: ${logPath}`);
  } else {
    console.log('');
    console.log('DRY RUN입니다. 실제로 지급하려면 뒤에 --confirm 플래그를 추가해서 다시 실행하세요.');
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

- [ ] **Step 2: 타입체크**

Run: `npx tsc --noEmit`
Expected: 에러 없음.

- [ ] **Step 3: 전체 테스트 스위트로 회귀 확인**

Run: `npx vitest run`
Expected: 기존 테스트 전부 PASS (이 스크립트는 별도 테스트 파일이 없으므로, 회귀가 없는지는 전체 스위트로 확인한다).

- [ ] **Step 4: 로컬 dev.db로 dry-run 스모크 테스트**

Run: `npx tsx src/scripts/grantBlackjackBonus.ts`
Expected: 리팩터 전과 동일한 형식의 출력(`=== DRY RUN 결과 ===`, 대상 범위, 대상 유저 수, 유저별 `before -> after` 목록)이 에러 없이 나온다. `--confirm`은 실행하지 않는다 (로컬 dev.db를 건드리지 않기 위함).

- [ ] **Step 5: 커밋**

```bash
git add src/scripts/grantBlackjackBonus.ts
git commit -m "Refactor grantBlackjackBonus script to reuse minigamePlayGrant core functions"
```

---

### Task 4: Pending 상태 저장소 — `src/events/minigamePlayGrantState.ts`

**Files:**
- Create: `src/events/minigamePlayGrantState.ts`

**Interfaces:**
- Consumes: `type MinigameChoice` (Task 2, `src/services/minigamePlayGrant.ts`).
- Produces: `interface PendingPlayGrant { game: MinigameChoice; count: number; reason?: string; requestedBy: string }`, `export const pendingPlayGrants: Map<string, PendingPlayGrant>` — Task 5(커맨드)와 Task 6(버튼)이 이 Map을 직접 `.set()`/`.get()`/`.delete()`한다 (기존 `src/events/rpsState.ts`의 `pendingRpsChallenges`와 동일한 스타일 — 별도 register/consume 헬퍼 함수를 만들지 않는다).

이 파일은 순수 타입+Map 선언이라 별도 유닛 테스트를 만들지 않는다 (`rpsState.ts`도 테스트 파일이 없다). 검증은 Task 6에서 버튼 핸들러가 이 Map을 정상적으로 쓰는지로 갈음한다.

- [ ] **Step 1: 파일을 작성한다**

Create `src/events/minigamePlayGrantState.ts`:

```ts
// 💡 "/횟수지급"을 전체 유저 대상으로 실행하면, 확인 버튼을 누르기 전까지 게임/횟수/사유를
// 잠깐 기억해둬야 한다. 버튼 customId는 100자 제한이 있어서 사유 같은 자유 텍스트를 못 넣으므로,
// RPS의 pendingRpsChallenges(src/events/rpsState.ts)와 완전히 동일한 방식으로 서버 메모리
// Map에 저장하고 customId에는 무작위 id만 싣는다. 봇이 재시작되면 사라지는 것도 감수한다
// (다른 in-memory 상태들과 동일한 트레이드오프).
import type { MinigameChoice } from '../services/minigamePlayGrant';

export interface PendingPlayGrant {
  game: MinigameChoice;
  count: number;
  reason?: string;
  requestedBy: string;
}

// 💡 key = crypto.randomUUID()로 만든, 그 자체로는 아무 정보도 유추할 수 없는 id.
export const pendingPlayGrants = new Map<string, PendingPlayGrant>();
```

- [ ] **Step 2: 타입체크**

Run: `npx tsc --noEmit`
Expected: 에러 없음.

- [ ] **Step 3: 커밋**

```bash
git add src/events/minigamePlayGrantState.ts
git commit -m "Add pending state map for /횟수지급 confirm button"
```

---

### Task 5: 슬래시 커맨드 — `src/commands/minigamePlayGrant.ts`

**Files:**
- Create: `src/commands/minigamePlayGrant.ts`
- Modify: `src/commands/index.ts`

**Interfaces:**
- Consumes: `env` (`src/config/env.ts`), `pendingPlayGrants` (Task 4), `NotAdminError` (`src/services/adminGrant.ts`), `grantMinigamePlays`, `previewMinigamePlayGrant`, `InvalidPlayGrantCountError`, `MINIGAME_REGISTRY`, `type MinigameChoice` (Task 2).
- Produces: `export const data: SlashCommandBuilder` (이름 `횟수지급`), `export async function execute(interaction)` — `src/commands/index.ts`의 `commands` Map에 등록되어 `src/events/interactionCreate.ts`가 커맨드명으로 찾아 호출한다.

- [ ] **Step 1: 커맨드 파일을 작성한다**

Create `src/commands/minigamePlayGrant.ts`:

```ts
// 💡 관리자가 미니게임의 "오늘 잔여 플레이 횟수"를 유저(들)에게 지급하는 상시 커맨드.
// 이벤트가 있을 때마다 1회성 스크립트를 새로 만드는 대신 이 커맨드 하나로 처리한다.
import { randomUUID } from 'node:crypto';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type ChatInputCommandInteraction,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { env } from '../config/env';
import { pendingPlayGrants } from '../events/minigamePlayGrantState';
import { NotAdminError } from '../services/adminGrant';
import {
  grantMinigamePlays,
  InvalidPlayGrantCountError,
  MINIGAME_REGISTRY,
  type MinigameChoice,
  previewMinigamePlayGrant,
} from '../services/minigamePlayGrant';

export const data = new SlashCommandBuilder()
  .setName('횟수지급')
  .setDescription('(관리자 전용) 미니게임 오늘 잔여 플레이 횟수를 지급합니다.')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addStringOption((opt) =>
    opt
      .setName('게임')
      .setDescription('대상 미니게임')
      .setRequired(true)
      .addChoices(
        ...Object.entries(MINIGAME_REGISTRY).map(([value, config]) => ({ name: config.label, value }))
      )
  )
  .addIntegerOption((opt) =>
    opt.setName('횟수').setDescription('지급할 횟수').setRequired(true).setMinValue(1)
  )
  .addUserOption((opt) =>
    opt.setName('유저').setDescription('지정하지 않으면 DB의 전체 유저가 대상입니다')
  )
  .addStringOption((opt) => opt.setName('사유').setDescription('지급 사유 (선택)'));

export async function execute(interaction: ChatInputCommandInteraction) {
  const game = interaction.options.getString('게임', true) as MinigameChoice;
  const count = interaction.options.getInteger('횟수', true);
  const targetUser = interaction.options.getUser('유저');
  const reason = interaction.options.getString('사유') ?? undefined;
  const gameLabel = MINIGAME_REGISTRY[game].label;

  try {
    if (targetUser) {
      // 💡 유저를 지정하면 미리보기/확인 절차 없이 바로 지급한다
      // (요구사항: 확인 버튼은 "전체" 대상일 때만 필요).
      const result = await grantMinigamePlays({
        game,
        targetUserId: targetUser.id,
        count,
        reason,
        requestedBy: interaction.user.id,
        adminDiscordId: env.ADMIN_DISCORD_ID,
      });
      const item = result.plan[0];
      await interaction.reply({
        content: `✅ ${gameLabel} 잔여 횟수를 지급했습니다.\n<@${targetUser.id}>: ${item.playsRemainingBefore} -> ${item.playsRemainingAfter}`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // 💡 유저를 지정하지 않으면 "전체 유저" 대상 - 몇 명에게 적용될지 먼저 보여주고, 확인 버튼을
    // 눌러야 실제로 반영되게 한다.
    const preview = await previewMinigamePlayGrant({
      game,
      count,
      requestedBy: interaction.user.id,
      adminDiscordId: env.ADMIN_DISCORD_ID,
    });

    // 💡 "사유"는 자유 텍스트라 버튼 customId(100자 제한)에 못 넣으므로, 서버 메모리에 잠깐
    // 저장해두고 customId에는 이 요청을 가리키는 무작위 id만 싣는다.
    const pendingId = randomUUID();
    pendingPlayGrants.set(pendingId, { game, count, reason, requestedBy: interaction.user.id });

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`playgrant:confirm:${pendingId}`)
        .setLabel('확인')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(`playgrant:cancel:${pendingId}`)
        .setLabel('취소')
        .setStyle(ButtonStyle.Secondary)
    );

    await interaction.reply({
      content: [
        `⚠️ ${gameLabel} 잔여 횟수를 **전체 유저 ${preview.targetUserIds.length}명**에게 +${count}씩 지급합니다.`,
        reason ? `사유: ${reason}` : null,
        '아래 확인 버튼을 눌러야 실제로 반영됩니다.',
      ]
        .filter((line): line is string => line !== null)
        .join('\n'),
      components: [row],
      flags: MessageFlags.Ephemeral,
    });
  } catch (error) {
    if (error instanceof NotAdminError) {
      await interaction.reply({ content: '관리자만 사용할 수 있습니다.', flags: MessageFlags.Ephemeral });
      return;
    }
    if (error instanceof InvalidPlayGrantCountError) {
      await interaction.reply({
        content: '횟수는 1 이상의 정수여야 합니다.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    throw error;
  }
}
```

- [ ] **Step 2: `src/commands/index.ts`에 등록한다**

`src/commands/index.ts`의 import 목록에 (알파벳 순서를 고려해 `mode2BetSettle` 다음, `pointHistory` 앞에) 추가:

```ts
import * as mode2BetSettle from './mode2BetSettle';
import * as minigamePlayGrant from './minigamePlayGrant';
import * as pointHistory from './pointHistory';
```

`commands` Map에도 (마지막 줄 근처, `pointHistory` 다음) 추가:

```ts
  [couponList.data.name, couponList],
  [pointHistory.data.name, pointHistory],
  [minigamePlayGrant.data.name, minigamePlayGrant],
]);
```

- [ ] **Step 3: 타입체크**

Run: `npx tsc --noEmit`
Expected: 에러 없음.

- [ ] **Step 4: 전체 테스트 스위트 회귀 확인**

Run: `npx vitest run`
Expected: 기존 테스트 전부 PASS.

- [ ] **Step 5: 커밋**

```bash
git add src/commands/minigamePlayGrant.ts src/commands/index.ts
git commit -m "Add /횟수지급 slash command"
```

---

### Task 6: 확인/취소 버튼 핸들러 — `src/events/minigamePlayGrantButton.ts`

**Files:**
- Create: `src/events/minigamePlayGrantButton.ts`
- Modify: `src/events/interactionCreate.ts`

**Interfaces:**
- Consumes: `env`, `NotAdminError`, `grantMinigamePlays`, `InvalidPlayGrantCountError`, `MINIGAME_REGISTRY` (Task 2), `pendingPlayGrants` (Task 4).
- Produces: `export function isPlayGrantButton(customId: string): boolean`, `export async function handlePlayGrantButton(interaction: ButtonInteraction): Promise<void>` — `src/events/interactionCreate.ts`가 버튼 클릭마다 `isPlayGrantButton`으로 분기해 호출한다.

- [ ] **Step 1: 버튼 핸들러 파일을 작성한다**

Create `src/events/minigamePlayGrantButton.ts`:

```ts
// 💡 "/횟수지급"을 전체 유저 대상으로 실행했을 때 뜨는 확인/취소 버튼을 처리한다.
import type { ButtonInteraction } from 'discord.js';
import { env } from '../config/env';
import { NotAdminError } from '../services/adminGrant';
import { grantMinigamePlays, InvalidPlayGrantCountError, MINIGAME_REGISTRY } from '../services/minigamePlayGrant';
import { pendingPlayGrants } from './minigamePlayGrantState';

const CONFIRM_PREFIX = 'playgrant:confirm:';
const CANCEL_PREFIX = 'playgrant:cancel:';

export function isPlayGrantButton(customId: string): boolean {
  return customId.startsWith(CONFIRM_PREFIX) || customId.startsWith(CANCEL_PREFIX);
}

export async function handlePlayGrantButton(interaction: ButtonInteraction): Promise<void> {
  const isConfirm = interaction.customId.startsWith(CONFIRM_PREFIX);
  const pendingId = interaction.customId.slice(isConfirm ? CONFIRM_PREFIX.length : CANCEL_PREFIX.length);

  if (!isConfirm) {
    pendingPlayGrants.delete(pendingId);
    await interaction.update({
      content: '횟수 지급을 취소했습니다. 아무 변경도 이루어지지 않았습니다.',
      components: [],
    });
    return;
  }

  // 💡 확인 버튼은 한 번 쓰면 바로 지운다 - 같은 버튼을 두 번 눌러도 두 번 지급되지 않게 막는
  // 역할도 겸한다.
  const pending = pendingPlayGrants.get(pendingId);
  pendingPlayGrants.delete(pendingId);

  if (!pending) {
    await interaction.update({
      content: '❌ 만료되었거나 이미 처리된 요청입니다. 명령어를 다시 실행해주세요.',
      components: [],
    });
    return;
  }

  try {
    // 💡 미리보기 시점의 유저 목록이 아니라 지금 이 순간 DB에 있는 "전체 유저"를 다시 조회해서
    // 반영한다 (미리보기와 확인 사이에 신규 유저가 생겼을 수도 있으므로) - /정산취소 confirm
    // 핸들러가 DB를 재조회하는 것과 같은 이유다.
    const result = await grantMinigamePlays({
      game: pending.game,
      count: pending.count,
      reason: pending.reason,
      requestedBy: interaction.user.id,
      adminDiscordId: env.ADMIN_DISCORD_ID,
    });

    await interaction.update({
      content: `✅ ${MINIGAME_REGISTRY[pending.game].label} 잔여 횟수 +${pending.count}를 전체 유저 ${result.targetUserIds.length}명에게 지급했습니다.`,
      components: [],
    });
  } catch (error) {
    let message: string | null = null;
    if (error instanceof NotAdminError) {
      message = '관리자만 사용할 수 있습니다.';
    } else if (error instanceof InvalidPlayGrantCountError) {
      message = '횟수는 1 이상의 정수여야 합니다.';
    }

    if (!message) {
      throw error;
    }

    await interaction.update({ content: `❌ ${message}`, components: [] });
  }
}
```

- [ ] **Step 2: `src/events/interactionCreate.ts`에 등록한다**

import 목록에 (`isSettlementCancelButton` 관련 import 다음 줄에) 추가:

```ts
import { handleSettlementCancelButton, isSettlementCancelButton } from './settlementCancelButton';
import { handlePlayGrantButton, isPlayGrantButton } from './minigamePlayGrantButton';
```

`handleInteractionCreate` 함수 안, 기존 `isSettlementCancelButton` 분기(`if (interaction.isButton() && isSettlementCancelButton(...))`) 블록 바로 다음에 새 분기를 추가한다:

```ts
  if (interaction.isButton() && isSettlementCancelButton(interaction.customId)) {
    try {
      await handleSettlementCancelButton(interaction);
    } catch (error) {
      await replyWithGenericError(interaction, '정산취소 버튼 처리 중 오류 발생', error);
    }
    return;
  }

  if (interaction.isButton() && isPlayGrantButton(interaction.customId)) {
    try {
      await handlePlayGrantButton(interaction);
    } catch (error) {
      await replyWithGenericError(interaction, '횟수지급 버튼 처리 중 오류 발생', error);
    }
    return;
  }
```

- [ ] **Step 3: 타입체크**

Run: `npx tsc --noEmit`
Expected: 에러 없음.

- [ ] **Step 4: 전체 테스트 스위트 회귀 확인**

Run: `npx vitest run`
Expected: 기존 테스트 전부 PASS.

- [ ] **Step 5: 커밋**

```bash
git add src/events/minigamePlayGrantButton.ts src/events/interactionCreate.ts
git commit -m "Wire up /횟수지급 confirm/cancel button handler"
```

---

### Task 7: 최종 검증 + 커맨드 배포 안내 + PROGRESS.md 갱신

**Files:**
- Modify: `PROGRESS.md`

**Interfaces:**
- Consumes: 없음 (검증/문서화 태스크).
- Produces: 없음 (다음 세션 인수인계용 문서 갱신).

- [ ] **Step 1: 전체 테스트 + 타입체크 최종 확인**

Run: `npx tsc --noEmit && npx vitest run`
Expected: 타입 에러 없음, 전체 테스트(기존 + 이번에 추가한 `minigamePlayGrant.test.ts` 12개 + `transactionView.test.ts` 갱신분) PASS.

- [ ] **Step 2: `PROGRESS.md` 최상단에 이번 작업 요약을 추가한다**

`PROGRESS.md`의 `## 1. 오늘(2026-07-03) 완료된 작업` 섹션 시작 부분(첫 하위 항목인 `### 미니게임 2종` 바로 앞)에 새 하위 섹션을 추가한다:

```markdown
### 미니게임 횟수 지급 상시 커맨드 (`/횟수지급`)
1회성 스크립트(`grantBlackjackBonus.ts`)로 처리하던 "미니게임 플레이 횟수 지급"을
상시 관리자 커맨드로 승격. 설계 문서: `docs/superpowers/specs/2026-07-03-minigame-play-count-grant-design.md`,
구현 계획: `docs/superpowers/plans/2026-07-03-minigame-play-count-grant.md`.

- **범위**: "오늘 잔여 플레이 횟수"(`MinigamePlayLog` 기반) 개념은 현재 블랙잭에만 존재함을
  확인(RPS는 의도적으로 일일 제한 없음, 복권은 다른 모델). `MINIGAME_REGISTRY`로 향후
  확장 가능한 구조만 만들고, 이번엔 블랙잭만 지원.
- `src/services/minigamePlayGrant.ts` (신규): 코어 함수(`buildMinigamePlayGrantPlan`/
  `applyMinigamePlayGrant`, targetUserIds를 받기만 함)와 커맨드 전용 래퍼
  (`previewMinigamePlayGrant`/`grantMinigamePlays`, 관리자 인증+대상 결정 포함)로 분리.
- `Transaction`에 `MINIGAME_PLAY_GRANT` 타입(amount: 0)으로 기록 → `/포인트내역`에서
  라벨 매핑만 추가하고 그대로 조회 가능.
- `src/commands/minigamePlayGrant.ts` + `src/events/minigamePlayGrantButton.ts` +
  `src/events/minigamePlayGrantState.ts` (신규): 유저 지정 시 즉시 지급, 전체 유저 대상이면
  버튼 확인(confirm) 필요 (`/정산취소`, RPS 도전 패턴 재사용).
- 기존 `src/scripts/grantBlackjackBonus.ts`도 새 코어 함수를 재사용하도록 리팩터 (대상
  선정 로직인 `--active-days`는 그대로 유지).

### ⚠️ 다음 세션에서 확인 필요 (추가)
- [ ] `/횟수지급`은 신규 슬래시 커맨드이므로 `npm run deploy-commands` 실행(디스코드에 실제
      등록) 여부 확인
- [ ] 실제 디스코드에서 `/횟수지급` (유저 지정 / 전체 대상 confirm 버튼) 동작 테스트
```

- [ ] **Step 3: 커밋**

```bash
git add PROGRESS.md
git commit -m "Update PROGRESS.md with /횟수지급 command summary"
```

- [ ] **Step 4: (참고용, 이 플랜 범위 밖) 디스코드에 실제 등록하려면**

이 단계는 실행하지 않고 사용자에게 안내만 한다: 로컬 `.env`에 `DISCORD_TOKEN`/`DISCORD_CLIENT_ID`가 설정되어 있으면 `npm run deploy-commands`로 길드에 슬래시 커맨드를 등록해야 디스코드에서 `/횟수지급`이 실제로 보인다. 프로덕션 반영은 이전 세션과 동일하게 git push → Railway 자동 재배포로 이루어진다 (배포 자체만으로는 슬래시 커맨드가 등록되지 않으므로, 등록은 별도로 `deploy-commands`를 실행해야 함을 사용자에게 알려준다).
