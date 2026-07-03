# discord-economy 진행상황 브리핑
> 다음 세션 시작 시 클로드 코드에게 "이 파일 읽고 이어서 작업해줘"라고 전달하세요.
> 최종 업데이트: 2026-07-03

## 1. 오늘(2026-07-03) 완료된 작업

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
