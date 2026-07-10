# 하우스 잔고 상한 시스템 업데이트 공지 스크립트 설계

## 배경 / 목적

하우스 잔고 상한(House Balance Cap) + 환급 결과 투명 공지 시스템이 배포됐다. 플레이어들에게
"무엇이 바뀌었는지"를 한 번 안내하는 정적 공지를 보내는, 정확히 한 번만 실행할 목적의
일회성 CLI 스크립트가 필요하다. 재사용 가능한 슬래시 커맨드로 만들 필요는 없다.

## 선행 조건

`EconomyConfig.rebateAnnounceChannelId`는 `worktree-rebate-announcement` 브랜치에서
추가된 필드로, 아직 `main`에 머지되지 않았다. 이 스크립트는 그 필드에 의존하므로,
**`main`에 rebate-announcement PR이 머지된 이후** 새 워크트리에서 구현을 시작한다.

## 범위 확정

- 새 계산/DB 로직 없음 — 순수하게 "정적 텍스트를 임베드로 만들어 채널에 한 번 보내는" 스크립트.
- `manualLotteryDraw.ts`의 Discord `Client` 생성/로그인/종료 패턴과
  `houseBalanceCapCatchUp.ts`의 `main()`에서 `dotenv/config`를 동적 import하는 패턴을
  그대로 따른다(스타일 통일 목적, 이 파일 자체는 테스트가 없어 정적 import해도 무방하지만
  최근 스크립트들과 일관성을 맞춤).
- 채널은 `getOrCreateEconomyConfig()`로 읽은 `rebateAnnounceChannelId`를 그대로 쓴다 —
  하드코딩하지 않는다.
- 임베드 색상은 `0x38a169`(초록)를 재사용한다 — `src/discord/rebateAnnouncement.ts`가
  정상 환급 임베드에 이미 쓰는 색이라, 같은 채널에 향후 뜨는 환급 공지들과 시각적으로
  통일된다.
- 지급 로직이 없는 순수 공지 스크립트라, 환급 관련 스크립트들처럼 "지급 로직/공지 로직
  분리 try-catch"는 필요 없다. 실패하면 콘솔에 에러를 찍고 `process.exitCode = 1`로
  종료하는 기존 스크립트들의 단순한 `main().catch(...)` 패턴을 그대로 쓴다.
- 테스트 없음 — 정적 텍스트를 한 채널에 한 번 보내는 스크립트라 이 프로젝트의 기존
  컨벤션(`jobs/`·`scripts/`의 Discord 전송 코드는 자동 테스트 대상 아님)과 일치한다.

## 메시지 내용

- 제목: `📢 하우스 잔고 상한 시스템 업데이트 안내`
- 설명: 사용자가 제공한 한글 텍스트 그대로(개편 배경, 변경 사항 3개, 앞으로의 동작 2개,
  문의 안내) — 이 문서에 다시 옮겨 적지 않고 원문 그대로 코드에 넣는다(오타 방지).
- 색상: `0x38a169`

## 파일 구조

| 파일 | 역할 |
|---|---|
| `src/scripts/announceUpdate.ts` (신규) | Discord 클라이언트 생성 → 로그인 → `rebateAnnounceChannelId` 채널에 임베드 전송 → 종료 |
| `PROGRESS.md` | 한 줄 요약 추가 |

## 실행 방법

`npx tsx src/scripts/announceUpdate.ts`
