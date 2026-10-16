'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  DURATIONS,
  MIN_PARTICIPANTS,
  initial,
  startIfReady,
  press,
  advance,
  catchUp,
  publicState,
  successDateKey,
  migrateSuccessCountsByDate,
} = require('./engine');

function playing(now = 0, failedChallenges = 0, successCount = 0, version = 1, successCountsByDate = {}) {
  return startIfReady(
    initial(now, failedChallenges, successCount, version, successCountsByDate),
    MIN_PARTICIPANTS,
    now,
  );
}

test('the game waits for six joined participants before starting', () => {
  const waiting = initial(10, 4, 2, 7, { '2026-10-16': 2 });
  const notReady = startIfReady(waiting, MIN_PARTICIPANTS - 1, 100);

  assert.equal(waiting.phase, 'waiting');
  assert.equal(waiting.phaseEndsAt, null);
  assert.equal(press(waiting, 'a', '대기', 20, waiting.version).accepted, false);
  assert.strictEqual(notReady, waiting);

  const started = startIfReady(waiting, MIN_PARTICIPANTS, 100);
  assert.equal(started.phase, 'playing');
  assert.equal(started.startedAt, 100);
  assert.equal(started.phaseEndsAt, 100 + DURATIONS.playing);
  assert.equal(started.failedChallenges, 4);
  assert.equal(started.successCount, 2);
  assert.deepEqual(started.successCountsByDate, { '2026-10-16': 2 });
  assert.strictEqual(startIfReady(started, 0, 200), started, 'the running global game does not stop when players leave');
});

test('the first approved press records one failed challenge and only the nickname', () => {
  const start = playing(1_000);
  const result = press(start, 'private-uid', '시청자', 2_000, start.version);

  assert.equal(result.accepted, true);
  assert.equal(result.state.phase, 'failed');
  assert.equal(result.state.phaseEndsAt, 12_000);
  assert.equal(result.state.failedChallenges, 1);
  assert.equal(result.state.successCount, 0);
  assert.deepEqual(result.state.successCountsByDate, {});
  assert.deepEqual(result.state.lastPresser, { nickname: '시청자' });
  assert.equal('uid' in result.state.lastPresser, false);
  assert.equal(start.phase, 'playing', 'the pure transition must not mutate its input');
});

test('simultaneous presses count one failure and stale retries cannot affect a later attempt', () => {
  const start = playing(0);
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
  const start = playing(0);
  assert.equal(press(start, 'a', '늦음', DURATIONS.playing, start.version).accepted, false);
  const success = advance(start, DURATIONS.playing);
  assert.equal(success.phase, 'succeeded');
  assert.equal(success.failedChallenges, 0);
  assert.equal(success.successCount, 1);
});

test('success dates use the KST calendar day, including midnight', () => {
  const successAt = Date.UTC(2026, 0, 1, 15);
  const success = advance(playing(successAt - DURATIONS.playing), successAt);

  assert.equal(successDateKey(successAt), '2026-01-02');
  assert.deepEqual(success.successCountsByDate, { '2026-01-02': 1 });
});

test('catch-up aggregates each successful round under its KST date across midnight', () => {
  const start = playing(Date.UTC(2026, 0, 1, 14));
  const recovered = catchUp(start, Date.UTC(2026, 0, 2, 0, 4));

  assert.equal(recovered.successCount, 403);
  assert.deepEqual(recovered.successCountsByDate, {
    '2026-01-01': 40,
    '2026-01-02': 363,
  });
});

test('legacy success totals are backfilled to the migration date', () => {
  const migrationTime = Date.UTC(2026, 0, 1, 15);
  assert.deepEqual(migrateSuccessCountsByDate(undefined, 5, migrationTime), { '2026-01-02': 5 });
  assert.deepEqual(
    migrateSuccessCountsByDate({ '2026-01-01': 3 }, 5, migrationTime),
    { '2026-01-01': 3 },
  );
});

test('failed challenges accumulate while the game continues', () => {
  const start = playing(0);
  const firstFailure = press(start, 'a', '실패', 10, start.version).state;
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
  const start = { ...playing(0, 7, 3), failedChallenges: 7, successCount: 3 };
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
  assert.equal('successCountsByDate' in sharedState, false);
  assert.equal('round' in sharedState, false);
});

test('catch-up accounts for every overdue success and keeps failure totals', () => {
  const start = playing(0);
  const failed = press(start, 'a', '실패', 20_000, start.version).state;
  const recovered = catchUp(failed, 179_999);

  assert.equal(recovered.phase, 'playing');
  assert.equal(recovered.failedChallenges, 1);
  assert.equal(recovered.successCount, 1);
  assert.equal(recovered.phaseEndsAt, 180_000);
  assert.equal(recovered.version, failed.version + 3);
});

test('catch-up aggregates successful rounds without exposing a round counter', () => {
  const recovered = catchUp(playing(0), 200_000);

  assert.equal(recovered.phase, 'playing');
  assert.equal(recovered.failedChallenges, 0);
  assert.equal(recovered.successCount, 2);
  assert.equal(recovered.phaseEndsAt, 240_000);
});

test('catch-up is idempotent when the game is already current', () => {
  const state = playing(100);
  assert.equal(catchUp(state, state.phaseEndsAt - 1), state);
  assert.equal(catchUp(state, state.phaseEndsAt).phase, 'succeeded');
});
