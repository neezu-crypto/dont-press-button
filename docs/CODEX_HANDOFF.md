# Codex 인수인계 — 《절대 누르지 마세요》
## 확정 사항
- 저장소: neezu-crypto/dont-press-button, 공개 GitHub Pages 예정.
- 기존 Firebase 프로젝트 `soop-stock-market`의 RTDB `soop-stock-market-default-rtdb` 공유. 별도 Firebase 프로젝트/DB 생성 금지.
- 새 게임 전용 네임스페이스 `dontPressButton/`, Functions codebase `dontpressbutton`.
- 모든 스트리머와 시청자가 하나의 공용 글로벌 게임에 참가한다. 방/로그인 UI 없음.
- Firebase 익명 인증을 이용해 서버에서 참가자를 식별하고, 화면에는 닉네임만 노출한다.
- 닉네임 2~12자, 현재 접속 중인 참가자 간 중복 불허. 진행 중 입장 허용.
- 플레이 중 누구나 제한 없이 빨간 버튼을 누를 수 있다. 최초 승인된 한 번의 누름으로 전원 실패, 누른 사람 닉네임 표시, 실패 화면 10초 후 자동으로 다음 도전.
- 60초 동안 아무도 누르지 않으면 전원 성공. 성공 화면 30초 후 새 라운드 도전 횟수 1로 재시작.
- 서버가 상태/시각을 권위 있게 판정하며 여러 사람의 동시 누름을 원자적으로 처리한다. 브라우저는 RTDB 실시간 구독으로 렌더링.
- 도전 횟수 및 영구 최고 기록 표시. 현재 초안은 최고 기록을 '성공까지 가장 많은 시도 횟수'로 구현했음. 제품 의도상 최고 기록의 의미가 모호하므로 실서비스 확정 전에 확인할 것.
- 방해자 보상 없음.

## 현재 구현과 한계
- `functions/engine.js`: 순수 상태 전이 엔진; `functions/engine.test.js`: 3개 기초 테스트.
- `functions/index.js`: `dpbJoin`, `dpbPress`, `dpbTick` 초안. **프로덕션 사용 금지**.
- `dpbTick`은 매분 실행되는 복구용 작업일 뿐 60초/10초/30초 정확한 서버 판정을 충족하지 않는다.
- `dpbPress`의 트랜잭션 callback 안에서 변경한 `accepted` 변수를 그대로 반환하는 방식은 트랜잭션 재시도 시 잘못된 응답을 낼 수 있다. committed/snapshot 결과를 검증해야 한다.
- 버튼 호출 시 마감시각을 넘은 상태를 먼저 정리하지 않으면 지연된 성공 판정과 경합이 발생할 수 있다.
- 닉네임 중복 방지, 접속 상태/퇴장/재접속, 차단/운영, 브라우저 UI, Firebase SDK 설정, 실시간 클라이언트 구독, RTDB 규칙 및 관리자 연동 미구현.
- Firebase 인증 공급자, Functions 배포, GitHub Pages 공개, RTDB 규칙 반영 **모두 미완료**.

## 우선 개발 순서
1. 실제 형제 저장소의 `AGENTS.md`, `firebase.json`, 함수 구조, RTDB 규칙 원본과 관리자 코드 확인. 변경 전 영향 범위 기록.
2. 서버 시계 기반 타이머 설계 및 구현. Cloud Tasks 등 정확한 예약 트리거와 지연/중복 실행 멱등성, 콜드 스타트 복구를 고려. 스케줄러는 보조 복구 용도로만 사용.
3. 모든 상태 전이를 원자적으로 처리하고 경쟁 요청/지연 요청/시계 경계 테스트 보강. 성공/실패 시 역대 기록 갱신 원자성 보장.
4. Firebase 익명 인증과 닉네임 선점/중복 방지, presence heartbeat/연결 종료, 닉네임 악용 방어 및 운영 차단 설계.
5. PC/모바일 반응형 단일 페이지 게임 UI: 거대한 빨간 버튼, 서버 기준 남은 시간, 도전 횟수, 접속자, 방해자 표시, 성공/실패 전환, 재시작 대기. 접근성 및 모바일 터치 테스트.
6. 브라우저 직접 쓰기 금지. RTDB 읽기 최소 권한 및 서버 Admin SDK 쓰기. 공유 보안 규칙 수정이 필요하면 StreamBet-Market 정본 포함 6개 사본 모두 동기화, dry-run 필수.
7. `admin-center/functions/index.js`의 `GAME_CATALOG` 등록. `PRESENCE_APPS`는 실제 presence 구현 시에만 추가. 기존 전역 차단과 게임별 차단 동작 검증.
8. 로컬 테스트, Firebase Emulator 테스트, 브라우저 2개 이상으로 동시성 테스트. 검증 성공 시 한글 커밋/push 및 안전한 선택 배포.

## 안전 배포 절차
- `firebase functions:list --project soop-stock-market`에서 함수명 충돌 확인.
- Cloud Functions는 `firebase deploy --only functions:dontpressbutton:<functionName> --project soop-stock-market`처럼 변경 함수만 지정. 전체 Functions 배포 금지.
- 공유 DB 규칙 수정 시 정본/여섯 복사본을 비교하고 `firebase deploy --only database --project soop-stock-market --dry-run`을 먼저 실행.
- 배포 자격 증명, Firebase SDK 설정, 익명 인증 상태, GitHub Pages URL을 실제 확인하고 미확인 사항을 완료로 보고하지 않는다.
- 배포가 위험하거나 권한이 없으면 안전한 변경만 커밋하고 이유를 보고한다.

## Codex 시작 지시
이 파일과 루트 AGENTS.md를 읽은 뒤, 자매 프로젝트 `streamer-life-game/AGENTS.md` 공통 지침을 확인하라. 이 저장소의 초안을 안전하게 실서비스 가능한 완성 게임으로 구현하라. 테스트를 먼저 추가하고, 공용 Firebase의 다른 자매 프로젝트에 영향을 주지 말라. 변경된 함수만 배포하라. 검증 완료 시 한글 커밋 및 push, 배포 URL과 남은 문제를 보고하라.