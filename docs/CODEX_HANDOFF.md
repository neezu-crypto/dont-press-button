# Codex 인수인계 — 《절대 누르지 마세요》

## 확정된 제품 동작

- 저장소: `neezu-crypto/dont-press-button`; GitHub Pages 공개 사이트를 사용한다.
- Firebase 프로젝트 `soop-stock-market`과 RTDB `soop-stock-market-default-rtdb`를 공유한다. 별도 프로젝트나 DB는 만들지 않는다.
- 전 참가자가 `dontPressButton/` 아래의 단일 글로벌 게임에 참여한다. 방 선택이나 일반 로그인 UI는 없다.
- Firebase 익명 인증 UID로 참가자를 관리한다. 브라우저 세션은 25초마다 서버 heartbeat를 보내고, 참가자·현재 연결 닉네임·사용자별 접속 기록은 Cloud Functions만 쓴다.
- 페이지를 열 때마다 새 브라우저 세션을 만들고 닉네임을 직접 입력해 입장한다. 닉네임은 브라우저에 저장하지 않는다. Firebase 익명 인증 UID가 이미 활성 상태면 새로 입력한 닉네임으로 갱신하고, 기존 탭의 세션 heartbeat는 계속 유효하다.
- 닉네임은 2~12자다. 정규화된 닉네임의 해시를 서버가 선점해 현재 접속 중인 참가자 사이의 중복을 막는다. 정상 퇴장하면 바로 해제하고, 연결이 끊긴 사용자의 이름은 90초 후 정리된다.
- 최초 시작 전에는 서버 기준 최근 90초 안에 접속한 참가자 6명이 모여야 한다. 서버는 대기 상태를 공개하고 6명이 되면 첫 60초 도전을 시작한다. 시작 후 접속자가 6명 아래로 줄어도 계속 진행하며, 도중에 입장한 참가자도 버튼을 누를 수 있다.
- 기존에 실행 중이던 게임 상태는 누적 기록을 보존한 채 한 번 대기 상태로 전환하고, 6명 조건을 충족하면 다시 시작한다.
- 최초의 서버 승인 누름이 전원 실패를 결정하고 누적 실패 도전 횟수를 1 올린다. 누른 사람의 닉네임을 10초 보여준 뒤 다음 도전을 시작한다.
- 60초 동안 아무도 누르지 않으면 전원 성공이다. 성공 횟수는 서버 내부에서만 집계하고 화면에는 표시하지 않는다. 화면에 성공 횟수를 유추할 수 있는 라운드 번호도 표시하지 않는다. 성공 화면은 30초 후 새 도전을 시작하며 누적 실패 횟수는 유지된다.
- Cloud Tasks가 상태 버전이 포함된 서버 전이를 예약한다. 늦게 도착한 태스크·버튼 요청은 RTDB 트랜잭션에서 현재 버전과 서버 시간을 다시 검증한다. 1분 복구 스케줄러가 누락된 작업과 오래된 접속 기록을 정리한다.
- 브라우저는 익명 인증 후 공개 게임 상태와 공개 닉네임만 RTDB `onValue`로 구독한다. 참가자 UID, 닉네임 인덱스와 버튼 재시도 영수증은 클라이언트에서 읽을 수 없다.
- `dontPressButton/internal/state/failedChallenges`는 전체 게임에서 실패할 때마다 누적되고, 서버가 공개 상태 `dontPressButton/state/failedChallenges`로 복사해 화면에 표시한다. `successCount`와 `successCountsByDate`는 성공할 때마다 서버 내부에서 집계된다. 날짜별 키는 KST 기준 `YYYY-MM-DD`이며 공개 상태와 화면에는 두 집계값 모두 노출하지 않는다. 기존 날짜 기록이 없는 성공 총계는 마이그레이션 시점의 KST 날짜에 귀속한다.

## 구현 위치

- `functions/engine.js`: 대기·6명 시작 조건을 포함한 순수 상태 전이, 서버 마감시각 기반 catch-up과 지연된 기간의 빠른 복구.
- `functions/participant-state.js`: 페이지별 세션 생성 때 닉네임을 갱신하고 만료 세션을 정리하는 순수 참가자 상태 처리.
- `functions/engine.test.js`, `functions/participant-state.test.js`: 대기/6명 시작, 실패·성공 경계, 동시 누름 승자, stale 요청, 세션 갱신, catch-up 단위 테스트.
- `functions/index.js`: `dpbJoin`, `dpbHeartbeat`, `dpbLeave`, `dpbPress`, `dpbTransition`, `dpbTick`.
- `public/`: 접근성·모바일 레이아웃을 갖춘 단일 페이지. `main` 푸시 시 GitHub Actions가 `public/`만 Pages에 게시한다.
- `database.rules.json`: 공유 규칙은 `StreamBet-Market` 원본과 여섯 사본을 바이트 단위로 함께 유지한다. 게임은 `state`와 `publicParticipants`만 인증된 사용자가 읽고, 그 밖의 경로는 서버 전용이다.
- `admin-center/functions/index.js`: 게임 카탈로그와 서버가 기록하는 `presence/dontPressButton/{uid}`를 접속자 분석에 등록한다. 전역 정지는 모든 게임에서, 게임별 정지는 `bannedAccounts/{uid}/games/dontPressButton`에서 서버가 차단한다.

## 검증과 배포 전 확인

1. `node --test functions/engine.test.js`, `node -c` 구문 검사, 브라우저 id·함수명 교차 확인을 수행한다.
2. RTDB Emulator에서 미인증 읽기 차단, 익명 인증 상태 읽기 허용, 클라이언트 쓰기 차단을 확인한다. Functions Emulator와 브라우저 두 개로 동시 누름·재접속도 확인한다.
3. 실제 공유 규칙 사본 여섯 개가 바이트 단위로 같은지 확인하고 `firebase deploy --only database --project soop-stock-market --dry-run`을 실행한다.
4. 새 함수명은 배포 전에 `firebase functions:list --project soop-stock-market`으로 중복을 다시 확인한다. Functions 전체 배포 금지. 정확한 함수 배포 명령은 README를 따른다.
5. Firebase 프로젝트의 익명 인증은 활성화되어 있고 Cloud Tasks API도 켜져 있다. Cloud Tasks 실행 서비스 계정의 enqueue/invoke 권한과 최초 태스크 생성은 배포 후 확인한다.
6. GitHub Pages는 `workflow` 빌드로 활성화되어 있다. `main` 푸시 후 GitHub Actions 실행과 공개 URL `https://neezu-crypto.github.io/dont-press-button/` 응답을 확인한다.
7. 실패 도전 누적 및 성공 횟수 비표시 기준이 확정됐다. 성공 횟수와 KST 날짜별 성공 수는 서버 내부에서만 집계한다. 검증을 통과하면 공통 지침에 따라 변경 파일만 커밋·푸시하고 정확한 서버 함수를 배포한다. Pages 워크플로를 활성화한 뒤 공개 사이트와 Actions 성공을 확인한다.
