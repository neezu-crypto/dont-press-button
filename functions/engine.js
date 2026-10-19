'use strict';

const DURATIONS = Object.freeze({
  playing: 60_000,
  failed: 10_000,
  succeeded: 30_000,
});
const MIN_PARTICIPANTS = 6;

const DAY_MS = 24 * 60 * 60 * 1000;
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const SUCCESS_CYCLE_MS = DURATIONS.playing + DURATIONS.succeeded;

function successDateKey(timestamp) {
  const date = new Date(timestamp + KST_OFFSET_MS);
  return [
    String(date.getUTCFullYear()).padStart(4, '0'),
    String(date.getUTCMonth() + 1).padStart(2, '0'),
    String(date.getUTCDate()).padStart(2, '0'),
  ].join('-');
}

function kstDayStart(timestamp) {
  const date = new Date(timestamp + KST_OFFSET_MS);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) - KST_OFFSET_MS;
}

function isSuccessDateKey(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  return date.getUTCFullYear() === year && date.getUTCMonth() + 1 === month && date.getUTCDate() === day;
}

function normalizeSuccessCountsByDate(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const counts = {};
  for (const [date, count] of Object.entries(value)) {
    if (!isSuccessDateKey(date) || !Number.isSafeInteger(count) || count < 0) return null;
    counts[date] = count;
  }
  return counts;
}

function migrateSuccessCountsByDate(value, successCount, now) {
  const normalized = normalizeSuccessCountsByDate(value);
  if (normalized) return normalized;
  if (!Number.isSafeInteger(successCount) || successCount <= 0) return {};
  return { [successDateKey(now)]: successCount };
}

function addSuccessesByDate(value, firstAt, interval, count) {
  const source = normalizeSuccessCountsByDate(value) || {};
  if (!Number.isSafeInteger(count) || count <= 0
    || !Number.isFinite(firstAt) || !Number.isFinite(interval) || interval <= 0) return source;
  const counts = { ...source };
  const lastAt = firstAt + (count - 1) * interval;
  const firstDayStart = kstDayStart(firstAt);
  const lastDayStart = kstDayStart(lastAt);

  for (let dayStart = firstDayStart; dayStart <= lastDayStart; dayStart += DAY_MS) {
    const firstIndex = Math.max(0, Math.ceil((dayStart - firstAt) / interval));
    const lastIndex = Math.min(count - 1, Math.floor((dayStart + DAY_MS - 1 - firstAt) / interval));
    const successesOnDay = lastIndex - firstIndex + 1;
    if (successesOnDay <= 0) continue;
    const key = successDateKey(dayStart);
    counts[key] = (counts[key] || 0) + successesOnDay;
  }
  return counts;
}

function initial(now = Date.now(), failedChallenges = 0, successCount = 0, version = 1, successCountsByDate = {}) {
  return {
    phase: 'waiting',
    phaseEndsAt: null,
    startedAt: null,
    failedChallenges,
    successCount,
    successCountsByDate: normalizeSuccessCountsByDate(successCountsByDate) || {},
    lastPresser: null,
    version,
  };
}

function startIfReady(state, participantCount, now = Date.now()) {
  if (!state || state.phase !== 'waiting'
    || !Number.isSafeInteger(participantCount) || participantCount < MIN_PARTICIPANTS) return state;
  return {
    ...state,
    phase: 'playing',
    phaseEndsAt: now + DURATIONS.playing,
    startedAt: now,
    lastPresser: null,
    version: state.version + 1,
  };
}

function press(state, uid, nickname, now = Date.now(), expectedVersion = state && state.version) {
  if (!state || state.phase !== 'playing' || now >= state.phaseEndsAt || expectedVersion !== state.version) {
    return { state, accepted: false };
  }

  return {
    accepted: true,
    state: {
      ...state,
      phase: 'failed',
      phaseEndsAt: now + DURATIONS.failed,
      failedChallenges: (state.failedChallenges || 0) + 1,
      lastPresser: { nickname },
      version: state.version + 1,
    },
  };
}

function advance(state, now = Date.now()) {
  if (!state || state.phase === 'waiting' || now < state.phaseEndsAt) return state;

  if (state.phase === 'playing') {
    return {
      ...state,
      phase: 'succeeded',
      phaseEndsAt: state.phaseEndsAt + DURATIONS.succeeded,
      successCount: (state.successCount || 0) + 1,
      successCountsByDate: addSuccessesByDate(state.successCountsByDate, state.phaseEndsAt, SUCCESS_CYCLE_MS, 1),
      lastPresser: null,
      version: state.version + 1,
    };
  }

  if (state.phase === 'failed') {
    return {
      ...state,
      phase: 'playing',
      phaseEndsAt: state.phaseEndsAt + DURATIONS.playing,
      lastPresser: null,
      version: state.version + 1,
    };
  }

  if (state.phase === 'succeeded') {
    return {
      ...state,
      phase: 'playing',
      phaseEndsAt: state.phaseEndsAt + DURATIONS.playing,
      lastPresser: null,
      version: state.version + 1,
    };
  }

  throw new Error('Unknown phase: ' + state.phase);
}

function catchUp(state, now = Date.now(), maxTransitions = 10_000) {
  let next = state;
  let iterations = 0;
  while (next && Number.isFinite(next.phaseEndsAt) && now >= next.phaseEndsAt) {
    if (iterations >= maxTransitions) throw new Error('Too many overdue game transitions');
    if (next.phase === 'succeeded') {
      const completedRounds = Math.floor((now - next.phaseEndsAt) / (DURATIONS.playing + DURATIONS.succeeded));
      if (completedRounds > 0) {
        next = {
          ...next,
          phaseEndsAt: next.phaseEndsAt + completedRounds * (DURATIONS.playing + DURATIONS.succeeded),
          successCount: (next.successCount || 0) + completedRounds,
          successCountsByDate: addSuccessesByDate(
            next.successCountsByDate,
            next.phaseEndsAt + DURATIONS.playing,
            SUCCESS_CYCLE_MS,
            completedRounds,
          ),
          lastPresser: null,
          version: next.version + completedRounds * 2,
        };
      }
    }
    next = advance(next, now);
    iterations += 1;
  }
  return next;
}

function publicState(state) {
  return {
    phase: state.phase,
    phaseEndsAt: state.phase === 'waiting' ? null : state.phaseEndsAt,
    failedChallenges: state.failedChallenges,
    lastPresser: state.lastPresser ? { nickname: state.lastPresser.nickname } : null,
    version: state.version,
  };
}

module.exports = {
  DURATIONS,
  MIN_PARTICIPANTS,
  initial,
  startIfReady,
  press,
  advance,
  catchUp,
  publicState,
  successDateKey,
  normalizeSuccessCountsByDate,
  migrateSuccessCountsByDate,
};
