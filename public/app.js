import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-app.js';
import { connectAuthEmulator, getAuth, onAuthStateChanged, signInAnonymously } from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-auth.js';
import { connectDatabaseEmulator, getDatabase, onValue, ref } from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-database.js';
import { connectFunctionsEmulator, getFunctions, httpsCallable } from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-functions.js';

const firebaseConfig = {
  apiKey: 'AIzaSyAZcjQPHphENs-Bb7IfdL2qTtOMhJrRP54',
  authDomain: 'soop-stock-market.firebaseapp.com',
  databaseURL: 'https://soop-stock-market-default-rtdb.firebaseio.com',
  projectId: 'soop-stock-market',
  storageBucket: 'soop-stock-market.firebasestorage.app',
  messagingSenderId: '997788925900',
  appId: '1:997788925900:web:b58db2970489bf18a3a769',
};

const REGION = 'asia-northeast3';
const MIN_PARTICIPANTS = 6;
const PRESENCE_HEARTBEAT_MS = 25_000;
const PRESENCE_TTL_MS = 90_000;
const STATE_PATH = 'dontPressButton/state';
const PEOPLE_PATH = 'dontPressButton/publicParticipants';
const GAME_DURATIONS = { playing: 60_000, failed: 10_000, succeeded: 30_000 };

const isLocalEmulator = ['localhost', '127.0.0.1'].includes(window.location.hostname);
const activeFirebaseConfig = isLocalEmulator
  ? { ...firebaseConfig, apiKey: 'demo-api-key', projectId: 'demo-dont-press-button', databaseURL: 'https://demo-dont-press-button-default-rtdb.firebaseio.com' }
  : firebaseConfig;
const app = initializeApp(activeFirebaseConfig);
const auth = getAuth(app);
const database = getDatabase(app);
const functions = getFunctions(app, REGION);
if (isLocalEmulator) {
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  connectDatabaseEmulator(database, '127.0.0.1', 9000);
  connectFunctionsEmulator(functions, '127.0.0.1', 5001);
}
const joinParticipant = httpsCallable(functions, 'dpbJoin');
const sendHeartbeat = httpsCallable(functions, 'dpbHeartbeat');
const leaveParticipant = httpsCallable(functions, 'dpbLeave');
const pressButton = httpsCallable(functions, 'dpbPress');

const elements = {
  connectionState: document.querySelector('#connectionState'),
  connectionLabel: document.querySelector('#connectionLabel'),
  phaseTitle: document.querySelector('#phaseTitle'),
  phaseMessage: document.querySelector('#phaseMessage'),
  timerRing: document.querySelector('#timerRing'),
  timerCaption: document.querySelector('#timerCaption'),
  countdown: document.querySelector('#countdown'),
  failedChallenges: document.querySelector('#failedChallenges'),
  participantCount: document.querySelector('#participantCount'),
  participantSummary: document.querySelector('#participantSummary'),
  participantList: document.querySelector('#participantList'),
  pressButton: document.querySelector('#pressButton'),
  actionMessage: document.querySelector('#actionMessage'),
  nicknameButton: document.querySelector('#nicknameButton'),
  nicknameDialog: document.querySelector('#nicknameDialog'),
  nicknameForm: document.querySelector('#nicknameForm'),
  nicknameInput: document.querySelector('#nicknameInput'),
  nicknameError: document.querySelector('#nicknameError'),
  joinButton: document.querySelector('#joinButton'),
};

let user = null;
let gameState = null;
let participantData = {};
let activeParticipantCount = 0;
let isJoined = false;
let isConnected = false;
let isPressPending = false;
let serverTimeOffset = 0;
let heartbeatTimer = null;
let subscriptionsStarted = false;
let authSignInStarted = false;
let lastAnnouncedVersion = null;

function createSessionId() {
  return globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

try { localStorage.removeItem('dontPressButton.nickname'); } catch { /* Storage can be unavailable in private browsing. */ }
try { sessionStorage.removeItem('dontPressButton.sessionId'); } catch { /* Storage can be unavailable in private browsing. */ }
const sessionId = createSessionId();

function setActionMessage(message, isError = false) {
  elements.actionMessage.textContent = message;
  elements.actionMessage.dataset.error = String(isError);
}

function setConnected(connected) {
  isConnected = connected;
  elements.connectionState.dataset.connected = String(connected);
  elements.connectionLabel.textContent = connected ? '실시간 연결됨' : '연결 확인 중';
  renderGame();
}

function renderParticipants() {
  const now = Date.now() + serverTimeOffset;
  const people = Object.values(participantData || {})
    .filter((person) => person && typeof person.nickname === 'string'
      && Number(person.lastSeenAt) > now - PRESENCE_TTL_MS)
    .sort((a, b) => a.nickname.localeCompare(b.nickname, 'ko'));
  const count = people.length;
  activeParticipantCount = count;
  elements.participantCount.textContent = `${count.toLocaleString('ko-KR')}명`;
  elements.participantSummary.replaceChildren();
  const dot = document.createElement('span');
  dot.className = 'live-pulse';
  dot.setAttribute('aria-hidden', 'true');
  const label = document.createElement('span');
  label.textContent = `접속자 ${count.toLocaleString('ko-KR')}명`;
  elements.participantSummary.append(dot, label);

  elements.participantList.replaceChildren();
  if (!count) {
    const empty = document.createElement('span');
    empty.className = 'empty-people';
    empty.textContent = '닉네임을 정하고 첫 참가자로 입장해 주세요';
    elements.participantList.append(empty);
    return;
  }

  const visiblePeople = people.slice(0, 24);
  visiblePeople.forEach((person) => {
    const chip = document.createElement('span');
    chip.className = 'participant-chip';
    chip.textContent = person.nickname;
    elements.participantList.append(chip);
  });
  if (count > visiblePeople.length) {
    const more = document.createElement('span');
    more.className = 'more-people';
    more.textContent = `외 ${count - visiblePeople.length}명`;
    elements.participantList.append(more);
  }
}

function formatCountdown(milliseconds) {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function renderGame() {
  if (!gameState) {
    document.body.dataset.phase = 'loading';
    elements.phaseTitle.textContent = '새로운 도전을 준비하고 있습니다';
    elements.phaseMessage.textContent = '전 세계 참가자가 같은 라운드에서 만납니다.';
    elements.countdown.textContent = '--:--';
    elements.pressButton.disabled = true;
    return;
  }

  const phase = ['waiting', 'playing', 'failed', 'succeeded'].includes(gameState.phase) ? gameState.phase : 'loading';
  if (phase === 'waiting') {
    const moreParticipants = Math.max(0, MIN_PARTICIPANTS - activeParticipantCount);
    document.body.dataset.phase = phase;
    elements.failedChallenges.textContent = `${(gameState.failedChallenges || 0).toLocaleString('ko-KR')}회`;
    elements.countdown.textContent = '--:--';
    elements.timerRing.style.setProperty('--progress', '0');
    elements.timerCaption.textContent = '시작 대기 중';
    elements.phaseTitle.textContent = `${MIN_PARTICIPANTS}명이 모이면 시작합니다`;
    elements.phaseMessage.textContent = `현재 ${activeParticipantCount}명 접속 · ${moreParticipants}명 더 입장하면 첫 도전이 시작됩니다.`;
    setActionMessage(isJoined ? '함께할 참가자를 기다리고 있습니다.' : '닉네임을 정하고 입장하면 참가자 수에 포함됩니다.');
    elements.pressButton.disabled = true;
    elements.pressButton.setAttribute('aria-label', '참가자 6명이 모일 때까지 시작을 기다리는 중');
    if (gameState.version !== lastAnnouncedVersion) lastAnnouncedVersion = gameState.version;
    return;
  }

  const now = Date.now() + serverTimeOffset;
  const remaining = Math.max(0, Number(gameState.phaseEndsAt) - now);
  const duration = GAME_DURATIONS[phase] || GAME_DURATIONS.playing;
  const secondsLeft = Math.ceil(remaining / 1000);
  document.body.dataset.phase = phase;
  elements.failedChallenges.textContent = `${(gameState.failedChallenges || 0).toLocaleString('ko-KR')}회`;
  elements.countdown.textContent = formatCountdown(remaining);
  elements.timerRing.style.setProperty('--progress', String(Math.min(1, remaining / duration)));

  if (phase === 'playing') {
    elements.phaseTitle.textContent = '누르면 모두 실패합니다';
    elements.phaseMessage.textContent = secondsLeft > 0
      ? '아무도 누르지 않으면 이번 도전은 모두의 성공입니다.'
      : '도전 시간이 끝났습니다. 서버가 결과를 확인하고 있습니다.';
    elements.timerCaption.textContent = '남은 시간';
    setActionMessage(isJoined ? '화면을 열어 둔 채 함께 버텨보세요.' : '참여하려면 닉네임을 먼저 설정하세요.');
  } else if (phase === 'failed') {
    const name = gameState.lastPresser && gameState.lastPresser.nickname;
    elements.phaseTitle.textContent = '누군가 버튼을 눌렀습니다';
    elements.phaseMessage.textContent = name ? `${name}님의 누름으로 모두의 도전이 끝났습니다.` : '이번 도전은 여기서 마무리됐습니다.';
    elements.timerCaption.textContent = '다음 도전까지';
    setActionMessage('잠시 후 다음 도전이 시작됩니다.');
  } else {
    elements.phaseTitle.textContent = '모두가 버텨냈습니다';
    elements.phaseMessage.textContent = '60초 동안 아무도 버튼을 누르지 않아 모두 성공했습니다.';
    elements.timerCaption.textContent = '새 라운드까지';
    setActionMessage('새 라운드를 준비하고 있습니다.');
  }

  elements.pressButton.disabled = !isJoined || !isConnected || isPressPending || phase !== 'playing' || secondsLeft <= 0;
  elements.pressButton.setAttribute('aria-label', phase === 'playing' ? '누르면 모두 실패하는 빨간 버튼' : '현재는 누를 수 없는 버튼');

  if (gameState.version !== lastAnnouncedVersion) {
    lastAnnouncedVersion = gameState.version;
    if (phase === 'failed') elements.phaseMessage.setAttribute('aria-live', 'polite');
    else elements.phaseMessage.setAttribute('aria-live', 'off');
  }
}

function startSubscriptions() {
  if (subscriptionsStarted) return;
  subscriptionsStarted = true;
  onValue(ref(database, '.info/connected'), (snapshot) => setConnected(snapshot.val() === true));
  onValue(ref(database, '.info/serverTimeOffset'), (snapshot) => {
    serverTimeOffset = Number(snapshot.val()) || 0;
    renderGame();
    renderParticipants();
  });
  onValue(ref(database, STATE_PATH), (snapshot) => {
    gameState = snapshot.val();
    renderGame();
  }, (error) => {
    setActionMessage('게임 상태를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.', true);
    console.error('Game state subscription failed', error);
  });
  onValue(ref(database, PEOPLE_PATH), (snapshot) => {
    participantData = snapshot.val() || {};
    renderParticipants();
  }, (error) => {
    console.error('Participant subscription failed', error);
  });
}

async function joinWithNickname(nickname) {
  if (!user) throw new Error('익명 인증이 끝나면 다시 입장할 수 있습니다.');
  const characterCount = Array.from(nickname.trim()).length;
  if (characterCount < 2 || characterCount > 12) {
    throw new Error('닉네임은 2~12자로 입력해 주세요.');
  }

  elements.joinButton.disabled = true;
  elements.nicknameError.textContent = '';
  try {
    const result = await joinParticipant({ nickname, sessionId });
    const savedNickname = result.data.nickname;
    isJoined = true;
    startHeartbeat();
    elements.nicknameDialog.close();
    setActionMessage(`${savedNickname}님, 전 세계 참가자와 함께 도전합니다.`);
    renderGame();
  } finally {
    elements.joinButton.disabled = false;
  }
}

function startHeartbeat() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(() => { sendPresenceHeartbeat(); }, PRESENCE_HEARTBEAT_MS);
  sendPresenceHeartbeat();
}

async function sendPresenceHeartbeat() {
  if (!isJoined || !user || !isConnected) return;
  try {
    await sendHeartbeat({ sessionId });
  } catch (error) {
    if (error.code === 'functions/failed-precondition') {
      isJoined = false;
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      heartbeatTimer = null;
      elements.nicknameInput.value = '';
      if (!elements.nicknameDialog.open) elements.nicknameDialog.showModal();
      setActionMessage('참가 세션이 만료되어 다시 입장해야 합니다.', true);
      renderGame();
    } else if (error.code === 'functions/permission-denied') {
      isJoined = false;
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      heartbeatTimer = null;
      setActionMessage(error.message || '이용이 제한된 계정입니다.', true);
      renderGame();
    } else {
      console.warn('Heartbeat will retry', error);
    }
  }
}

async function leaveCurrentSession() {
  const wasJoined = isJoined;
  isJoined = false;
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
  renderGame();
  if (!user || !wasJoined) return;
  try { await leaveParticipant({ sessionId }); } catch (error) { console.warn('Presence will expire automatically', error); }
}

async function changeNickname() {
  if (isJoined) await leaveCurrentSession();
  elements.nicknameInput.value = '';
  elements.nicknameError.textContent = '';
  if (!elements.nicknameDialog.open) elements.nicknameDialog.showModal();
  elements.nicknameInput.focus();
}

elements.nicknameForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    await joinWithNickname(elements.nicknameInput.value);
  } catch (error) {
    elements.nicknameError.textContent = error.message || '입장할 수 없습니다. 잠시 후 다시 시도해 주세요.';
    console.error('Join failed', error);
  }
});

elements.pressButton.addEventListener('click', async () => {
  if (!isJoined || !isConnected || isPressPending || !gameState || gameState.phase !== 'playing') return;
  isPressPending = true;
  renderGame();
  try {
    const result = await pressButton({
      sessionId,
      version: gameState.version,
      requestId: globalThis.crypto.randomUUID(),
    });
    setActionMessage(result.data.accepted ? '버튼이 눌렸습니다. 이번 도전은 모두 실패했습니다.' : '이미 도전 상태가 바뀌어 버튼을 반영하지 않았습니다.');
  } catch (error) {
    setActionMessage(error.message || '버튼 요청을 처리하지 못했습니다. 다시 연결한 뒤 시도해 주세요.', true);
    if (error.code === 'functions/failed-precondition') await sendPresenceHeartbeat();
    console.error('Press failed', error);
  } finally {
    isPressPending = false;
    renderGame();
  }
});

elements.nicknameButton.addEventListener('click', () => { changeNickname(); });
elements.nicknameDialog.addEventListener('cancel', (event) => event.preventDefault());
elements.nicknameDialog.addEventListener('close', () => {
  if (!isJoined) elements.nicknameDialog.showModal();
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') sendPresenceHeartbeat();
});
window.addEventListener('pagehide', () => { leaveCurrentSession(); });
window.addEventListener('beforeunload', () => { leaveCurrentSession(); });
setInterval(renderGame, 200);
setInterval(renderParticipants, 1_000);

onAuthStateChanged(auth, async (currentUser) => {
  if (!currentUser) {
    if (authSignInStarted) return;
    authSignInStarted = true;
    try { await signInAnonymously(auth); } catch (error) {
      setActionMessage('익명 인증을 시작하지 못했습니다. 잠시 후 새로고침해 주세요.', true);
      elements.connectionLabel.textContent = '로그인 실패';
      console.error('Anonymous sign-in failed', error);
    }
    return;
  }

  if (user && user.uid === currentUser.uid) return;
  user = currentUser;
  startSubscriptions();
  elements.nicknameInput.value = '';
  elements.nicknameDialog.showModal();
  elements.nicknameInput.focus();
});
