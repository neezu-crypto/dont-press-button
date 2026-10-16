'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { pruneActiveSessions, joinParticipantRecord } = require('./participant-state');

test('a new page session uses the submitted nickname and keeps other live tabs joined', () => {
  const current = {
    nickname: '기존닉',
    nicknameKey: 'old-key',
    publicId: 'public-id',
    lastSeenAt: 95_000,
    sessions: {
      oldTab: { lastSeenAt: 95_000 },
      closedTab: { lastSeenAt: 1_000 },
    },
  };
  const proposed = {
    nickname: '새닉네임',
    nicknameKey: 'new-key',
    publicId: 'public-id',
    joinedAt: 100_000,
    lastSeenAt: 100_000,
    sessions: { newTab: { lastSeenAt: 100_000 } },
  };

  const joined = joinParticipantRecord(current, proposed, 'newTab', 100_000, 90_000);

  assert.equal(joined.nickname, '새닉네임');
  assert.equal(joined.nicknameKey, 'new-key');
  assert.equal(joined.publicId, 'public-id');
  assert.deepEqual(joined.sessions, {
    oldTab: { lastSeenAt: 95_000 },
    newTab: { lastSeenAt: 100_000 },
  });
  assert.equal(current.nickname, '기존닉', 'the update must not mutate the old record');
});

test('joining after the presence TTL replaces the stale participant record', () => {
  const proposed = {
    nickname: '새닉네임',
    nicknameKey: 'new-key',
    publicId: 'new-public-id',
    lastSeenAt: 100_000,
    sessions: { newTab: { lastSeenAt: 100_000 } },
  };
  const joined = joinParticipantRecord({
    nickname: '기존닉',
    nicknameKey: 'old-key',
    publicId: 'old-public-id',
    lastSeenAt: 9_999,
    sessions: { oldTab: { lastSeenAt: 9_999 } },
  }, proposed, 'newTab', 100_000, 90_000);

  assert.strictEqual(joined, proposed);
});

test('session pruning drops entries older than the presence TTL', () => {
  assert.deepEqual(pruneActiveSessions({
    active: { lastSeenAt: 90_001 },
    expired: { lastSeenAt: 9_999 },
    malformed: {},
  }, 100_000, 90_000), { active: { lastSeenAt: 90_001 } });
});
