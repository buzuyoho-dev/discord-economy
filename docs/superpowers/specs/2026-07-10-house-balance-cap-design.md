# 하우스 잔고 상한(House Balance Cap) 시스템 설계

## 배경 / 목적

`HOUSE_SYSTEM_OVERVIEW.md` 조사 결과, 하우스 잔고가 전체 경제 규모의 75%까지 불어난
상태다. 기존 주간 환급 배치(`distributionBatch()`)는 "직전 환급 이후 하우스 잔고
순증가분(`house.balance - lastRebateBalance`) × `rebateRate`(고정 5%)"만 환급하는
구조라, 하우스로의 유입 속도가 빨라지면 환급이 그 속도를 못 따라간다.

이 설계는 계산 기준을 "순증가분의 N%"에서 **"하우스 잔고가 전체 경제 규모의
`houseBalanceCapRatio`(기본 40%)를 넘지 않도록, 넘는 만큼(초과분) 전액 환급"** 방식으로
바꾼다. 그리고 현재 75%까지 벌어진 격차를 한 번에 메우는 **catch-up(격차를 한 번에
메우는 일회성 조정) 스크립트**를 별도로 둔다.

## 범위 확정 (브레인스토밍 중 확인된 사실 / 결정 사항)

- **전체 경제 규모(totalEconomy) 계산은 이미 존재함**: `house.ts`의 `getHouseStatus()`가
  "모든 유저 잔고 합 + 하우스 잔고"를 이미 계산하고 있었다. 새로 만들지 않고
  `getEconomySnapshot()`으로 추출해 재사용한다.
- **분배 로직(하위 30% 가중치)도 재사용**: `distributionBatch.ts`의 분배 계산은 지금
  `distributionBatch()` 함수 안에 inline으로 있어 재사용이 불가능한 상태였다.
  `computeMode1Settlement`/`computeUnifiedSettlement`와 동일한 패턴으로 순수 함수
  `computeRebateDistribution()`으로 추출해서, 정기 배치와 catch-up 스크립트가 함께 쓴다.
- **catch-up은 CLI 스크립트로 만든다** (Discord 슬래시 명령어 아님). 기존
  `src/scripts/resetServerBalances.ts`와 동일한 "기본 dry-run, `--execute` 플래그로만
  실제 실행" 패턴을 그대로 따른다. 금액이 크고 일회성이라, 디스코드 명령어보다
  터미널/서버 접근 권한이 있는 사람만 실행 가능한 쪽이 실수 방지에 더 안전하다는 판단.
- **catch-up은 포인트만 분배하고 베팅2배쿠폰은 발급하지 않는다**. 정기 주간 배치는
  "환급 + 쿠폰 발급"이 한 세트지만, catch-up은 정기 사이클이 아닌 일회성 격차
  조정이므로 쿠폰 발급까지 묶을 이유가 없다.
- **`House.lastRebateBalance`/`lastRebateAt` 필드는 스키마·데이터 그대로 유지**하되,
  `lastRebateBalance`는 새 계산식에서 더 이상 읽지 않는다(감사 기록용으로만 계속
  갱신). `lastRebateAt`은 "마지막 환급이 언제였는지" 기록으로 계속 유용하므로 그대로
  갱신한다.
- **`rebateRate` 필드도 스키마·DB 값은 유지**하되 계산에는 더 이상 쓰지 않는다.
  나중에 다시 필요해질 수 있어 완전히 제거하지 않고, 계산 코드에 왜 안 쓰는지
  주석을 남긴다.
- **`/환급설정` 명령어에서 `비율`(rebateRate) 옵션은 제거**한다. 관리자가 더 이상
  의미 없는 값을 조정하며 헷갈릴 이유가 없다. 대신 `캡비율`(houseBalanceCapRatio)
  옵션을 새로 추가한다. `가중치`(lowerTierWeight)는 그대로 유지.
- **catch-up 지급의 `TransactionType`은 기존 `REBATE`를 재사용**한다. 성격상 환급과
  동일(하우스 초과분을 유저에게 되돌려주는 것)이므로 새 enum 값을 추가하지 않는다.
  `description`으로 정기 환급과 구분한다 (`'하우스 캡 초과분 catch-up 정산'`).

## 데이터 모델 변경

`prisma/schema.prisma`의 `EconomyConfig`에 필드 추가:

```prisma
model EconomyConfig {
  id                   String   @id @default("SINGLETON")
  rebateRate           Float    @default(0.05)   // 더 이상 계산에 안 쓰임 (아래 참고)
  lowerTierWeight      Float    @default(1.5)
  houseBalanceCapRatio Float    @default(0.4)     // 신규 — 하우스 잔고가 넘지 않아야 할 전체 경제 대비 비율
  updatedAt            DateTime @updatedAt
}
```

SQLite 프로젝트라 컬럼 추가는 마이그레이션 파일 하나로 처리하고, 기존 싱글톤 row에
`houseBalanceCapRatio = 0.4`를 시딩한다. 기존 `Transaction`/`HouseTransaction` 테이블은
변경 없음 — catch-up 지급도 그 두 테이블에 `REBATE` 타입으로 그대로 감사 로그가 남는다.

## 서비스 계층 변경

### 1. `src/services/house.ts` — 전체 경제 규모 계산 추출

```ts
export async function getEconomySnapshot(db: Db = prisma) {
  const house = await getOrCreateHouse(db);
  const users = await db.user.findMany({ select: { balance: true } });
  const totalUserBalance = users.reduce((sum, u) => sum + u.balance, 0);
  const totalEconomy = house.balance + totalUserBalance;
  return { house, totalUserBalance, totalEconomy };
}

export async function getHouseStatus(db: Db = prisma) {
  const { house, totalUserBalance, totalEconomy } = await getEconomySnapshot(db);
  const share = totalEconomy > 0 ? house.balance / totalEconomy : 0;
  return { balance: house.balance, totalUserBalance, share };
}
```

`/하우스` 명령어(`getHouseStatus()` 호출부)의 동작·반환값은 변경 없음. 주간 배치와
catch-up 스크립트가 `getEconomySnapshot()`을 새로 가져다 쓴다.

### 2. `src/services/economyConfig.ts` — 캡 비율 설정 추가

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

`rebateRate` 파라미터는 시그니처에서 제거하고, `update`의 `data`에서도 뺀다 (DB 값은
건드리지 않고 그대로 유지됨).

### 3. `src/services/distributionBatch.ts` — 분배 함수 추출 + 캡 기준 계산으로 교체

```ts
export interface RebateDistributionResult {
  perUserAmounts: Map<string, number>;
  totalDistributed: number;
}

// 정기 배치와 catch-up 스크립트가 공유하는 순수 분배 함수 (DB 접근 없음).
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

`distributionBatch()`의 재원 계산부를 교체:

```ts
const config = await getOrCreateEconomyConfig(tx);
const { house, totalEconomy } = await getEconomySnapshot(tx);

// 예전 방식: "순증가분(house.balance - lastRebateBalance) × rebateRate(5%)".
// 하우스 유입 속도가 빨라지면 환급이 못 따라가는 문제가 있어(2026-07 하우스 잔고
// 75%까지 급증), "하우스가 전체 경제의 houseBalanceCapRatio를 넘지 않도록 초과분
// 전액을 환급"하는 방식으로 교체했다. rebateRate는 스키마/DB에는 남겨두지만
// (추후 다른 용도로 재사용될 수 있어 완전히 제거하지 않음) 이 계산에는 더 이상
// 쓰이지 않는다.
const capAmount = Math.floor(totalEconomy * config.houseBalanceCapRatio);
const fundAmount = Math.max(0, house.balance - capAmount);
```

이후 `getLowerTierUserIds()`로 하위 30% 목록을 구하고, `computeRebateDistribution()`으로
`perUserAmounts`를 얻어 기존과 동일하게 `applyTransaction(REBATE)` 루프를 돈다.
`fundAmount === 0`(초과분 없음)이면 지급 루프 없이 콘솔에 스킵 로그만 남기고 정상
종료한다(에러 아님). `lastRebateBalance`/`lastRebateAt` 갱신, `issueCouponsForUsers()`
호출은 기존과 동일하게 유지한다(범위 밖).

`src/jobs/distributionBatch.ts`의 디스코드 공지 문구도 "순증가분 기준" →
"하우스 캡 초과분 기준"으로 갱신한다.

### 4. `src/scripts/houseBalanceCapCatchUp.ts` (신규) — catch-up CLI 스크립트

`resetServerBalances.ts`와 동일한 구조(기본 dry-run, `--execute`로만 실제 지급).

```ts
export interface CatchUpPlanItem {
  discordId: string;
  amount: number;
}

export interface CatchUpPlan {
  totalEconomy: number;
  capRatio: number;
  capAmount: number;
  houseBalanceBefore: number;
  excessAmount: number;   // 0이면 초과분 없음 = 할 일 없음
  lowerTierCount: number;
  items: CatchUpPlanItem[];
  totalDistributed: number;
}

async function buildCatchUpPlan(tx: Db): Promise<CatchUpPlan> {
  const config = await getOrCreateEconomyConfig(tx);
  const { house, totalEconomy } = await getEconomySnapshot(tx);
  const capAmount = Math.floor(totalEconomy * config.houseBalanceCapRatio);
  const excessAmount = Math.max(0, house.balance - capAmount);

  const users = await tx.user.findMany({ select: { discordId: true } });
  const lowerTierUserIds = await getLowerTierUserIds(tx);
  const { perUserAmounts, totalDistributed } = computeRebateDistribution({
    users, lowerTierUserIds, fundAmount: excessAmount, lowerTierWeight: config.lowerTierWeight,
  });

  return {
    totalEconomy, capRatio: config.houseBalanceCapRatio, capAmount,
    houseBalanceBefore: house.balance, excessAmount, lowerTierCount: lowerTierUserIds.length,
    items: [...perUserAmounts].map(([discordId, amount]) => ({ discordId, amount })),
    totalDistributed,
  };
}

export async function runCatchUp(execute: boolean, now: Date = new Date()): Promise<CatchUpPlan> {
  return prisma.$transaction(async (tx) => {
    const plan = await buildCatchUpPlan(tx);

    // 콘솔 출력: 총 초과분, 전체 경제 규모, 캡 금액, 유저별 지급 예정액 (dry-run/실행 공통)
    // ... (resetServerBalances.ts와 동일한 로그 포맷)

    if (plan.excessAmount <= 0) {
      return plan; // 지급할 것 없음, 여기서 종료
    }

    if (execute) {
      for (const item of plan.items) {
        await applyTransaction(tx, {
          discordId: item.discordId, type: TransactionType.REBATE, amount: item.amount,
          description: '하우스 캡 초과분 catch-up 정산', occurredAt: now,
        });
      }
      await applyHouseTransaction(tx, {
        type: TransactionType.REBATE, amount: -plan.totalDistributed,
        description: '하우스 캡 초과분 catch-up 재원 지급 (일회성)', occurredAt: now,
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
  main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
}
```

실행 방법: `npx tsx src/scripts/houseBalanceCapCatchUp.ts` (기본, dry-run, DB 미변경) →
콘솔 출력 확인 → `npx tsx src/scripts/houseBalanceCapCatchUp.ts --execute` (실제 지급).
지급은 `applyTransaction`/`applyHouseTransaction`을 통하므로 `Transaction`/
`HouseTransaction` 양쪽에 자동으로 감사 로그가 남는다(요구사항 충족).

주의: dry-run과 execute는 각각 별도 프로세스 실행이고, `buildCatchUpPlan()`이 매번
그 시점의 실제 DB 상태를 다시 읽는다 — dry-run 때 본 숫자와 execute 시점의 숫자가
그 사이 다른 거래가 있었다면 달라질 수 있음(레이스 컨디션). 이 프로젝트의 운영
방식상 dry-run 직후 곧바로 execute를 실행하는 것을 전제로 하며, 별도의 락 메커니즘은
범위 밖으로 둔다.

## 커맨드 계층 변경

### `src/commands/economyConfigSet.ts` (`/환급설정`)

- `비율` 옵션 제거.
- `캡비율` 옵션 신규 추가: `.setName('캡비율')`, "하우스 잔고 상한 비율 (0 초과 1
  이하, 예: 0.4 = 40%)", `setMinValue(0.01)`, `setMaxValue(1)`.
- `가중치` 옵션 유지.
- 응답 메시지에서 "비율: N%" 줄 제거, "캡비율: N%" 줄 추가.

### `src/commands/economyConfigView.ts` (`/환급설정조회`)

- "비율: N%" 줄 제거, "캡비율: N%" 줄 추가. `가중치` 표시는 유지.

## 테스트 전략 (TDD)

- `computeRebateDistribution()`: 순수 함수 단위 테스트 (하위 30% 가중치, 잔돈 처리,
  fundAmount 0/음수 경계값).
- `getEconomySnapshot()`: 유저 잔고 합 + 하우스 잔고 = totalEconomy 검증, 빈 DB
  경계값(기존 `houseLazyInit.test.ts` 패턴 재사용).
- `distributionBatch()`: 캡 초과 시 초과분만큼 지급, 캡 이하일 때 스킵(에러 아님)
  검증. 기존 "순증가분 기준" 테스트들은 새 캡 기준 시나리오로 재작성.
- `updateEconomyConfig()`: `houseBalanceCapRatio` 검증 범위 (0 이하/1 초과 시 에러),
  `rebateRate`는 더 이상 파라미터로 안 받는 것 확인.
- `runCatchUp()`: dry-run은 DB에 아무 변화도 안 남기는지, execute는 정확히 계산된
  초과분만큼 지급되고 `HouseTransaction`/`Transaction`에 감사 로그가 남는지, 초과분
  0/음수일 때 아무 것도 안 하는지, 쿠폰이 발급되지 않는지 검증.

## 영향받지 않는 부분 (명시적 범위 제외)

- 다른 하우스 유입 경로(도박/블랙잭/가위바위보/베팅/양도/대출/복권 수수료·세금)는
  변경 없음.
- 모드2 베팅의 "하우스 잔고 10% 상한"(베팅 1건당 상한)은 이번 작업과 무관한 별개
  로직이며 변경하지 않는다.
- 베팅2배쿠폰 발급 로직(`issueCouponsForUsers`) 자체는 변경 없음, 정기 배치에서
  호출 방식도 그대로.
