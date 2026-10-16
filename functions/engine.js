'use strict';

const DURATIONS = Object.freeze({
  playing: 60_000,
  failed: 10_000,
  succeeded: 30_000,
});

function initial(now = Date.now(), failedChallenges = 0, successCount = 0, version = 1) {
  return {
    phase: 'playing',
    phaseEndsAt: now + DURATIONS.playing,
    failedChallenges,
    successCount,
    lastPresser: null,
    version,
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
  if (!state || now < state.phaseEndsAt) return state;

  if (state.phase === 'playing') {
    return {
      ...state,
      phase: 'succeeded',
      phaseEndsAt: state.phaseEndsAt + DURATIONS.succeeded,
      successCount: (state.successCount || 0) + 1,
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
  while (next && now >= next.phaseEndsAt) {
    if (iterations >= maxTransitions) throw new Error('Too many overdue game transitions');
    if (next.phase === 'succeeded') {
      const completedRounds = Math.floor((now - next.phaseEndsAt) / (DURATIONS.playing + DURATIONS.succeeded));
      if (completedRounds > 0) {
        next = {
          ...next,
          phaseEndsAt: next.phaseEndsAt + completedRounds * (DURATIONS.playing + DURATIONS.succeeded),
          successCount: (next.successCount || 0) + completedRounds,
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
    phaseEndsAt: state.phaseEndsAt,
    failedChallenges: state.failedChallenges,
    lastPresser: state.lastPresser ? { nickname: state.lastPresser.nickname } : null,
    version: state.version,
  };
}

module.exports = { DURATIONS, initial, press, advance, catchUp, publicState };
