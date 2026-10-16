'use strict';

const crypto = require('node:crypto');
const { initializeApp } = require('firebase-admin/app');
const { getDatabase } = require('firebase-admin/database');
const { getFunctions } = require('firebase-admin/functions');
const { HttpsError, onCall } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { onTaskDispatched } = require('firebase-functions/v2/tasks');
const { logger } = require('firebase-functions');
const {
  DURATIONS,
  initial,
  startIfReady,
  press,
  catchUp,
  publicState,
  normalizeSuccessCountsByDate,
  migrateSuccessCountsByDate,
} = require('./engine');
const { pruneActiveSessions, joinParticipantRecord } = require('./participant-state');

const firebaseConfig = JSON.parse(process.env.FIREBASE_CONFIG || '{}');
const projectId = firebaseConfig.projectId || process.env.GCLOUD_PROJECT;
if (projectId && process.env.FIREBASE_DATABASE_EMULATOR_HOST) {
  firebaseConfig.databaseURL = 'https://' + projectId + '-default-rtdb.firebaseio.com';
} else if (!firebaseConfig.databaseURL && projectId) {
  firebaseConfig.databaseURL = 'https://' + projectId + '-default-rtdb.firebaseio.com';
}
initializeApp(firebaseConfig);

const db = getDatabase();
const ROOT = 'dontPressButton';
const GAME_ID = 'dontPressButton';
const REGION = 'asia-northeast3';
const PRESENCE_TTL_MS = 90_000;
const HEARTBEAT_MIN_INTERVAL_MS = 15_000;
const PRESS_RECEIPT_TTL_MS = 10 * 60_000;
const MAX_STALE_PARTICIPANTS_PER_TICK = 100;
const participantRef = db.ref(ROOT + '/participants');
const nicknameIndexRef = db.ref(ROOT + '/nicknameIndex');
const publicParticipantsRef = db.ref(ROOT + '/publicParticipants');
const internalStateRef = db.ref(ROOT + '/internal/state');
const publicStateRef = db.ref(ROOT + '/state');
const transitionQueue = getFunctions().taskQueue('locations/' + REGION + '/functions/dpbTransition');

function nicknameDetails(input) {
  if (typeof input !== 'string') throw new HttpsError('invalid-argument', '닉네임을 입력하세요.');
  const nickname = input.trim().normalize('NFC');
  const length = Array.from(nickname).length;
  if (length < 2 || length > 12 || /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(nickname)) {
    throw new HttpsError('invalid-argument', '닉네임은 제어 문자를 제외한 2~12자로 입력하세요.');
  }
  const key = crypto.createHash('sha256').update(nickname.normalize('NFKC').toLocaleLowerCase('ko-KR')).digest('hex');
  return { nickname, key };
}

function sessionIdFrom(request) {
  const sessionId = request.data && request.data.sessionId;
  if (typeof sessionId !== 'string' || !/^[A-Za-z0-9_-]{20,64}$/.test(sessionId)) {
    throw new HttpsError('invalid-argument', '브라우저 세션을 확인할 수 없습니다. 새로고침 후 다시 입장하세요.');
  }
  return sessionId;
}

function requireUid(request) {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError('unauthenticated', '익명 Firebase 인증이 필요합니다.');
  return uid;
}

async function assertNotBanned(uid) {
  const snapshot = await db.ref('bannedAccounts/' + uid).get();
  const bans = snapshot.val() || {};
  const gameBan = bans.games && bans.games[GAME_ID];
  if (bans.all || gameBan) {
    const reason = bans.all ? bans.allReason : gameBan.reason;
    throw new HttpsError('permission-denied', reason ? '이용이 제한된 계정입니다: ' + reason : '이용이 제한된 계정입니다.');
  }
}

function normalizeState(current, now) {
  const successCount = Number.isSafeInteger(current && current.successCount) && current.successCount >= 0
    ? current.successCount : 0;
  const storedDateCounts = normalizeSuccessCountsByDate(current && current.successCountsByDate);
  const successCountsByDate = migrateSuccessCountsByDate(current && current.successCountsByDate, successCount, now);
  const failedChallenges = Number.isSafeInteger(current && current.failedChallenges) && current.failedChallenges >= 0
    ? current.failedChallenges : 0;
  const version = Number(current && current.version);
  const nextVersion = Number.isSafeInteger(version) && version > 0 ? version + 1 : 1;

  if (!current) return initial(now);
  if (!['waiting', 'playing', 'failed', 'succeeded'].includes(current.phase)) {
    const reset = initial(now, failedChallenges, successCount, nextVersion, successCountsByDate);
    reset.acceptedPresses = current.acceptedPresses && typeof current.acceptedPresses === 'object' ? current.acceptedPresses : {};
    return reset;
  }

  const isWaiting = current.phase === 'waiting';
  const phaseEndsAt = isWaiting ? null : Number(current.phaseEndsAt);
  const startedAt = Number(current.startedAt);

  // Existing live games predate the six-player lobby. Preserve their totals, then wait for a fresh start.
  if (!isWaiting && !Number.isFinite(startedAt)) {
    const reset = initial(now, failedChallenges, successCount, nextVersion, successCountsByDate);
    reset.acceptedPresses = current.acceptedPresses && typeof current.acceptedPresses === 'object' ? current.acceptedPresses : {};
    return reset;
  }

  const validPhaseTiming = isWaiting
    ? current.phaseEndsAt == null && current.startedAt == null
    : Number.isFinite(phaseEndsAt) && Number.isFinite(startedAt);
  const expectedFieldsExist = validPhaseTiming
    && Number.isSafeInteger(failedChallenges) && failedChallenges >= 0
    && Number.isSafeInteger(successCount) && successCount >= 0
    && storedDateCounts !== null
    && Number.isSafeInteger(version) && version > 0;
  if (expectedFieldsExist) return current;

  const duration = current.phase === 'playing' ? DURATIONS.playing
    : current.phase === 'failed' ? DURATIONS.failed : DURATIONS.succeeded;
  return {
    phase: current.phase,
    phaseEndsAt: isWaiting ? null : Number.isFinite(phaseEndsAt) ? phaseEndsAt : now + duration,
    startedAt: isWaiting ? null : startedAt,
    failedChallenges,
    successCount,
    successCountsByDate,
    lastPresser: !isWaiting && current.lastPresser && typeof current.lastPresser.nickname === 'string'
      ? { nickname: current.lastPresser.nickname } : null,
    version: Number.isSafeInteger(version) && version > 0 ? version + 1 : 1,
    acceptedPresses: current.acceptedPresses && typeof current.acceptedPresses === 'object' ? current.acceptedPresses : {},
  };
}

function prunePressReceipts(receipts, now) {
  const next = {};
  Object.entries(receipts || {}).forEach(([key, at]) => {
    if (Number.isFinite(at) && now - at <= PRESS_RECEIPT_TTL_MS) next[key] = at;
  });
  return next;
}

async function publishState(state) {
  if (!state) return;
  const next = publicState(state);
  await publicStateRef.transaction((current) => {
    if (current && Number(current.version) >= next.version) return;
    return next;
  });
}

async function scheduleTransition(state) {
  if (!state || state.phase === 'waiting' || !Number.isSafeInteger(state.version) || !Number.isFinite(state.phaseEndsAt)) return;
  const taskId = crypto.createHash('sha256')
    .update('dontPressButton:' + state.version + ':' + state.phaseEndsAt)
    .digest('hex');
  try {
    await transitionQueue.enqueue({ expectedVersion: state.version }, {
      id: taskId,
      scheduleTime: new Date(Math.max(Date.now() + 1_000, state.phaseEndsAt)),
      dispatchDeadlineSeconds: 60,
    });
  } catch (error) {
    if (error.code === 'functions/task-already-exists') return;
    // dpbTick is the recovery path if Cloud Tasks is temporarily unavailable.
    logger.error('Could not enqueue game phase transition', { version: state.version, error });
  }
}

async function countOnlineParticipants(now) {
  const cutoff = now - PRESENCE_TTL_MS;
  const snapshot = await participantRef.orderByChild('lastSeenAt').startAt(cutoff).get();
  return Object.values(snapshot.val() || {}).filter((participant) => Number(participant.lastSeenAt) > cutoff).length;
}

async function ensureState() {
  const now = Date.now();
  const participantCount = await countOnlineParticipants(now);
  const result = await internalStateRef.transaction((current) => {
    const normalized = current ? normalizeState(current, now) : initial(now);
    const ready = startIfReady(normalized, participantCount, now);
    return ready === current ? undefined : ready;
  });
  const state = normalizeState(result.snapshot.val(), now);
  await publishState(state);
  if (result.committed) await scheduleTransition(state);
  return state;
}

async function reserveNickname(key, uid, publicId) {
  return nicknameIndexRef.child(key).transaction((current) => {
    const ownerUid = typeof current === 'string' ? current : current && current.uid;
    if (ownerUid && ownerUid !== uid) return;
    return { uid, publicId };
  });
}

async function releaseNickname(key, uid, publicId) {
  if (!key) return;
  await nicknameIndexRef.child(key).transaction((current) => {
    if (!current) return null;
    const ownerUid = typeof current === 'string' ? current : current && current.uid;
    const ownerPublicId = current && typeof current === 'object' ? current.publicId : null;
    return ownerUid === uid && (!ownerPublicId || ownerPublicId === publicId) ? null : undefined;
  });
}

function participantRecord(nickname, key, sessionId, now, publicId = crypto.randomBytes(12).toString('hex')) {
  return {
    nickname,
    nicknameKey: key,
    publicId,
    joinedAt: now,
    lastSeenAt: now,
    sessions: { [sessionId]: { lastSeenAt: now } },
  };
}

async function setPublicPresence(uid, participant) {
  if (!participant || !participant.publicId || !participant.nickname) return;
  await Promise.all([
    publicParticipantsRef.child(participant.publicId).set({
      nickname: participant.nickname,
      lastSeenAt: participant.lastSeenAt,
    }),
    db.ref('presence/' + GAME_ID + '/' + uid).set({ lastSeen: participant.lastSeenAt }),
  ]);
}

async function clearPublicPresence(uid, participant) {
  await Promise.all([
    participant && participant.publicId
      ? publicParticipantsRef.child(participant.publicId).remove()
      : Promise.resolve(),
    db.ref('presence/' + GAME_ID + '/' + uid).remove(),
  ]);
}

async function refreshSession(uid, sessionId) {
  const ref = participantRef.child(uid);
  const now = Date.now();
  const before = await ref.get();
  const current = before.val();
  if (!current || !current.sessions || !current.sessions[sessionId]) return null;
  if (now - Number(current.sessions[sessionId].lastSeenAt) > PRESENCE_TTL_MS) return null;

  const result = await ref.transaction((latest) => {
    if (!latest) return null;
    if (!latest.sessions || !latest.sessions[sessionId]) return;
    const lastSeenAt = Number(latest.sessions[sessionId].lastSeenAt) || 0;
    if (now - lastSeenAt > PRESENCE_TTL_MS) return;
    if (now - lastSeenAt < HEARTBEAT_MIN_INTERVAL_MS) return;
    const sessions = { ...pruneActiveSessions(latest.sessions, now, PRESENCE_TTL_MS), [sessionId]: { lastSeenAt: now } };
    return { ...latest, sessions, lastSeenAt: now };
  });
  const participant = result.snapshot.val();
  if (!participant || !participant.sessions || !participant.sessions[sessionId]) return null;
  if (result.committed) await setPublicPresence(uid, participant);
  return participant;
}

async function removeSession(uid, sessionId) {
  const ref = participantRef.child(uid);
  const before = (await ref.get()).val();
  if (!before || !before.sessions || !before.sessions[sessionId]) {
    if (before && !Object.keys(before.sessions || {}).length) await clearPublicPresence(uid, before);
    return before;
  }
  const now = Date.now();
  const result = await ref.transaction((current) => {
    if (!current) return null;
    if (current.publicId !== before.publicId || !current.sessions || !current.sessions[sessionId]) return;
    const sessions = { ...current.sessions };
    delete sessions[sessionId];
    if (!Object.keys(sessions).length) {
      return { ...current, sessions: {}, lastSeenAt: now - PRESENCE_TTL_MS - 1, leftAt: now };
    }
    const lastSeenAt = Math.max(...Object.values(sessions).map((session) => Number(session.lastSeenAt) || 0));
    return { ...current, sessions, lastSeenAt };
  });
  const participant = result.snapshot.val();
  if (!participant || !Object.keys(participant.sessions || {}).length) {
    await clearPublicPresence(uid, before);
  } else if (result.committed) {
    await setPublicPresence(uid, participant);
  }
  return participant;
}

async function reapStaleParticipants(now) {
  const cutoff = now - PRESENCE_TTL_MS;
  const staleSnapshot = await participantRef.orderByChild('lastSeenAt').endAt(cutoff)
    .limitToFirst(MAX_STALE_PARTICIPANTS_PER_TICK).get();
  const stale = staleSnapshot.val() || {};
  await Promise.all(Object.entries(stale).map(async ([uid, oldParticipant]) => {
    const ref = participantRef.child(uid);
    const result = await ref.transaction((current) => {
      if (!current) return null;
      if (Number(current.lastSeenAt) > cutoff) return;
      return null;
    });
    if (!result.committed) return;
    await Promise.all([
      releaseNickname(oldParticipant.nicknameKey, uid, oldParticipant.publicId),
      clearPublicPresence(uid, oldParticipant),
    ]);
  }));
}

exports.dpbJoin = onCall({ region: REGION }, async (request) => {
  const uid = requireUid(request);
  await assertNotBanned(uid);
  const sessionId = sessionIdFrom(request);
  const proposal = nicknameDetails(request.data && request.data.nickname);
  const now = Date.now();
  const ref = participantRef.child(uid);
  const oldParticipant = (await ref.get()).val();
  const oldParticipantIsActive = oldParticipant && Number(oldParticipant.lastSeenAt) > now - PRESENCE_TTL_MS;
  const proposed = participantRecord(
    proposal.nickname,
    proposal.key,
    sessionId,
    now,
    oldParticipantIsActive ? oldParticipant.publicId : undefined,
  );
  const initialReservation = await reserveNickname(proposal.key, uid, proposed.publicId);
  if (!initialReservation.committed) {
    throw new HttpsError('already-exists', '이미 다른 참가자가 사용 중인 닉네임입니다.');
  }

  const joined = await ref.transaction((current) => joinParticipantRecord(
    current,
    proposed,
    sessionId,
    now,
    PRESENCE_TTL_MS,
  ));
  const participant = joined.snapshot.val();
  if (!participant) throw new HttpsError('internal', '참가 정보를 저장하지 못했습니다. 다시 입장해 주세요.');

  const reservation = await reserveNickname(participant.nicknameKey, uid, participant.publicId);
  if (!reservation.committed) {
    throw new HttpsError('already-exists', '이미 다른 참가자가 사용 중인 닉네임입니다.');
  }

  if (oldParticipant && oldParticipant.nicknameKey && oldParticipant.nicknameKey !== participant.nicknameKey) {
    await releaseNickname(oldParticipant.nicknameKey, uid, oldParticipant.publicId);
  }
  if (oldParticipant && oldParticipant.publicId && oldParticipant.publicId !== participant.publicId) {
    await publicParticipantsRef.child(oldParticipant.publicId).remove();
  }

  await setPublicPresence(uid, participant);
  const state = await ensureState();
  return { nickname: participant.nickname, phaseVersion: state.version };
});

exports.dpbHeartbeat = onCall({ region: REGION }, async (request) => {
  const uid = requireUid(request);
  await assertNotBanned(uid);
  const sessionId = sessionIdFrom(request);
  const participant = await refreshSession(uid, sessionId);
  if (!participant) throw new HttpsError('failed-precondition', '참가 세션이 만료되었습니다. 닉네임을 확인하고 다시 입장해 주세요.');
  return { ok: true, lastSeenAt: participant.lastSeenAt };
});

exports.dpbLeave = onCall({ region: REGION }, async (request) => {
  const uid = requireUid(request);
  const sessionId = sessionIdFrom(request);
  const participant = await removeSession(uid, sessionId);
  if (participant && !Object.keys(participant.sessions || {}).length) {
    await releaseNickname(participant.nicknameKey, uid, participant.publicId);
  }
  return { ok: true };
});

exports.dpbPress = onCall({ region: REGION }, async (request) => {
  const uid = requireUid(request);
  await assertNotBanned(uid);
  const sessionId = sessionIdFrom(request);
  const expectedVersion = Number(request.data && request.data.version);
  const requestId = request.data && request.data.requestId;
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1
    || typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{20,64}$/.test(requestId)) {
    throw new HttpsError('invalid-argument', '버튼 요청 정보를 확인할 수 없습니다. 다시 눌러 주세요.');
  }

  const participantSnapshot = await participantRef.child(uid).get();
  const participant = participantSnapshot.val();
  const session = participant && participant.sessions && participant.sessions[sessionId];
  const now = Date.now();
  if (!participant || !session || now - Number(session.lastSeenAt) > PRESENCE_TTL_MS) {
    throw new HttpsError('failed-precondition', '먼저 닉네임을 등록하고 입장해 주세요.');
  }

  const receiptKey = crypto.createHash('sha256').update(uid + ':' + requestId).digest('hex');
  const transaction = await internalStateRef.transaction((current) => {
    const coldCache = !current;
    const existing = normalizeState(current, now);
    const next = catchUp(existing, now);
    const receipts = prunePressReceipts(existing.acceptedPresses, now);
    const receiptCountChanged = Object.keys(receipts).length !== Object.keys(existing.acceptedPresses || {}).length;
    if (receipts[receiptKey]) {
      return next.version !== existing.version || existing !== current || receiptCountChanged
        ? { ...next, acceptedPresses: receipts }
        : coldCache ? next : undefined;
    }

    const result = press(next, uid, participant.nickname, now, expectedVersion);
    if (result.accepted) {
      receipts[receiptKey] = now;
      return { ...result.state, acceptedPresses: receipts };
    }
    if (next.version !== existing.version || existing !== current || receiptCountChanged) {
      return { ...next, acceptedPresses: receipts };
    }
    return coldCache ? next : undefined;
  });

  const state = normalizeState(transaction.snapshot.val(), now);
  await Promise.all([
    publishState(state),
    ...(transaction.committed ? [scheduleTransition(state)] : []),
  ]);
  const receipts = state.acceptedPresses || {};
  return { accepted: Object.prototype.hasOwnProperty.call(receipts, receiptKey), phaseVersion: state.version };
});

exports.dpbTransition = onTaskDispatched({
  region: REGION,
  retryConfig: { maxAttempts: 8, minBackoffSeconds: 5, maxBackoffSeconds: 60 },
  rateLimits: { maxConcurrentDispatches: 1 },
}, async (request) => {
  const expectedVersion = Number(request.data && request.data.expectedVersion);
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
    logger.warn('Ignoring malformed game transition task', { data: request.data });
    return;
  }
  const now = Date.now();
  const transaction = await internalStateRef.transaction((current) => {
    if (!current) return initial(now);
    if (Number(current.version) !== expectedVersion) return;
    const state = normalizeState(current, now);
    const next = catchUp(state, now);
    return next === current ? undefined : next;
  });
  const state = transaction.snapshot.val();
  if (!state) return;
  const normalized = normalizeState(state, now);
  if (transaction.committed) await publishState(normalized);
  await scheduleTransition(normalized);
});

exports.dpbTick = onSchedule({
  schedule: 'every 1 minutes',
  timeZone: 'Asia/Seoul',
  region: REGION,
}, async () => {
  const now = Date.now();
  await reapStaleParticipants(now);
  const participantCount = await countOnlineParticipants(now);
  const transaction = await internalStateRef.transaction((current) => {
    const state = current ? normalizeState(current, now) : initial(now);
    const recovered = catchUp(state, now);
    const ready = startIfReady(recovered, participantCount, now);
    return ready === current ? undefined : ready;
  });
  const state = normalizeState(transaction.snapshot.val(), now);
  await Promise.all([publishState(state), scheduleTransition(state)]);
});
