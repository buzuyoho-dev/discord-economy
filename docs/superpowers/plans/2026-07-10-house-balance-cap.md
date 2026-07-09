# 하우스 잔고 상한(House Balance Cap) 시스템 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 하우스 잔고가 전체 경제 규모의 `houseBalanceCapRatio`(기본 40%)를 넘지 않도록, 주간 환급 배치를 "순증가분 × 고정 비율" 방식에서 "캡 초과분 전액 환급" 방식으로 바꾸고, 현재 75%까지 벌어진 격차를 한 번에 메우는 catch-up CLI 스크립트를 추가한다.

**Architecture:** `house.ts`에 이미 있던 "전체 경제 규모" 계산을 `getEconomySnapshot()`으로 추출해 공용화하고, `distributionBatch.ts`의 인라인 분배 로직을 `computeRebateDistribution()` 순수 함수로 추출해 정기 배치와 catch-up 스크립트가 함께 쓴다. `EconomyConfig`에 `houseBalanceCapRatio` 필드를 추가하고, `/환급설정`에서 조정 가능하게 한다. catch-up은 `resetServerBalances.ts`와 동일한 "기본 dry-run, `--execute`로만 실제 지급" CLI 패턴을 따른다.

**Tech Stack:** TypeScript, Prisma(SQLite), Vitest, discord.js.

## Global Constraints

- 모든 잔액 변경은 `ledger.ts`의 `applyTransaction`/`house.ts`의 `applyHouseTransaction`을 거쳐야 한다 (마이너스 잔액 방지 가드 + 감사 로그 자동 기록).
- `rebateRate` 필드는 스키마·DB 값 모두 유지하되 새 계산 로직에서는 읽지 않는다 (제거 금지).
- `House.lastRebateBalance`/`lastRebateAt`은 계산에는 안 쓰되 감사 기록용으로 계속 갱신한다.
- catch-up 스크립트는 기본 실행 시 dry-run(DB 미변경)이어야 하고, `--execute` 플래그를 줘야만 실제로 지급한다.
- catch-up은 베팅2배쿠폰을 발급하지 않는다 (포인트 분배만).
- 참고 스펙: `docs/superpowers/specs/2026-07-10-house-balance-cap-design.md`

---

### Task 1: `EconomyConfig`에 `houseBalanceCapRatio` 추가 + `updateEconomyConfig()` 시그니처 변경

**Files:**
- Modify: `prisma/schema.prisma` (`EconomyConfig` model)
- Modify: `src/services/economyConfig.ts`
- Test: `tests/services/economyConfig.test.ts`
- Modify (호환성 패치): `tests/services/distributionBatch.test.ts:122-127` (updateEconomyConfig 호출부만)

**Interfaces:**
- Produces: `updateEconomyConfig(params: { requestedBy: string; adminDiscordId: string | undefined; lowerTierWeight: number; houseBalanceCapRatio: number }): Promise<EconomyConfig>` — `rebateRate` 파라미터 제거됨. `InvalidEconomyConfigError`를 `houseBalanceCapRatio`가 `(0, 1]` 범위 밖이면 던짐.
- Produces: `EconomyConfig.houseBalanceCapRatio: number` (Prisma 타입, 기본값 0.4)

- [ ] **Step 1: `prisma/schema.prisma`의 `EconomyConfig` 모델에 필드 추가**

`prisma/schema.prisma`에서 다음 부분을 찾는다:

```prisma
model EconomyConfig {
  id              String   @id @default("SINGLETON")
  rebateRate      Float    @default(0.05)
  lowerTierWeight Float    @default(1.5)
  updatedAt       DateTime @updatedAt
}
```

다음으로 교체한다:

```prisma
model EconomyConfig {
  id                   String   @id @default("SINGLETON")
  rebateRate           Float    @default(0.05)
  lowerTierWeight      Float    @default(1.5)
  houseBalanceCapRatio Float    @default(0.4)
  updatedAt            DateTime @updatedAt
}
```

- [ ] **Step 2: 마이그레이션 생성 및 적용**

Run: `npx prisma migrate dev --name add_house_balance_cap_ratio`
Expected: `prisma/migrations/<timestamp>_add_house_balance_cap_ratio/migration.sql` 파일이 생성되고, Prisma Client가 자동으로 재생성됨(`✔ Generated Prisma Client`).

- [ ] **Step 3: 기존 싱글톤 row에 대한 마이그레이션 SQL에 기본값 시딩 확인**

생성된 마이그레이션 파일을 열어 `houseBalanceCapRatio` 컬럼이 `DEFAULT 0.4`로 추가되었는지 확인한다 (SQLite는 컬럼 추가 시 기존 row에도 자동으로 기본값이 채워지므로 별도 `UPDATE` 문은 필요 없다). 별도 수정 불필요 — 확인만.

- [ ] **Step 4: 실패하는 테스트 작성 — `tests/services/economyConfig.test.ts` 전체를 아래 내용으로 교체**

```ts
import { describe, expect, test } from 'vitest';
import { prisma } from '../../src/db/client';
import { NotAdminError } from '../../src/services/adminGrant';
import {
  ECONOMY_CONFIG_ID,
  getOrCreateEconomyConfig,
  InvalidEconomyConfigError,
  updateEconomyConfig,
} from '../../src/services/economyConfig';

const ADMIN_ID = 'admin-1';

describe('getOrCreateEconomyConfig', () => {
  test('row가 없으면 기본값(5%, 1.5배, 캡비율 40%)으로 지연 생성한다', async () => {
    const config = await getOrCreateEconomyConfig();

    expect(config.id).toBe(ECONOMY_CONFIG_ID);
    expect(config.rebateRate).toBe(0.05);
    expect(config.lowerTierWeight).toBe(1.5);
    expect(config.houseBalanceCapRatio).toBe(0.4);
  });

  test('이미 있으면 기존 row를 그대로 반환한다', async () => {
    await prisma.economyConfig.create({
      data: { id: ECONOMY_CONFIG_ID, rebateRate: 0.1, lowerTierWeight: 2, houseBalanceCapRatio: 0.3 },
    });

    const config = await getOrCreateEconomyConfig();

    expect(config.rebateRate).toBe(0.1);
    expect(config.lowerTierWeight).toBe(2);
    expect(config.houseBalanceCapRatio).toBe(0.3);
  });
});

describe('updateEconomyConfig', () => {
  test('관리자가 정상 값으로 갱신한다 (rebateRate는 더 이상 파라미터로 받지 않고 DB 값 그대로 유지)', async () => {
    const updated = await updateEconomyConfig({
      requestedBy: ADMIN_ID,
      adminDiscordId: ADMIN_ID,
      lowerTierWeight: 2,
      houseBalanceCapRatio: 0.3,
    });

    expect(updated.lowerTierWeight).toBe(2);
    expect(updated.houseBalanceCapRatio).toBe(0.3);
    expect(updated.rebateRate).toBe(0.05);
  });

  test('관리자가 아니면 거부한다', async () => {
    await expect(
      updateEconomyConfig({
        requestedBy: 'not-admin',
        adminDiscordId: ADMIN_ID,
        lowerTierWeight: 2,
        houseBalanceCapRatio: 0.3,
      })
    ).rejects.toThrow(NotAdminError);
  });

  test('houseBalanceCapRatio가 0 이하이거나 1 초과면 거부한다', async () => {
    await expect(
      updateEconomyConfig({
        requestedBy: ADMIN_ID,
        adminDiscordId: ADMIN_ID,
        lowerTierWeight: 1.5,
        houseBalanceCapRatio: 0,
      })
    ).rejects.toThrow(InvalidEconomyConfigError);
    await expect(
      updateEconomyConfig({
        requestedBy: ADMIN_ID,
        adminDiscordId: ADMIN_ID,
        lowerTierWeight: 1.5,
        houseBalanceCapRatio: 1.01,
      })
    ).rejects.toThrow(InvalidEconomyConfigError);
  });

  test('lowerTierWeight가 1 미만이면 거부한다 (하위 플레이어가 오히려 덜 받는 걸 방지)', async () => {
    await expect(
      updateEconomyConfig({
        requestedBy: ADMIN_ID,
        adminDiscordId: ADMIN_ID,
        lowerTierWeight: 0.9,
        houseBalanceCapRatio: 0.4,
      })
    ).rejects.toThrow(InvalidEconomyConfigError);
  });

  test('houseBalanceCapRatio=1, lowerTierWeight=1인 경계값은 허용한다', async () => {
    await expect(
      updateEconomyConfig({
        requestedBy: ADMIN_ID,
        adminDiscordId: ADMIN_ID,
        lowerTierWeight: 1,
        houseBalanceCapRatio: 1,
      })
    ).resolves.toBeDefined();
  });
});
```

- [ ] **Step 5: 테스트 실행해서 실패 확인**

Run: `npx vitest run tests/services/economyConfig.test.ts`
Expected: FAIL — `updateEconomyConfig` 관련 테스트들이 `InvalidEconomyConfigError`를 던지거나(기존 구현이 `params.rebateRate`가 `undefined`인 걸 보고 거부) 타입 불일치로 실패함.

- [ ] **Step 6: `src/services/economyConfig.ts`의 `updateEconomyConfig` 구현 교체**

`updateEconomyConfig` 함수 전체를 다음으로 교체한다:

```ts
export async function updateEconomyConfig(params: {
  requestedBy: string;
  adminDiscordId: string | undefined;
  lowerTierWeight: number;
  houseBalanceCapRatio: number;
}) {
  if (!params.adminDiscordId || params.requestedBy !== params.adminDiscordId) {
    throw new NotAdminError(params.requestedBy);
  }
  if (!(params.lowerTierWeight >= 1)) {
    throw new InvalidEconomyConfigError('lowerTierWeight must be >= 1');
  }
  if (!(params.houseBalanceCapRatio > 0 && params.houseBalanceCapRatio <= 1)) {
    throw new InvalidEconomyConfigError('houseBalanceCapRatio must be in (0, 1]');
  }

  await getOrCreateEconomyConfig();

  return prisma.economyConfig.update({
    where: { id: ECONOMY_CONFIG_ID },
    data: { lowerTierWeight: params.lowerTierWeight, houseBalanceCapRatio: params.houseBalanceCapRatio },
  });
}
```

- [ ] **Step 7: 테스트 실행해서 통과 확인**

Run: `npx vitest run tests/services/economyConfig.test.ts`
Expected: PASS (7개 테스트 모두 통과)

- [ ] **Step 8: 호환성 패치 — `tests/services/distributionBatch.test.ts`의 `updateEconomyConfig` 호출부 수정**

`tests/services/distributionBatch.test.ts`의 "원자성" 테스트 안에서 다음 코드를 찾는다:

```ts
    await updateEconomyConfig({
      requestedBy: 'admin-1',
      adminDiscordId: 'admin-1',
      rebateRate: 1,
      lowerTierWeight: 1.5,
    });
```

다음으로 교체한다 (이 테스트는 Task 3에서 캡 기준 시나리오로 전체 재작성되므로, 지금은 새 시그니처에 맞춰 컴파일·실행이 되도록만 최소 수정한다):

```ts
    await updateEconomyConfig({
      requestedBy: 'admin-1',
      adminDiscordId: 'admin-1',
      lowerTierWeight: 1.5,
      houseBalanceCapRatio: 0.4,
    });
```

- [ ] **Step 9: 전체 테스트 스위트 실행해서 초록 확인**

Run: `npx vitest run`
Expected: PASS (기존에 통과하던 모든 테스트가 계속 통과함 — Task 1은 economyConfig 서비스만 바꿨으므로 회귀가 없어야 함)

- [ ] **Step 10: 커밋**

```bash
git add prisma/schema.prisma prisma/migrations src/services/economyConfig.ts tests/services/economyConfig.test.ts tests/services/distributionBatch.test.ts
git commit -m "feat: EconomyConfig에 houseBalanceCapRatio 추가, rebateRate는 수정 대상에서 제외"
```

---

### Task 2: `house.ts` — `getEconomySnapshot()` 추출

**Files:**
- Modify: `src/services/house.ts`
- Test: `tests/services/house.test.ts`

**Interfaces:**
- Consumes: 없음 (기존 `getOrCreateHouse(db)`, `prisma`만 사용)
- Produces: `getEconomySnapshot(db?: Db): Promise<{ house: House; totalUserBalance: number; totalEconomy: number }>` — Task 3, Task 5에서 재사용됨.
- Produces(변경 없음, 내부 구현만 재사용): `getHouseStatus(db?: Db): Promise<{ balance: number; totalUserBalance: number; share: number }>`

- [ ] **Step 1: 실패하는 테스트 작성 — `tests/services/house.test.ts`에 `getEconomySnapshot` import 및 새 `describe` 블록 추가**

파일 상단 import를 다음으로 교체한다:

```ts
import { describe, expect, test } from 'vitest';
import { prisma } from '../../src/db/client';
import { getOrCreateUser, InsufficientBalanceError } from '../../src/services/ledger';
import {
  applyHouseTransaction,
  getEconomySnapshot,
  getHouseStatus,
  getOrCreateHouse,
  HOUSE_ID,
} from '../../src/services/house';
```

`describe('getHouseStatus', ...)` 블록 바로 앞에 다음 블록을 추가한다:

```ts
describe('getEconomySnapshot', () => {
  test('하우스/유저가 모두 없으면 전부 0이다', async () => {
    const snapshot = await getEconomySnapshot();

    expect(snapshot.house.balance).toBe(0);
    expect(snapshot.totalUserBalance).toBe(0);
    expect(snapshot.totalEconomy).toBe(0);
  });

  test('유저 잔액 합 + 하우스 잔액을 totalEconomy로 반환한다', async () => {
    await getOrCreateUser('snapshot-1'); // 10,000,000
    await getOrCreateUser('snapshot-2'); // 10,000,000
    await getOrCreateHouse();
    await prisma.$transaction((tx) =>
      applyHouseTransaction(tx, { type: 'TAX', amount: 5_000_000, description: 'test setup' })
    );

    const snapshot = await getEconomySnapshot();

    expect(snapshot.house.balance).toBe(5_000_000);
    expect(snapshot.totalUserBalance).toBe(20_000_000);
    expect(snapshot.totalEconomy).toBe(25_000_000);
  });
});
```

- [ ] **Step 2: 테스트 실행해서 실패 확인**

Run: `npx vitest run tests/services/house.test.ts`
Expected: FAIL — `getEconomySnapshot`가 `house.ts`에 없어서 `TypeError: getEconomySnapshot is not a function` (또는 import 실패)

- [ ] **Step 3: `src/services/house.ts`에 `getEconomySnapshot` 추출, `getHouseStatus`가 재사용하도록 리팩터**

`getHouseStatus` 함수 전체를 다음으로 교체한다:

```ts
export async function getEconomySnapshot(db: Db = prisma) {
  const house = await getOrCreateHouse(db);
  const users = await db.user.findMany({ select: { balance: true } });
  const totalUserBalance = users.reduce((sum, user) => sum + user.balance, 0);
  const totalEconomy = house.balance + totalUserBalance;
  return { house, totalUserBalance, totalEconomy };
}

export async function getHouseStatus(db: Db = prisma) {
  const { house, totalUserBalance, totalEconomy } = await getEconomySnapshot(db);
  const share = totalEconomy > 0 ? house.balance / totalEconomy : 0;

  return { balance: house.balance, totalUserBalance, share };
}
```

- [ ] **Step 4: 테스트 실행해서 통과 확인**

Run: `npx vitest run tests/services/house.test.ts`
Expected: PASS (기존 `getHouseStatus`/`applyHouseTransaction`/`getOrCreateHouse` 테스트 포함 전부 통과)

- [ ] **Step 5: 커밋**

```bash
git add src/services/house.ts tests/services/house.test.ts
git commit -m "refactor: house.ts에서 getEconomySnapshot 추출, getHouseStatus가 재사용"
```

---

### Task 3: `distributionBatch.ts` — `computeRebateDistribution()` 추출 + 캡 기준 재원 계산으로 교체

**Files:**
- Modify: `src/services/distributionBatch.ts`
- Modify: `src/jobs/distributionBatch.ts`
- Test: `tests/services/distributionBatch.test.ts` (전체 교체)

**Interfaces:**
- Consumes: `getEconomySnapshot(db?)`, `getOrCreateEconomyConfig(db?)`, `applyHouseTransaction`, `applyTransaction` (Task 1, Task 2 및 기존 코드)
- Produces: `computeRebateDistribution(params: { users: { discordId: string }[]; lowerTierUserIds: string[]; fundAmount: number; lowerTierWeight: number }): { perUserAmounts: Map<string, number>; totalDistributed: number }` — Task 5(catch-up 스크립트)에서 재사용됨.
- Produces(변경 없음): `getLowerTierUserIds(db, options?)`, `issueCouponsForUsers(db, userIds, now)` — Task 5에서 `getLowerTierUserIds` 재사용됨.
- Produces(반환 타입 변경 없음): `distributionBatch(now?, options?): Promise<DistributionBatchResult>`

- [ ] **Step 1: 실패하는 테스트 작성 — `tests/services/distributionBatch.test.ts` 전체를 아래 내용으로 교체**

```ts
import { describe, expect, test } from 'vitest';
import { prisma } from '../../src/db/client';
import { getOrCreateHouse, HOUSE_ID } from '../../src/services/house';
import { computeRebateDistribution, distributionBatch } from '../../src/services/distributionBatch';

async function setHouse(balance: number, lastRebateBalance: number) {
  await getOrCreateHouse();
  await prisma.house.update({ where: { id: HOUSE_ID }, data: { balance, lastRebateBalance } });
}

async function createUsers(prefix: string, count: number, balanceOf: (i: number) => number) {
  for (let i = 1; i <= count; i++) {
    await prisma.user.create({ data: { discordId: `${prefix}${i}`, balance: balanceOf(i) } });
  }
}

describe('computeRebateDistribution', () => {
  test('하위 30% 유저는 가중치, 나머지는 균등 분배한다', () => {
    const users = Array.from({ length: 10 }, (_, i) => ({ discordId: `u${i + 1}` }));
    const lowerTierUserIds = ['u1', 'u2', 'u3'];

    const result = computeRebateDistribution({
      users,
      lowerTierUserIds,
      fundAmount: 500_000,
      lowerTierWeight: 1.5,
    });

    // totalWeight = 10 + 3*(1.5-1) = 11.5, unitShare = floor(500,000 / 11.5) = 43,478
    expect(result.perUserAmounts.get('u1')).toBe(65_217); // floor(43,478 * 1.5)
    expect(result.perUserAmounts.get('u4')).toBe(43_478);
    expect(result.totalDistributed).toBe(3 * 65_217 + 7 * 43_478);
  });

  test('fundAmount가 0 이하면 아무도 받지 않는다', () => {
    const result = computeRebateDistribution({
      users: [{ discordId: 'a' }],
      lowerTierUserIds: [],
      fundAmount: -100,
      lowerTierWeight: 1.5,
    });

    expect(result.perUserAmounts.size).toBe(0);
    expect(result.totalDistributed).toBe(0);
  });

  test('유저가 없으면 아무도 받지 않는다', () => {
    const result = computeRebateDistribution({
      users: [],
      lowerTierUserIds: [],
      fundAmount: 100_000,
      lowerTierWeight: 1.5,
    });

    expect(result.perUserAmounts.size).toBe(0);
    expect(result.totalDistributed).toBe(0);
  });
});

describe('distributionBatch - 정상 케이스', () => {
  test('하우스 캡 초과분에 하위 30% 가중치를 적용해 분배한다', async () => {
    await createUsers('u', 10, (i) => i * 1_000_000); // 합계 55,000,000
    await setHouse(37_500_000, 0);
    // totalEconomy = 37,500,000 + 55,000,000 = 92,500,000
    // cap(40%) = floor(92,500,000 * 0.4) = 37,000,000 -> 초과분 500,000

    const result = await distributionBatch(new Date('2026-07-05T00:00:00.000Z'));

    expect(result.distributed).toBe(true);
    expect(result.fundAmount).toBe(500_000);
    expect(result.lowerTierCount).toBe(3); // floor(10 * 0.3)
    expect(result.couponsIssued).toBe(3);
    expect(result.couponsSkipped).toBe(0);

    const lowerTierIds = ['u1', 'u2', 'u3'];
    const normalIds = ['u4', 'u5', 'u6', 'u7', 'u8', 'u9', 'u10'];

    for (const id of lowerTierIds) {
      const user = await prisma.user.findUniqueOrThrow({ where: { discordId: id } });
      const baseBalance = Number(id.slice(1)) * 1_000_000;
      expect(user.balance).toBe(baseBalance + 65_217);
      expect(result.perUserAmounts.get(id)).toBe(65_217);
    }
    for (const id of normalIds) {
      const user = await prisma.user.findUniqueOrThrow({ where: { discordId: id } });
      const baseBalance = Number(id.slice(1)) * 1_000_000;
      expect(user.balance).toBe(baseBalance + 43_478);
      expect(result.perUserAmounts.get(id)).toBe(43_478);
    }

    // totalDistributed = 3*65,217 + 7*43,478 = 499,997 -> 잔돈 3은 하우스에 남는다
    const house = await prisma.house.findUniqueOrThrow({ where: { id: HOUSE_ID } });
    expect(house.balance).toBe(37_500_000 - 499_997);
    expect(house.lastRebateBalance).toBe(house.balance); // 계산엔 안 쓰이지만 감사 기록용으로 계속 갱신
    expect(house.lastRebateAt?.toISOString()).toBe('2026-07-05T00:00:00.000Z');

    const coupons = await prisma.bettingDoubleCoupon.findMany({ orderBy: { userId: 'asc' } });
    expect(coupons.map((c) => c.userId)).toEqual(['u1', 'u2', 'u3']);
    expect(coupons.every((c) => c.usedAt === null)).toBe(true);
    expect(coupons[0].expiresAt.toISOString()).toBe('2026-07-12T00:00:00.000Z');
  });
});

describe('distributionBatch - 봇 계정 제외', () => {
  test('excludeUserId로 지정한 유저(예: 봇 자신)는 인원수 계산과 지급 대상 양쪽에서 완전히 빠진다', async () => {
    await createUsers('nobot', 9, (i) => i * 1_000_000); // 합계 45,000,000
    await prisma.user.create({ data: { discordId: 'bot-account', balance: 1 } });
    await setHouse(40_000_000, 0);
    // totalEconomy = 40,000,000 + 45,000,001 = 85,000,001, cap(40%) = 34,000,000 -> 초과분 6,000,000

    const result = await distributionBatch(new Date('2026-07-05T00:00:00.000Z'), {
      excludeUserId: 'bot-account',
    });

    expect(result.distributed).toBe(true);
    expect(result.lowerTierCount).toBe(2); // floor(9 * 0.3), 봇 제외한 9명 기준
    expect(result.perUserAmounts.has('bot-account')).toBe(false);

    const botUser = await prisma.user.findUniqueOrThrow({ where: { discordId: 'bot-account' } });
    expect(botUser.balance).toBe(1); // 변동 없음

    const botCoupons = await prisma.bettingDoubleCoupon.findMany({ where: { userId: 'bot-account' } });
    expect(botCoupons).toHaveLength(0);

    const botTxs = await prisma.transaction.findMany({ where: { userId: 'bot-account' } });
    expect(botTxs).toHaveLength(0);
  });
});

describe('distributionBatch - 하우스가 캡 이하', () => {
  test('초과분이 없으면 분배는 스킵하지만 에러 없이 정상 종료하고 체크포인트는 갱신된다', async () => {
    await createUsers('s', 5, () => 1_000_000); // 합계 5,000,000
    await setHouse(1_000_000, 6_000_000);
    // totalEconomy = 1,000,000 + 5,000,000 = 6,000,000, cap(40%) = 2,400,000
    // 하우스 잔고(1,000,000) < cap(2,400,000) -> 초과분 없음

    const result = await distributionBatch(new Date('2026-07-05T00:00:00.000Z'));

    expect(result.distributed).toBe(false);
    expect(result.fundAmount).toBe(0);
    expect(result.perUserAmounts.size).toBe(0);

    for (let i = 1; i <= 5; i++) {
      const user = await prisma.user.findUniqueOrThrow({ where: { discordId: `s${i}` } });
      expect(user.balance).toBe(1_000_000); // 변동 없음
    }

    const house = await prisma.house.findUniqueOrThrow({ where: { id: HOUSE_ID } });
    expect(house.balance).toBe(1_000_000); // 변동 없음
    expect(house.lastRebateBalance).toBe(1_000_000); // 현재 값으로 갱신 (감사 기록용)
    expect(house.lastRebateAt?.toISOString()).toBe('2026-07-05T00:00:00.000Z');

    // 재원이 없어도 하위 플레이어 쿠폰은 발급된다 (floor(5*0.3)=1명)
    const coupons = await prisma.bettingDoubleCoupon.findMany();
    expect(coupons).toHaveLength(1);
  });
});

describe('distributionBatch - 원자성', () => {
  test('설정값이 비정상적이어서 지급액이 하우스 잔고를 초과하면 전부 롤백된다', async () => {
    await createUsers('atomic', 3, () => 1_000_000);
    await setHouse(1_000, 0);
    // 서비스 계층 검증(0 초과 1 이하)을 우회해 DB에 직접 비정상 캡비율을 기록한다 -
    // 계산 로직이 이런 상황에서도 하우스 잔고 이상으로 지급하려 하면 원자적으로
    // 롤백되는지 검증한다. upsert라 EconomyConfig row 존재 여부와 무관하게 동작한다.
    await prisma.economyConfig.upsert({
      where: { id: 'SINGLETON' },
      create: { id: 'SINGLETON', houseBalanceCapRatio: -1 },
      update: { houseBalanceCapRatio: -1 },
    });
    // totalEconomy = 1,000 + 3,000,000 = 3,001,000, cap = floor(3,001,000 * -1) = -3,001,000
    // 초과분 = 1,000 - (-3,001,000) = 3,002,000 -> 실제 하우스 잔고(1,000)를 훨씬 초과

    await expect(distributionBatch(new Date('2026-07-05T00:00:00.000Z'))).rejects.toThrow();

    for (let i = 1; i <= 3; i++) {
      const user = await prisma.user.findUniqueOrThrow({ where: { discordId: `atomic${i}` } });
      expect(user.balance).toBe(1_000_000); // 롤백됨
    }

    const house = await prisma.house.findUniqueOrThrow({ where: { id: HOUSE_ID } });
    expect(house.balance).toBe(1_000); // 롤백됨

    const coupons = await prisma.bettingDoubleCoupon.findMany();
    expect(coupons).toHaveLength(0); // 쿠폰 발급도 함께 롤백됨
  });
});

describe('distributionBatch - 캡 도달 후 연속 실행', () => {
  test('환급 후 하우스 잔고가 캡 근처로 수렴하고, 곧바로 다시 실행하면 재원이 거의 남지 않는다', async () => {
    await createUsers('conv', 4, () => 1_000_000); // 합계 4,000,000
    await setHouse(6_000_000, 0);
    // totalEconomy = 10,000,000, cap(40%) = 4,000,000, 초과분 = 2,000,000

    const first = await distributionBatch(new Date('2026-07-05T00:00:00.000Z'));
    expect(first.distributed).toBe(true);
    expect(first.fundAmount).toBe(2_000_000);

    const houseAfterFirst = await prisma.house.findUniqueOrThrow({ where: { id: HOUSE_ID } });
    // 환급은 포인트를 하우스->유저로 옮길 뿐 totalEconomy를 바꾸지 않으므로,
    // 하우스 잔고는 캡(4,000,000)에 반올림 잔돈 이내로 수렴한다.
    expect(houseAfterFirst.balance).toBeGreaterThanOrEqual(4_000_000);
    expect(houseAfterFirst.balance).toBeLessThan(4_000_010);

    const second = await distributionBatch(new Date('2026-07-05T00:00:10.000Z'));
    // 실행 간격이 짧아도(하루도 안 지나도) 매번 그 시점 실제 잔고 기준으로 재계산하므로
    // 문제없이 재원이 거의 없다고 나온다 (예전 "순증가분" 방식의 간격 의존성이 사라짐).
    expect(second.fundAmount).toBeLessThan(10);
  });
});

describe('distributionBatch - 베팅2배쿠폰 보유 개수 제한', () => {
  test('미사용+미만료 쿠폰을 0장 또는 1장 보유 중이면 정상 발급된다', async () => {
    await createUsers('cap', 10, (i) => i * 1_000_000); // 하위 3명: cap1, cap2, cap3
    await setHouse(37_500_000, 0);

    const existing = await prisma.bettingDoubleCoupon.create({
      data: { userId: 'cap2', expiresAt: new Date('2026-07-20T00:00:00.000Z') },
    });

    const result = await distributionBatch(new Date('2026-07-05T00:00:00.000Z'));

    expect(result.couponsIssued).toBe(3);
    expect(result.couponsSkipped).toBe(0);

    const cap1Coupons = await prisma.bettingDoubleCoupon.findMany({ where: { userId: 'cap1' } });
    expect(cap1Coupons).toHaveLength(1);

    const cap2Coupons = await prisma.bettingDoubleCoupon.findMany({
      where: { userId: 'cap2' },
      orderBy: { issuedAt: 'asc' },
    });
    expect(cap2Coupons).toHaveLength(2);
    expect(cap2Coupons[0].id).toBe(existing.id);
  });

  test('이미 유효한 쿠폰을 2장 보유 중이면 발급을 스킵하고 기존 2장을 그대로 유지한다', async () => {
    await createUsers('capb', 10, (i) => i * 1_000_000);
    await setHouse(37_500_000, 0);

    await prisma.bettingDoubleCoupon.create({
      data: { userId: 'capb1', expiresAt: new Date('2026-07-10T00:00:00.000Z') },
    });
    await prisma.bettingDoubleCoupon.create({
      data: { userId: 'capb1', expiresAt: new Date('2026-07-15T00:00:00.000Z') },
    });

    const result = await distributionBatch(new Date('2026-07-05T00:00:00.000Z'));

    expect(result.couponsIssued).toBe(2);
    expect(result.couponsSkipped).toBe(1);

    const capb1Coupons = await prisma.bettingDoubleCoupon.findMany({ where: { userId: 'capb1' } });
    expect(capb1Coupons).toHaveLength(2);
  });

  test('2장 중 1장이 이미 만료됐으면 유효한 것만 카운트해서 정상 발급된다', async () => {
    await createUsers('capc', 10, (i) => i * 1_000_000);
    await setHouse(37_500_000, 0);

    await prisma.bettingDoubleCoupon.create({
      data: { userId: 'capc1', expiresAt: new Date('2026-07-01T00:00:00.000Z') },
    });
    await prisma.bettingDoubleCoupon.create({
      data: { userId: 'capc1', expiresAt: new Date('2026-07-20T00:00:00.000Z') },
    });

    const result = await distributionBatch(new Date('2026-07-05T00:00:00.000Z'));

    expect(result.couponsIssued).toBe(3);
    expect(result.couponsSkipped).toBe(0);

    const capc1Coupons = await prisma.bettingDoubleCoupon.findMany({ where: { userId: 'capc1' } });
    expect(capc1Coupons).toHaveLength(3);
  });
});
```

- [ ] **Step 2: 테스트 실행해서 실패 확인**

Run: `npx vitest run tests/services/distributionBatch.test.ts`
Expected: FAIL — `computeRebateDistribution`가 아직 export되지 않아 import 에러, 그리고 금액 관련 assertion들이 기존 순증가분 로직 기준 값과 달라 실패함.

- [ ] **Step 3: `src/services/distributionBatch.ts` 교체**

파일 상단 import와 `distributionBatch` 함수 사이(기존 `issueCouponsForUsers` 함수 뒤, `export async function distributionBatch` 앞)에 다음을 삽입한다:

```ts
export interface RebateDistributionResult {
  perUserAmounts: Map<string, number>;
  totalDistributed: number;
}

// 정기 배치와 catch-up 스크립트가 공유하는 순수 분배 함수 (DB 접근 없음).
// fundAmount를 "일반 유저 1지분 + 하위 30% 유저는 lowerTierWeight배" 규칙으로 나눈다.
export function computeRebateDistribution(params: {
  users: { discordId: string }[];
  lowerTierUserIds: string[];
  fundAmount: number;
  lowerTierWeight: number;
}): RebateDistributionResult {
  const lowerTierIds = new Set(params.lowerTierUserIds);
  const perUserAmounts = new Map<string, number>();

  if (params.fundAmount <= 0 || params.users.length === 0) {
    return { perUserAmounts, totalDistributed: 0 };
  }

  const totalWeight =
    params.users.length + params.lowerTierUserIds.length * (params.lowerTierWeight - 1);
  const unitShare = Math.floor(params.fundAmount / totalWeight);

  let totalDistributed = 0;
  for (const user of params.users) {
    const amount = lowerTierIds.has(user.discordId)
      ? Math.floor(unitShare * params.lowerTierWeight)
      : unitShare;
    if (amount <= 0) continue;
    perUserAmounts.set(user.discordId, amount);
    totalDistributed += amount;
  }

  return { perUserAmounts, totalDistributed };
}
```

`export async function distributionBatch(...)` 함수 전체를 다음으로 교체한다:

```ts
export async function distributionBatch(
  now: Date = new Date(),
  options?: { excludeUserId?: string }
): Promise<DistributionBatchResult> {
  return prisma.$transaction(async (tx) => {
    const config = await getOrCreateEconomyConfig(tx);
    const { house, totalEconomy } = await getEconomySnapshot(tx);

    // 예전 방식: "순증가분(house.balance - lastRebateBalance) × rebateRate(5%)".
    // 하우스 유입 속도가 빨라지면 환급이 못 따라가는 문제가 있어(2026-07 하우스 잔고
    // 75%까지 급증) "하우스가 전체 경제의 houseBalanceCapRatio를 넘지 않도록 초과분
    // 전액을 환급"하는 방식으로 교체했다. rebateRate는 스키마/DB에는 남겨두지만
    // (추후 다른 용도로 재사용될 수 있어 완전히 제거하지 않음) 이 계산에는 더 이상
    // 쓰이지 않는다.
    const capAmount = Math.floor(totalEconomy * config.houseBalanceCapRatio);
    const fundAmount = Math.max(0, house.balance - capAmount);

    const users = await tx.user.findMany({
      where: options?.excludeUserId ? { discordId: { not: options.excludeUserId } } : undefined,
      orderBy: { balance: 'asc' },
      select: { discordId: true },
    });
    const lowerTierUserIds = await getLowerTierUserIds(tx, options);

    const { perUserAmounts, totalDistributed } = computeRebateDistribution({
      users,
      lowerTierUserIds,
      fundAmount,
      lowerTierWeight: config.lowerTierWeight,
    });

    for (const [discordId, amount] of perUserAmounts) {
      await applyTransaction(tx, {
        discordId,
        type: TransactionType.REBATE,
        amount,
        description: '환급',
        occurredAt: now,
      });
    }

    const distributed = totalDistributed > 0;

    if (distributed) {
      const updatedHouse = await applyHouseTransaction(tx, {
        type: TransactionType.REBATE,
        amount: -totalDistributed,
        description: '환급 재원 지급 (하우스 캡 초과분, 반올림 잔돈은 하우스에 남김)',
        occurredAt: now,
      });
      await tx.house.update({
        where: { id: HOUSE_ID },
        data: { lastRebateBalance: updatedHouse.balance, lastRebateAt: now },
      });
    } else {
      // 초과분이 없어도 감사 기록 차원에서 체크포인트는 현재 값으로 갱신한다.
      await tx.house.update({
        where: { id: HOUSE_ID },
        data: { lastRebateBalance: house.balance, lastRebateAt: now },
      });
    }

    const { issuedUserIds, skippedUserIds } = await issueCouponsForUsers(tx, lowerTierUserIds, now);

    return {
      distributed,
      fundAmount,
      lowerTierCount: lowerTierUserIds.length,
      couponsIssued: issuedUserIds.length,
      couponsSkipped: skippedUserIds.length,
      perUserAmounts,
    };
  });
}
```

파일 최상단 import 구문을 다음으로 교체한다 (`getOrCreateHouse` 직접 사용이 없어져 제거, `getEconomySnapshot` 추가):

```ts
import { Prisma, TransactionType } from '@prisma/client';
import { prisma } from '../db/client';
import { getOrCreateEconomyConfig } from './economyConfig';
import { applyHouseTransaction, getEconomySnapshot, HOUSE_ID } from './house';
import { applyTransaction } from './ledger';
```

- [ ] **Step 4: 테스트 실행해서 통과 확인**

Run: `npx vitest run tests/services/distributionBatch.test.ts`
Expected: PASS (전체 통과)

- [ ] **Step 5: `src/jobs/distributionBatch.ts`의 공지 문구를 캡 기준으로 갱신**

`announceDistribution` 함수 안의 다음 부분을 찾는다:

```ts
  if (result.distributed) {
    const perUserCount = result.perUserAmounts.size;
    lines.push(
      `순증가분 기준 환급 재원: ${result.fundAmount.toLocaleString()}P`,
      `대상 ${perUserCount}명에게 지급 완료 (\`/잔액\`으로 정확한 지급액 확인 가능)`
    );
  } else {
    lines.push('이번 배치는 순증가분이 없어 환급이 지급되지 않았습니다.');
  }
```

다음으로 교체한다:

```ts
  if (result.distributed) {
    const perUserCount = result.perUserAmounts.size;
    lines.push(
      `하우스 캡 초과분 기준 환급 재원: ${result.fundAmount.toLocaleString()}P`,
      `대상 ${perUserCount}명에게 지급 완료 (\`/잔액\`으로 정확한 지급액 확인 가능)`
    );
  } else {
    lines.push('이번 배치는 하우스 잔고가 캡 이하라 환급이 지급되지 않았습니다.');
  }
```

- [ ] **Step 6: 전체 테스트 스위트 + 타입체크 실행**

Run: `npx vitest run && npx tsc --noEmit`
Expected: 둘 다 통과 (에러 0건)

- [ ] **Step 7: 커밋**

```bash
git add src/services/distributionBatch.ts src/jobs/distributionBatch.ts tests/services/distributionBatch.test.ts
git commit -m "feat: distributionBatch를 하우스 캡 초과분 기준으로 재작성, 분배 로직을 순수 함수로 추출"
```

---

### Task 4: `/환급설정`, `/환급설정조회` 커맨드 옵션 변경

**Files:**
- Modify: `src/commands/economyConfigSet.ts`
- Modify: `src/commands/economyConfigView.ts`

**Interfaces:**
- Consumes: `updateEconomyConfig(params: { requestedBy, adminDiscordId, lowerTierWeight, houseBalanceCapRatio })` (Task 1), `getOrCreateEconomyConfig()` (기존)

이 두 파일은 기존에도 전용 테스트 파일이 없다(수동/명령어 등록 후 디스코드에서 확인하는 방식). TDD 대신 구현 후 타입체크로 검증한다.

- [ ] **Step 1: `src/commands/economyConfigSet.ts` 전체 교체**

```ts
import {
  type ChatInputCommandInteraction,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { env } from '../config/env';
import { NotAdminError } from '../services/adminGrant';
import { InvalidEconomyConfigError, updateEconomyConfig } from '../services/economyConfig';

export const data = new SlashCommandBuilder()
  .setName('환급설정')
  .setDescription('(관리자 전용) 하위 플레이어 가중치와 하우스 캡 비율을 설정합니다.')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addNumberOption((opt) =>
    opt
      .setName('가중치')
      .setDescription('하위 플레이어 가중치 (1 이상, 예: 1.5 = 1.5배)')
      .setRequired(true)
      .setMinValue(1)
  )
  .addNumberOption((opt) =>
    opt
      .setName('캡비율')
      .setDescription('하우스 잔고 상한 비율 (0 초과 1 이하, 예: 0.4 = 40%)')
      .setRequired(true)
      .setMinValue(0.01)
      .setMaxValue(1)
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  const lowerTierWeight = interaction.options.getNumber('가중치', true);
  const houseBalanceCapRatio = interaction.options.getNumber('캡비율', true);

  try {
    const updated = await updateEconomyConfig({
      requestedBy: interaction.user.id,
      adminDiscordId: env.ADMIN_DISCORD_ID,
      lowerTierWeight,
      houseBalanceCapRatio,
    });

    await interaction.reply({
      content: [
        '✅ 환급 설정을 변경했습니다. 다음 배치부터 즉시 반영됩니다.',
        `하위 플레이어 가중치: ${updated.lowerTierWeight}배`,
        `하우스 캡 비율: ${(updated.houseBalanceCapRatio * 100).toFixed(1)}%`,
      ].join('\n'),
      flags: MessageFlags.Ephemeral,
    });
  } catch (error) {
    if (error instanceof NotAdminError) {
      await interaction.reply({ content: '관리자만 사용할 수 있습니다.', flags: MessageFlags.Ephemeral });
      return;
    }
    if (error instanceof InvalidEconomyConfigError) {
      await interaction.reply({
        content: '가중치는 1 이상, 캡 비율은 0 초과 1 이하여야 합니다.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    throw error;
  }
}
```

- [ ] **Step 2: `src/commands/economyConfigView.ts` 전체 교체**

```ts
import { type ChatInputCommandInteraction, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { getOrCreateEconomyConfig } from '../services/economyConfig';

export const data = new SlashCommandBuilder()
  .setName('환급설정조회')
  .setDescription('현재 하위 플레이어 가중치와 하우스 캡 비율을 확인합니다.');

export async function execute(interaction: ChatInputCommandInteraction) {
  const config = await getOrCreateEconomyConfig();

  await interaction.reply({
    content: [
      '**현재 환급 설정**',
      `하위 플레이어 가중치: ${config.lowerTierWeight}배`,
      `하우스 캡 비율: ${(config.houseBalanceCapRatio * 100).toFixed(1)}%`,
    ].join('\n'),
    flags: MessageFlags.Ephemeral,
  });
}
```

- [ ] **Step 3: 타입체크 + 전체 테스트 실행**

Run: `npx tsc --noEmit && npx vitest run`
Expected: 둘 다 통과 (에러 0건)

- [ ] **Step 4: 커밋**

```bash
git add src/commands/economyConfigSet.ts src/commands/economyConfigView.ts
git commit -m "feat: /환급설정, /환급설정조회에서 비율 옵션을 캡비율로 교체"
```

---

### Task 5: catch-up CLI 스크립트 신규 작성

**Files:**
- Create: `src/scripts/houseBalanceCapCatchUp.ts`
- Test: `tests/scripts/houseBalanceCapCatchUp.test.ts`

**Interfaces:**
- Consumes: `computeRebateDistribution`, `getLowerTierUserIds` (Task 3), `getEconomySnapshot` (Task 2), `getOrCreateEconomyConfig` (기존), `applyTransaction`, `applyHouseTransaction` (기존)
- Produces: `runCatchUp(execute: boolean, now?: Date): Promise<CatchUpPlan>` — CLI(`main()`)와 테스트 양쪽에서 호출됨.
- Produces: `CatchUpPlan` 타입 (`totalEconomy`, `capRatio`, `capAmount`, `houseBalanceBefore`, `excessAmount`, `lowerTierCount`, `items: { discordId: string; amount: number }[]`, `totalDistributed`)

- [ ] **Step 1: 실패하는 테스트 작성 — `tests/scripts/houseBalanceCapCatchUp.test.ts` 신규 생성**

```ts
import { describe, expect, test } from 'vitest';
import { prisma } from '../../src/db/client';
import { runCatchUp } from '../../src/scripts/houseBalanceCapCatchUp';
import { getOrCreateHouse, HOUSE_ID } from '../../src/services/house';

async function setHouse(balance: number) {
  await getOrCreateHouse();
  await prisma.house.update({ where: { id: HOUSE_ID }, data: { balance } });
}

async function createUsers(prefix: string, count: number, balanceOf: (i: number) => number) {
  for (let i = 1; i <= count; i++) {
    await prisma.user.create({ data: { discordId: `${prefix}${i}`, balance: balanceOf(i) } });
  }
}

describe('runCatchUp - dry-run', () => {
  test('계산만 하고 DB에는 아무 것도 쓰지 않는다', async () => {
    await createUsers('u', 10, (i) => i * 1_000_000); // 합계 55,000,000
    await setHouse(37_500_000);
    // totalEconomy = 92,500,000, cap(40%) = 37,000,000, 초과분 = 500,000

    const plan = await runCatchUp(false, new Date('2026-07-10T00:00:00.000Z'));

    expect(plan.excessAmount).toBe(500_000);
    expect(plan.items.length).toBeGreaterThan(0);

    const house = await prisma.house.findUniqueOrThrow({ where: { id: HOUSE_ID } });
    expect(house.balance).toBe(37_500_000); // 변동 없음

    const txs = await prisma.transaction.findMany();
    expect(txs).toHaveLength(0);

    const houseTxs = await prisma.houseTransaction.findMany();
    expect(houseTxs).toHaveLength(0);

    const coupons = await prisma.bettingDoubleCoupon.findMany();
    expect(coupons).toHaveLength(0); // catch-up은 쿠폰을 발급하지 않는다
  });

  test('초과분이 없으면 items가 비어있고 아무 것도 안 한다', async () => {
    await createUsers('v', 5, () => 1_000_000); // 합계 5,000,000
    await setHouse(1_000_000);
    // totalEconomy = 6,000,000, cap(40%) = 2,400,000, 하우스(1,000,000) < cap -> 초과분 0

    const plan = await runCatchUp(false, new Date('2026-07-10T00:00:00.000Z'));

    expect(plan.excessAmount).toBe(0);
    expect(plan.items).toHaveLength(0);
    expect(plan.totalDistributed).toBe(0);
  });
});

describe('runCatchUp - execute', () => {
  test('초과분만큼 실제로 지급하고 Transaction/HouseTransaction에 감사 로그를 남긴다', async () => {
    await createUsers('w', 10, (i) => i * 1_000_000); // 합계 55,000,000
    await setHouse(37_500_000);
    // totalEconomy = 92,500,000, cap(40%) = 37,000,000, 초과분 = 500,000

    const plan = await runCatchUp(true, new Date('2026-07-10T00:00:00.000Z'));

    expect(plan.excessAmount).toBe(500_000);
    expect(plan.totalDistributed).toBeGreaterThan(0);

    const house = await prisma.house.findUniqueOrThrow({ where: { id: HOUSE_ID } });
    expect(house.balance).toBe(37_500_000 - plan.totalDistributed);

    const houseTxs = await prisma.houseTransaction.findMany({
      where: { description: { contains: 'catch-up' } },
    });
    expect(houseTxs).toHaveLength(1);
    expect(houseTxs[0].amount).toBe(-plan.totalDistributed);

    const userTxs = await prisma.transaction.findMany({
      where: { description: '하우스 캡 초과분 catch-up 정산' },
    });
    expect(userTxs).toHaveLength(plan.items.length);

    const coupons = await prisma.bettingDoubleCoupon.findMany();
    expect(coupons).toHaveLength(0); // 정기 배치와 달리 쿠폰은 발급하지 않는다
  });

  test('초과분이 없으면 실행 모드여도 아무 것도 지급하지 않는다', async () => {
    await createUsers('x', 5, () => 1_000_000);
    await setHouse(1_000_000);

    const plan = await runCatchUp(true, new Date('2026-07-10T00:00:00.000Z'));

    expect(plan.excessAmount).toBe(0);

    const house = await prisma.house.findUniqueOrThrow({ where: { id: HOUSE_ID } });
    expect(house.balance).toBe(1_000_000); // 변동 없음

    const txs = await prisma.transaction.findMany();
    expect(txs).toHaveLength(0);
  });
});
```

- [ ] **Step 2: 테스트 실행해서 실패 확인**

Run: `npx vitest run tests/scripts/houseBalanceCapCatchUp.test.ts`
Expected: FAIL — `src/scripts/houseBalanceCapCatchUp.ts` 파일이 없어서 모듈을 찾을 수 없다는 에러(`Cannot find module`)

- [ ] **Step 3: `src/scripts/houseBalanceCapCatchUp.ts` 신규 생성**

```ts
import { Prisma, TransactionType } from '@prisma/client';
import { prisma } from '../db/client';
import { computeRebateDistribution, getLowerTierUserIds } from '../services/distributionBatch';
import { getOrCreateEconomyConfig } from '../services/economyConfig';
import { applyHouseTransaction, getEconomySnapshot } from '../services/house';
import { applyTransaction } from '../services/ledger';

type Db = Prisma.TransactionClient | typeof prisma;

export interface CatchUpPlanItem {
  discordId: string;
  amount: number;
}

export interface CatchUpPlan {
  totalEconomy: number;
  capRatio: number;
  capAmount: number;
  houseBalanceBefore: number;
  excessAmount: number;
  lowerTierCount: number;
  items: CatchUpPlanItem[];
  totalDistributed: number;
}

async function buildCatchUpPlan(db: Db): Promise<CatchUpPlan> {
  const config = await getOrCreateEconomyConfig(db);
  const { house, totalEconomy } = await getEconomySnapshot(db);
  const capAmount = Math.floor(totalEconomy * config.houseBalanceCapRatio);
  const excessAmount = Math.max(0, house.balance - capAmount);

  const users = await db.user.findMany({ select: { discordId: true } });
  const lowerTierUserIds = await getLowerTierUserIds(db);
  const { perUserAmounts, totalDistributed } = computeRebateDistribution({
    users,
    lowerTierUserIds,
    fundAmount: excessAmount,
    lowerTierWeight: config.lowerTierWeight,
  });

  return {
    totalEconomy,
    capRatio: config.houseBalanceCapRatio,
    capAmount,
    houseBalanceBefore: house.balance,
    excessAmount,
    lowerTierCount: lowerTierUserIds.length,
    items: [...perUserAmounts].map(([discordId, amount]) => ({ discordId, amount })),
    totalDistributed,
  };
}

// catch-up(격차를 한 번에 메우는 일회성 조정): 하우스 잔고가 전체 경제의 캡을 넘어선
// 만큼을 한 번에 지급한다. execute=false(기본값)면 계산만 하고 DB에 아무것도 쓰지
// 않는다 - dry-run과 execute 양쪽에서 이 함수를 그대로 재사용하며, 매번 그 시점의
// 실제 DB 상태를 다시 읽는다(dry-run 확인 직후 곧바로 execute를 실행하는 것을 전제).
export async function runCatchUp(execute: boolean, now: Date = new Date()): Promise<CatchUpPlan> {
  return prisma.$transaction(async (tx) => {
    const plan = await buildCatchUpPlan(tx);

    console.log(execute ? '=== 실행 결과 ===' : '=== DRY-RUN 결과 (DB에 쓰지 않음) ===');
    console.log(`전체 경제 규모: ${plan.totalEconomy.toLocaleString()}P`);
    console.log(`캡(${(plan.capRatio * 100).toFixed(0)}%): ${plan.capAmount.toLocaleString()}P`);
    console.log(`하우스 현재 잔고: ${plan.houseBalanceBefore.toLocaleString()}P`);
    console.log(`초과분(지급 재원): ${plan.excessAmount.toLocaleString()}P`);

    if (plan.excessAmount <= 0) {
      console.log('하우스 잔고가 이미 캡 이하입니다. 지급할 것이 없습니다.');
      return plan;
    }

    for (const item of plan.items) {
      console.log(
        `${execute ? '[실행]' : '[DRY-RUN]'} ${item.discordId}: +${item.amount.toLocaleString()}P`
      );
    }
    console.log(`총 지급액: ${plan.totalDistributed.toLocaleString()}P (반올림 잔돈은 하우스에 남음)`);

    if (execute) {
      for (const item of plan.items) {
        await applyTransaction(tx, {
          discordId: item.discordId,
          type: TransactionType.REBATE,
          amount: item.amount,
          description: '하우스 캡 초과분 catch-up 정산',
          occurredAt: now,
        });
      }
      await applyHouseTransaction(tx, {
        type: TransactionType.REBATE,
        amount: -plan.totalDistributed,
        description: '하우스 캡 초과분 catch-up 재원 지급 (일회성)',
        occurredAt: now,
      });
    }

    return plan;
  });
}

async function main() {
  const execute = process.argv.includes('--execute');
  await runCatchUp(execute);
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

- [ ] **Step 4: 테스트 실행해서 통과 확인**

Run: `npx vitest run tests/scripts/houseBalanceCapCatchUp.test.ts`
Expected: PASS (5개 테스트 모두 통과)

- [ ] **Step 5: 전체 테스트 스위트 + 타입체크 실행**

Run: `npx vitest run && npx tsc --noEmit`
Expected: 둘 다 통과 (에러 0건)

- [ ] **Step 6: 커밋**

```bash
git add src/scripts/houseBalanceCapCatchUp.ts tests/scripts/houseBalanceCapCatchUp.test.ts
git commit -m "feat: 하우스 캡 초과분 catch-up CLI 스크립트 추가 (기본 dry-run, --execute로 실제 지급)"
```

**사용법 (구현 완료 후 관리자가 직접 실행):**
1. `npx tsx src/scripts/houseBalanceCapCatchUp.ts` (dry-run, DB 미변경) → 콘솔 출력 확인
2. `npx tsx src/scripts/houseBalanceCapCatchUp.ts --execute` (실제 지급)

---

### Task 6: `PROGRESS.md`에 변경 사항 요약

**Files:**
- Modify: `PROGRESS.md`

- [ ] **Step 1: 최상단 날짜와 "새 세션 시작 시 필수 체크" 블록 사이에 새 섹션 삽입**

`PROGRESS.md` 3번째 줄의 `> 최종 업데이트: 2026-07-04`를 `> 최종 업데이트: 2026-07-10`로 바꾼다.

`## 0. 복권 "매일 낮 12시 자동 추첨 안 됨" 이슈 (2026-07-04)` 섹션 바로 앞(구분선 `---` 다음 줄)에 다음 섹션을 삽입한다:

```markdown
## 하우스 잔고 상한(House Balance Cap) 시스템 구현 (2026-07-10)

**배경**: 하우스 잔고가 전체 경제 규모의 75%까지 불어남 (`HOUSE_SYSTEM_OVERVIEW.md` 조사로
발견). 기존 주간 환급 배치는 "하우스 잔고 순증가분 × 고정 5%"만 환급하는 구조라 유입
속도를 못 따라갔음.

**변경 사항**:
- `EconomyConfig`에 `houseBalanceCapRatio`(기본 0.4, 즉 40%) 필드 추가.
  `rebateRate`는 스키마/DB 값은 유지하되 계산에는 더 이상 쓰이지 않음(주석으로 명시).
- `house.ts`: 기존 `getHouseStatus()`에 있던 "전체 경제 규모" 계산을
  `getEconomySnapshot()`으로 추출해 공용화.
- `distributionBatch.ts`: 하위 30% 가중치 분배 로직을 `computeRebateDistribution()`
  순수 함수로 추출. 주간 배치의 재원 계산을 "순증가분 × rebateRate"에서
  "하우스잔고 - (전체경제규모 × houseBalanceCapRatio)"(초과분 전액)로 교체.
  초과분이 0 이하면 정상 스킵(에러 아님).
- `src/scripts/houseBalanceCapCatchUp.ts` (신규): 현재 75%까지 벌어진 격차를 한 번에
  메우는 catch-up CLI 스크립트. 기본 dry-run(계산만, DB 미변경), `--execute` 플래그를
  줘야 실제 지급. `computeRebateDistribution()`을 재사용하되 베팅2배쿠폰은 발급하지
  않음. 사용법: `npx tsx src/scripts/houseBalanceCapCatchUp.ts` (dry-run) →
  `npx tsx src/scripts/houseBalanceCapCatchUp.ts --execute` (실제 지급).
- `/환급설정`: `비율` 옵션 제거, `캡비율` 옵션 추가 (`가중치`는 유지). `/환급설정조회`도
  동일하게 갱신.

**설계 문서**: `docs/superpowers/specs/2026-07-10-house-balance-cap-design.md`
**구현 계획**: `docs/superpowers/plans/2026-07-10-house-balance-cap.md`

**다음 세션에서 확인 필요**:
- [ ] catch-up 스크립트 실제 실행 여부 확인 (dry-run으로 먼저 숫자 검토 후 `--execute`)
- [ ] `deploy-commands` 실행해서 `/환급설정`의 새 옵션(`캡비율`)이 디스코드에 반영됐는지 확인
- [ ] catch-up 실행 후 `/하우스`로 하우스 점유율이 40% 근처로 내려왔는지 확인

---
```

- [ ] **Step 2: 커밋**

```bash
git add PROGRESS.md
git commit -m "docs: 하우스 잔고 상한 시스템 구현 내역을 PROGRESS.md에 요약"
```

---

## Self-Review 체크리스트 (계획 작성자용, 참고)

- **스펙 커버리지**: 스펙의 "데이터 모델 변경"→Task1, "getEconomySnapshot"→Task2,
  "computeRebateDistribution + distributionBatch 재작성"→Task3, "커맨드 변경"→Task4,
  "catch-up 스크립트"→Task5, "PROGRESS.md 요약"(원 요청사항)→Task6. 스펙의 "영향받지
  않는 부분"(모드2 10% 상한, 다른 유입 경로, 쿠폰 발급 로직 자체)은 의도적으로 어떤
  Task에서도 건드리지 않음.
- **플레이스홀더 없음**: 모든 스텝에 실제 코드/명령어가 포함되어 있음.
- **타입 일관성**: `computeRebateDistribution`의 파라미터/반환 타입이 Task3(정의)과
  Task5(사용) 양쪽에서 동일 (`{ discordId: string }[]`, `RebateDistributionResult`).
  `getEconomySnapshot`의 반환 타입(`{ house, totalUserBalance, totalEconomy }`)도
  Task2(정의)·Task3·Task5(사용) 전부 동일하게 구조 분해됨.
