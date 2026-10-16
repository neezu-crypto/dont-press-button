'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DURATIONS, initial, press, advance, catchUp, publicState } = require('./engine');

test('the first approved press records one failed challenge and only the nickname', () => {
  const start = initial(1_000);
  const result = press(start, 'private-uid', '시청자', 2_000, start.version);

  assert.equal(result.accepted, true);
  assert.equal(result.state.phase, 'failed');
  assert.equal(result.state.phaseEndsAt, 12_000);
  assert.equal(result.state.failedChallenges, 1);
  assert.equal(result.state.successCount, 0);
  assert.deepEqual(result.state.lastPresser, { nickname: '시청자' });
  assert.equal('uid' in result.state.lastPresser, false);
  assert.equal(start.phase, 'playing', 'the pure transition must not mutate its input');
});

test('simultaneous presses count one failure and stale retries cannot affect a later attempt', () => {
  const start = initial(0);
  const winner = press(start, 'a', '먼저', 1, start.version);
  const loser = press(winner.state, 'b', '다음', 2, start.version);
  const nextAttempt = advance(winner.state, winner.state.phaseEndsAt);
  const staleRetry = press(nextAttempt, 'a', '먼저', nextAttempt.phaseEndsAt, start.version);

  assert.equal(winner.accepted, true);
  assert.equal(loser.accepted, false);
  assert.equal(staleRetry.accepted, false);
  assert.equal(nextAttempt.phase, 'playing');
  assert.equal(nextAttempt.failedChallenges, 1);
});

test('a press at or after the deadline is rejected and success is only aggregated', () => {
  const start = initial(0);
  assert.equal(press(start, 'a', '늦음', DURATIONS.playing, start.version).accepted, false);
  const success = advance(start, DURATIONS.playing);
  assert.equal(success.phase, 'succeeded');
  assert.equal(success.failedChallenges, 0);
  assert.equal(success.successCount, 1);
});

test('failed challenges accumulate while the game continues', () => {
  const firstFailure = press(initial(0), 'a', '실패', 10, 1).state;
  const next = advance(firstFailure, firstFailure.phaseEndsAt);
  const secondFailure = press(next, 'b', '실패2', firstFailure.phaseEndsAt + 1, next.version).state;

  assert.equal(advance(firstFailure, firstFailure.phaseEndsAt - 1), firstFailure);
  assert.equal(next.phase, 'playing');
  assert.equal(next.phaseEndsAt, firstFailure.phaseEndsAt + DURATIONS.playing);
  assert.equal(next.lastPresser, null);
  assert.equal(next.version, firstFailure.version + 1);
  assert.equal(secondFailure.failedChallenges, 2);
  assert.equal(secondFailure.successCount, 0);
});

test('success counts remain internal state and do not reset failed challenge totals', () => {
  const start = { ...initial(0, 7, 3), failedChallenges: 7, successCount: 3 };
  const success = advance(start, start.phaseEndsAt);
  const next = advance(success, success.phaseEndsAt);

  assert.equal(success.successCount, 4);
  assert.equal(success.failedChallenges, 7);
  assert.equal(next.phase, 'playing');
  assert.equal(next.failedChallenges, 7);
  assert.equal(next.successCount, 4);
  assert.equal(next.phaseEndsAt, 150_000);

  const sharedState = publicState(success);
  assert.equal(sharedState.failedChallenges, 7);
  assert.equal('successCount' in sharedState, false);
  assert.equal('round' in sharedState, false);
});

test('catch-up accounts for every overdue success and keeps failure totals', () => {
  const failed = press(initial(0), 'a', '실패', 20_000, 1).state;
  const recovered = catchUp(failed, 179_999);

  assert.equal(recovered.phase, 'playing');
  assert.equal(recovered.failedChallenges, 1);
  assert.equal(recovered.successCount, 1);
  assert.equal(recovered.phaseEndsAt, 180_000);
  assert.equal(recovered.version, failed.version + 3);
});

test('catch-up aggregates successful rounds without exposing a round counter', () => {
  const recovered = catchUp(initial(0), 200_000);

  assert.equal(recovered.phase, 'playing');
  assert.equal(recovered.failedChallenges, 0);
  assert.equal(recovered.successCount, 2);
  assert.equal(recovered.phaseEndsAt, 240_000);
});

test('catch-up is idempotent when the game is already current', () => {
  const state = initial(100);
  assert.equal(catchUp(state, state.phaseEndsAt - 1), state);
  assert.equal(catchUp(state, state.phaseEndsAt).phase, 'succeeded');
});
