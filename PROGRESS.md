# discord-economy 진행상황 브리핑
> 다음 세션 시작 시 클로드 코드에게 "이 파일 읽고 이어서 작업해줘"라고 전달하세요.
> 최종 업데이트: 2026-07-04

## 0. 복권 "매일 낮 12시 자동 추첨 안 됨" 이슈 (2026-07-04)

**증상**: 매일 낮 12시(KST) 자동 복권 추첨이 실행되지 않는 것처럼 보임.

**실제 원인 (스케줄러/시간대 버그 아님)**:
- `node-cron` 스케줄 등록, `kstMidnightUtc` 변환 로직 모두 정상. Railway 로그 확인 결과
  `2026-07-04T03:00:08 UTC` = **정확히 그날 12:00:08 KST**에 cron이 실행되었고, 당첨 번호
  추첨/정산(DB 트랜잭션)도 정상적으로 끝남.
- 문제는 그 다음 단계: 추첨 결과를 `LOTTERY_CHANNEL_ID` 채널(`복권-쪽쪽`)에 공지하려다
  `DiscordAPIError[50013]: Missing Permissions`로 실패. 원인은 해당 채널의 권한
  오버라이드가 `@everyone`에 "메시지 보내기"를 deny 해놨는데, 봇 계정에는 그걸 다시
  allow 해주는 채널별 오버라이드가 없었음 (봇 오버라이드는 "채널 보기"만 allow).
  → **추첨/정산 자체는 매일 정상적으로 실행되고 있었고, 사용자에게 보이는 공지 메시지만
  안 올라온 것**. 콘솔에만 에러가 남아서 아무도 몰랐음 (조용한 실패).
- 봇 역할(`소세지 하우스`)에는 `MANAGE_CHANNELS`/`MANAGE_ROLES` 권한이 없어서, 봇 스스로
  이 채널 권한을 API로 고칠 수도 없는 상태였음.

**적용한 코드 수정**:
- `src/jobs/lotteryDraw.ts`: `runDailyLotteryDraw`의 catch에서 `DiscordAPIError`
  (code 50013/50001)를 구분해서, "추첨/정산은 끝났고 공지만 실패했다 + 어느 채널의
  어떤 권한이 문제인지"를 명확히 로그로 남기도록 함. (이전엔 그냥 스택트레이스만 찍혀서
  "추첨이 아예 안 됐다"고 오해하기 쉬웠음)
- `src/scripts/manualLotteryDraw.ts` (신규): 정오까지 기다리지 않고 실제 추첨 함수를
  수동 실행해보는 스크립트. 이미 정산된 회차는 대상 티켓이 0장이라 잭팟/잔액에 영향
  없이 "공지 메시지가 채널에 올라오는지"만 안전하게 반복 테스트 가능.
  실행: `railway ssh` 후 컨테이너 안에서 `npx tsx src/scripts/manualLotteryDraw.ts`
  (로컬 `railway run`은 DB가 Railway 볼륨에 있어서 안 됨 — 반드시 `railway ssh`로
  컨테이너 안에서 실행할 것).

**후속 조치 완료**:
- [x] `복권-쪽쪽` 채널(`1521804703523016754`) 권한에서 봇에게 "메시지 보내기" 허용
      오버라이드 추가 완료 (서버 관리자가 디스코드 앱에서 직접 수정).
- [x] 권한 수정 후 `manualLotteryDraw.ts`를 컨테이너(`railway ssh`) 안에서 재실행해
      확인. 이번엔 에러 로그 없이 조용히 완료됐고, Discord API로 채널 메시지를 직접
      조회해 `2026-07-04T13:25:53 UTC`에 "[복권 추첨] 당첨 번호: 14 / 참여자 없음"
      메시지가 실제로 올라온 것까지 확인함. 다음 정오까지 기다리지 않고 전체 파이프라인
      (추첨 → 정산 → 채널 공지) 검증 완료.
- [x] `src/jobs/distributionBatch.ts`의 `announceDistribution`도 동일한 `channel.send()`
      패턴이라 같은 종류의 권한 문제가 잠재해 있어, 동일한 진단 로그 개선을 적용함
      (`runDistributionBatch` catch에서 DiscordAPIError 50013/50001 구분).

---

## 1. 오늘(2026-07-03) 완료된 작업

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

### 미니게임 2종
- 블랙잭, 가위바위보 스펙 작성 및 구현 완료
- 관련 문서: `blackjack-minigame-spec.md`, `rps-minigame-spec.md`

### 포인트 이동 로그 조회 기능 (`/포인트내역`)
**중요한 발견**: 처음엔 새 `PointTransaction` 모델 + `adjustPoints` 헬퍼 함수를 만들려고 초안(`adjustPoints.js`, `pointHistory.js`)을 작성했으나,
프로젝트에 **이미 동일한 역할을 하는 시스템이 있는 것을 확인**하고 초안은 폐기함:
- 기존 `Transaction` 테이블 (`balanceAfter`로 변경 후 잔액 스냅샷까지 이미 저장 중)
- 기존 `src/services/ledger.ts`의 `applyTransaction` 함수 — 잔액 변경 + 거래 기록 생성을 원자적으로 처리, 마이너스 잔액 방지 가드 포함
- 블랙잭·가위바위보·베팅정산·복권·환급·양도·대출·관리자지급 등 포인트가 움직이는 **모든 경로가 이미 이 함수 하나로 통합**되어 있었음 (`balance:`를 직접 수정하는 곳은 `ledger.ts`/`house.ts` 단 2곳뿐임을 검색으로 확인)

→ **결론: 새 원장 시스템을 만들지 않고, 기존 `Transaction` 모델을 조회하는 명령어만 추가함.**

**신규 생성 파일 3개** (기존 초안 `adjustPoints.js`/`pointHistory.js`는 삭제됨):
| 파일 | 역할 |
|---|---|
| `src/discord/transactionView.ts` | `TransactionType` 24종을 한글 라벨로 매핑, 거래 1건을 한 줄 텍스트로 만드는 `formatTransactionLine`/`formatTransactionLineWithUser` 공용 함수. 기존 `/잔액`(balance.ts)에 있던 라벨 6개짜리 로컬 사본은 제거하고 이 공용 모듈로 리팩터함 |
| `src/services/pointHistory.ts` | `getPointHistory({ requestedBy, adminDiscordId, userId?, limit? })` — 기존 `Transaction` 테이블 조회만 담당. 관리자 권한 체크는 `/환급설정` 등과 동일한 패턴(`NotAdminError` 재사용). `limit`은 1~30 사이로 강제 |
| `src/commands/pointHistory.ts` | `/포인트내역` 슬래시 커맨드. 유저 지정 시 그 사람 것만, 안 하면 전체 최근 내역을 에페메럴(관리자에게만 보임)로 응답. `commands/index.ts`에 등록 완료 |

TDD로 진행: 테스트 먼저 작성 → RED 확인 → 구현 → GREEN. **전체 테스트 339개 통과**, `tsc --noEmit` 클린.

### ⚠️ 다음 세션에서 확인 필요
- [ ] 변경사항 커밋/푸시 완료 여부 확인
- [ ] `/포인트내역`은 신규 슬래시 커맨드이므로 `deploy-commands` 실행(디스코드에 실제 등록) 여부 확인
- [ ] 실제 디스코드에서 `/포인트내역` 동작 테스트

### 하위 플레이어 지원 정책 (이전 세션에 완료, 참고용)
환급 개편(순증가분 기준, 하위 30% 가중치 1.5배, `/환급설정`으로 실시간 조정) + 추격쿠폰(하위 판정시 자동 지급, 순수익 2배, 7일 소멸) — 설계·구현 완료 상태.

---

## 2. 다음 작업: 티어 시스템

**설계 확정 사항** (아직 미구현):
- 기준: 보유 포인트가 아닌 **역대 최고 포인트(`peakPoints`)** 기준 자동 계산
- 등급: BRONZE / SILVER / GOLD / DIAMOND
- **강등 없음** (한 번 올라간 티어는 유지)
- DB 스키마 변경 필요: `User`에 `currentTier`, `peakPoints`, `lastCheckIn`, `streakCount` 필드 추가 + `TierHistory` 테이블 신설
- 출석 스트릭(연속 출석 시 보상 배율, 최대 7일 캡)도 함께 구현 예정이었음

**구현 순서**: 1) 티어 시스템 → 2) 출석 스트릭 → 3) (이미 완료된) 미니게임

**보류 결정된 아이디어**: 재테크(주식/부동산) 시스템, 전직 시스템 — 디플레이션, 부익부빈익빈, 동시성 버그, 복잡도 리스크로 보류.

---

## 3. 핵심 아키텍처 원칙 (반드시 지킬 것)
- 포인트 변경은 **반드시 `ledger.ts`의 `applyTransaction`을 거쳐야 함**. 새 모델/헬퍼를 만들지 말고 기존 시스템을 재사용할 것.
- 경제 철학: 폐쇄 루프(쿠폰 보너스는 하우스 잔고에서 차감), TDD 방식, `EconomyConfig` 싱글턴 테이블로 파라미터 관리.
