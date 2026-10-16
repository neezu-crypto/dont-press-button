# 한국인은 절대 못 깨는 게임

전 세계 참가자가 하나의 실시간 라운드에서 함께 버티는 버튼 게임입니다. 아무도 60초 동안 버튼을 누르지 않으면 모두 성공하고, 한 명이라도 누르면 참가자 전원이 실패합니다.

## 게임 흐름

- 참가자는 Firebase 익명 인증으로 식별하고, 화면에는 선택한 닉네임만 표시합니다. 페이지에 접속할 때마다 닉네임을 다시 입력해 입장하며, 브라우저에는 저장하지 않습니다.
- 닉네임은 2~12자이며 현재 접속 중인 참가자끼리 중복해서 사용할 수 없습니다. 같은 계정으로 다시 입장하면 입력한 닉네임으로 바뀝니다. 정상 퇴장하면 바로 해제하고, 연결이 끊기면 90초 후 정리합니다.
- 처음에는 최근 90초 안에 접속한 참가자 6명이 모여야 게임이 시작됩니다. 시작한 뒤에는 접속 인원이 6명 미만으로 줄어도 전역 라운드가 계속됩니다. 시작 이후에도 새 참가자가 입장할 수 있고, 누구나 버튼을 누를 수 있습니다.
- 첫 번째 승인된 누름으로 전체 게임의 도전이 실패하고, 누적 실패 도전 횟수가 1 증가합니다. 누른 사람의 닉네임은 10초 동안 보여줍니다.
- 아무도 누르지 않고 60초를 보내면 모두 성공합니다. 전체 성공 횟수와 성공 날짜별 횟수(`successCountsByDate`)는 서버 내부에서 KST 날짜 기준으로 집계하지만 화면에는 성공 횟수나 라운드 번호를 표시하지 않습니다. 기존 날짜 기록이 없는 성공 총계는 마이그레이션 날짜에 귀속합니다.
- 실패 후 10초가 지나면 다음 도전을 시작합니다. 성공 후 30초가 지나면 새 도전을 시작하며 누적 실패 횟수는 유지됩니다.

## 구조

- `public/`: GitHub Pages가 게시하는 모바일·PC 단일 페이지 게임.
- `functions/engine.js`: 서버 시간으로 실행하는 순수 게임 상태 전이 로직.
- `functions/index.js`: `dontPressButton/` 전용 Cloud Functions. 참가, 실시간 presence, 버튼 판정, Cloud Tasks 타이머, 주기 복구를 처리합니다.
- `database.rules.json`: 공유 RTDB 규칙 원본은 `StreamBet-Market`이며, 규칙을 바꿀 때는 지정된 여섯 저장소 사본을 모두 동기화해야 합니다.
- `admin-center/functions/index.js`: 통합 관리 센터의 게임 목록과 접속자 분석에 등록합니다.

클라이언트의 게임 상태·참가자 데이터 직접 쓰기는 허용하지 않습니다. 브라우저는 인증된 뒤 공개 게임 상태와 공개 닉네임 목록만 실시간 구독하고, 상태 변경은 서버 함수가 수행합니다. 참가자의 Firebase UID, 닉네임 선점 정보, 버튼 재시도 영수증은 읽을 수 없는 서버 데이터에 둡니다.

## 로컬 확인

```sh
node --test functions/engine.test.js
node -c functions/engine.js
node -c functions/index.js
```

웹 화면은 정적 파일이라 저장소 루트에서 간단한 HTTP 서버로 열 수 있습니다.

```sh
python3 -m http.server 8080
```

공개 운영 전 Firebase Console에서 `soop-stock-market` 프로젝트의 익명 인증을 켜고, Cloud Tasks API와 함수 실행 서비스 계정 권한을 확인해야 합니다. 공유 RTDB 규칙은 `firebase deploy --only database --project soop-stock-market --dry-run`으로 확인한 뒤에만 반영합니다. 함수는 전체 배포하지 말고 `functions:dontpressbutton:<함수명>` 형식으로 변경한 이름만 배포합니다.

## 배포

`main`에 푸시하면 GitHub Actions가 `public/`만 GitHub Pages에 배포합니다. 기본 주소는 `https://neezu-crypto.github.io/dont-press-button/`입니다.

Cloud Functions 배포 대상:

```sh
firebase deploy --only functions:dontpressbutton:dpbJoin,functions:dontpressbutton:dpbHeartbeat,functions:dontpressbutton:dpbLeave,functions:dontpressbutton:dpbPress,functions:dontpressbutton:dpbTransition,functions:dontpressbutton:dpbTick --project soop-stock-market
```
