'use strict';
const { waitForInstallSettlement, isNativeModId } = require('./install-settlement.cjs');

function flagsReady(flags, pkg) {
  if (!flags || typeof flags !== 'object' || Array.isArray(flags)
      || !pkg || !isNativeModId(pkg.expectedModId) || typeof pkg.expectedEnabled !== 'boolean'
      || !Array.isArray(pkg.oldEnabledModIds) || !pkg.oldEnabledModIds.every(isNativeModId)) return false;
  const current = flags[pkg.expectedModId];
  const valid = row => row === undefined || row && typeof row === 'object' && !Array.isArray(row) && typeof row.enabled === 'boolean';
  return valid(current) && (pkg.expectedEnabled ? current?.enabled === true : current === undefined || current.enabled === false)
    && pkg.oldEnabledModIds.every(id => valid(flags[id]) && flags[id]?.enabled === false);
}
function wait({ guard, read, record, sleep, now, pkg, expectedSize,
  expectedDownloadId, expectedType, timeoutMs, quietMs, pollMs, sizeSource } = {}) {
  return waitForInstallSettlement({ expected: { record: { id: pkg?.expectedModId,
    archiveId: expectedDownloadId, installationPath: pkg?.expectedModId, type: expectedType },
    bytes: expectedSize, enabled: pkg?.expectedEnabled, disabledModIds: pkg?.oldEnabledModIds },
    assertOperationalState: guard, read, record, sleep, now, timeoutMs, quietMs, pollMs, sizeSource });
}
// The holder belongs to one source-reviewed operation, not a request argument.
// Failure stays sticky: native retry callbacks must not become permitted when
// the caller unwinds or its lease expires. Only retirement/reconciliation ends it.
function createNativeStopBoundary({ api, gameId, profileId, downloadIds, collectionOwnerId = null,
  assertOwned, record, ProcessCanceled } = {}) {
  const ids = new Set(downloadIds);
  if (typeof gameId !== 'string' || typeof profileId !== 'string' || !Array.isArray(downloadIds)
      || ids.size !== downloadIds.length || ids.size < 1 || ids.size > 4
      || !downloadIds.every(id => typeof id === 'string' && id.length > 0)
      || typeof assertOwned !== 'function' || typeof record !== 'function' || typeof ProcessCanceled !== 'function'
      || collectionOwnerId !== null && (typeof collectionOwnerId !== 'string' || !collectionOwnerId))
    throw Error('NATIVE_STOP_SCOPE_REQUIRED');
  let failure = null, pauseRequested = false, pauseUnavailable = false;
  const canceled = () => new ProcessCanceled('NATIVE_OPERATION_HELD_RECONCILE');
  function fail(error) {
    if (failure) return canceled();
    failure = error instanceof Error ? error : Error('NATIVE_OPERATION_FAILED');
    // A direct tracked install has no collection owner. Never guess one.
    if (collectionOwnerId === null) { pauseUnavailable = true; return canceled(); }
    try {
      assertOwned();
      const session = api?.getState?.().session?.collections?.activeSession;
      if (session?.collectionId !== collectionOwnerId || session.gameId !== gameId || session.profileId !== profileId)
        throw Error('NATIVE_PAUSE_SESSION_CHANGED');
      record('native-pause-request-intent', { gameId, profileId, collectionOwnerId, noReplay: true, pauseCompletionProven: false });
      assertOwned(); pauseRequested = true;
      api.events.emit('pause-collection', gameId, collectionOwnerId, 'user');
      assertOwned();
      record('native-pause-requested', { collectionOwnerId, pauseCompletionProven: false, independentQueueVerificationRequired: true });
    } catch { pauseUnavailable = true; /* The retained failure still vetoes subsequent effects. */ }
    return canceled();
  }
  return Object.freeze({ fail,
    will(game, downloadId) { if (failure && game === gameId && ids.has(downloadId)) throw canceled(); },
    deploy(profile) { if (failure && profile === profileId) throw canceled(); },
    assertOpen() { if (failure) throw canceled(); },
    observation() { return { held: failure !== null, pauseRequested, pauseUnavailable, pauseCompletionProven: false }; },
  });
}
module.exports = { wait, flagsReady, createNativeStopBoundary };
