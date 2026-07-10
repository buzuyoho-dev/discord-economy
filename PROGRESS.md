# discord-economy 진행상황 브리핑
> 다음 세션 시작 시 클로드 코드에게 "이 파일 읽고 이어서 작업해줘"라고 전달하세요.
> 최종 업데이트: 2026-07-10

## ⚠️ 새 세션 시작 시 필수 체크
다른 기기(윈도우/맥북)에서 작업했을 수 있으니, 작업 시작 전에 반드시 `git pull`부터
실행해서 원격(origin/main)과 로컬을 동기화할 것. 확인 없이 새 커밋을 만들면 원격에
있는 다른 기기의 작업 내역과 충돌 날 수 있음.

**다음 세션은 Mac 환경에서 이어감** — 이 세션은 Windows에서 진행됨. Mac에서 시작할 때
`npm install`(Prisma Client 재생성 포함)부터 먼저 돌릴 것.

---

## 2026-07-10 세션 종합 요약 — 하우스 캡 + 환급 공지 시스템 (✅ 프로덕션 반영·실행 완료)

이번 세션에서 진행한 3개 작업 모두 설계·구현·리뷰를 마치고 **`main`에 머지되어 Railway에
배포된 상태**이며, 아래 ①②는 실제 프로덕션 DB 반영/지급까지, ③은 실제 디스코드 공지
전송까지 완료됨. 이하 요약이고, 각 작업의 상세 내역은 바로 아래 개별 섹션(환급 결과
투명 공지 시스템 구현, 하우스 잔고 상한 시스템 구현)에 그대로 남아있음.

### ① 하우스 잔고 상한(House Balance Cap) 시스템
- 하우스 잔고가 전체 경제의 40%(`houseBalanceCapRatio`)를 넘지 않도록 주간 배치 계산식을
  "순증가분 × 5%"에서 "캡 초과분 전액 환급"으로 교체.
- **catch-up 스크립트(`houseBalanceCapCatchUp.ts`)로 그동안 쌓여있던 초과분(75%→40%
  격차)을 하위 유저 우대 방식으로 일괄 환급 — dry-run 확인 후 실제 `--execute`로
  프로덕션 DB에 지급까지 완료됨.**
- PR #1 (`worktree-house-balance-cap` → `main`) 머지 완료.

### ② 환급 결과 투명 공지(Discord Embed) 시스템
- `EconomyConfig.rebateAnnounceChannelId` 필드 신설, 주간 배치/catch-up 양쪽에서 총
  환급액·유저별 지급 내역·하우스 잔고 상태를 담은 임베드를 자동 공지하도록 구현.
- 리뷰 과정에서 발견된 버그 2건(임베드 6000자 총 길이 제한 누락, 주간배치 공지가
  fundAmount를 총 환급액으로 잘못 표시하던 문제) 모두 수정 완료.
- PR #2 (`worktree-rebate-announcement` → `main`) 머지 완료.

### ③ 업데이트 안내 공지 스크립트
- `src/scripts/announceUpdate.ts`(일회성)로 위 ①②의 변경 사항을 플레이어들에게 안내하는
  임베드를 작성.
- **Railway 콘솔에서 직접 실행해 실제 디스코드 채널에 공지 전송까지 완료됨(사용자 확인).**

### 부수적으로 발견/수정한 것
- vitest가 저장소 루트 아래 중첩된 워크트리(`.claude/worktrees/*`)의 테스트까지 재수집해
  같은 `test.db`를 두고 충돌, 대량의 가짜 실패를 내던 설정 버그를 발견해 `vitest.config.ts`에
  `exclude` 추가로 수정.
- Task 5(PROGRESS.md 요약) 구현 서브에이전트가 실수로 main 체크아웃에 직접 커밋한 것을
  발견해 되돌림(`git reset --hard origin/main`), 내용은 올바른 브랜치로 cherry-pick해
  안전하게 보존.

### 현재 `main` 상태 (이 정리 시점 기준)
- 로컬 `main`은 `origin/main`과 완전히 동기화됨 (커밋 차이 없음).
- 커밋되지 않은 변경사항 없음 — 단, 추적되지 않는 파일 `HOUSE_SYSTEM_OVERVIEW.md`가
  저장소 루트에 남아있음(이전 세션의 조사 문서, 커밋된 적 없음 — 필요 없으면 삭제하거나
  커밋할 것).
- 최근 커밋(최신순): `e0fdb9e`(vitest exclude 수정) → `dc372eb`(공지 스크립트 실행 요약)
  → `e1ead98`(공지 스크립트 추가) → `f9a9901`/`f487d54`(공지 스크립트 계획/스펙) →
  `69a2012`(PR #2 머지) → ... (환급 공지 시스템 커밋들) → PR #1 머지 커밋 순.

### 다음 세션에 이어서 할 만한 것 (이번 세션에서 논의됐지만 미착수)
- [ ] `/환급설정`에 캡 비율(`houseBalanceCapRatio`) **조회** 전용 옵션/명령어 추가 여부 검토
      (현재는 `/환급설정조회`로 조회 가능하니 필요성부터 재확인)
- [ ] 관리자용 `/공지` 슬래시 명령어 신설 여부 검토 (이번엔 `announceUpdate.ts` 일회성
      스크립트로 충분했지만, 앞으로 비슷한 공지가 반복될 것 같으면 재사용 가능한
      커맨드로 승격 고려)
- [ ] `.env`/Railway 설정에서 이제 안 쓰는 `REBATE_ANNOUNCEMENT_CHANNEL_ID` 정리 (코드가
      더 이상 안 읽으므로 안 지워도 무해하지만, 원하면 정리)
- [ ] `HOUSE_SYSTEM_OVERVIEW.md`(커밋 안 된 조사 문서) 커밋할지 삭제할지 결정
- [ ] 유저 수가 매우 많을 때 환급 공지의 `.txt` 첨부파일 폴백이 실제로도 정상 동작하는지
      수동 확인(유닛 테스트로는 검증했지만 실제 디스코드 전송으로는 미확인)

---

## 하우스 캡 업데이트 안내 공지 스크립트 실행 (2026-07-10)

`src/scripts/announceUpdate.ts`(일회성)로 플레이어들에게 하우스 잔고 상한 시스템 개편
안내를 `EconomyConfig.rebateAnnounceChannelId` 채널에 공지 완료. 재사용 불필요한
일회성 스크립트라 슬래시 커맨드로는 만들지 않음.

---

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

---

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
- [ ] ⚠️ 주간 배치(월/수/금 자정 KST)가 catch-up보다 먼저 실행되면, 같은 초과분 보정을
      관리자 개입 없이 자동으로(+베팅2배쿠폰까지) 지급해버림 (결과는 동일/무해하지만
      dry-run으로 미리 검토한다는 안전장치 취지가 무력화됨). catch-up을 먼저 실행하거나,
      이 사실을 인지한 상태로 다음 배치를 그대로 맞이할지 결정할 것.
- [ ] `deploy-commands` 실행해서 `/환급설정`의 새 옵션(`캡비율`)이 디스코드에 반영됐는지 확인
- [ ] catch-up 실행 후 `/하우스`로 하우스 점유율이 40% 근처로 내려왔는지 확인

---

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
