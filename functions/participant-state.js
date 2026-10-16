'use strict';

function pruneActiveSessions(sessions, now, ttlMs) {
  return Object.fromEntries(Object.entries(sessions || {}).filter(([, session]) => {
    const lastSeenAt = Number(session && session.lastSeenAt);
    return Number.isFinite(lastSeenAt) && now - lastSeenAt <= ttlMs;
  }));
}

function joinParticipantRecord(current, proposed, sessionId, now, ttlMs) {
  const sessions = current && Number(current.lastSeenAt) > now - ttlMs
    ? pruneActiveSessions(current.sessions, now, ttlMs)
    : {};
  if (!Object.keys(sessions).length) return proposed;

  return {
    ...current,
    nickname: proposed.nickname,
    nicknameKey: proposed.nicknameKey,
    publicId: current.publicId || proposed.publicId,
    sessions: { ...sessions, [sessionId]: { lastSeenAt: now } },
    lastSeenAt: now,
  };
}

module.exports = { pruneActiveSessions, joinParticipantRecord };
