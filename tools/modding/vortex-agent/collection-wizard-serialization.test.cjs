'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { safe } = require('./serialization.cjs');
const api = (secret = 'private-credential', userInfo = {}) => ({ getState: () => ({ confidential: { apiKey: secret }, persistent: { nexus: { userInfo } } }) });
const identity = () => ({ gameId: 'cyberpunk2077', profileId: 'profile', modId: 'collection-owner', archiveId: 'collection-archive', collectionId: 123, revisionId: 456, revisionNumber: 13, action: 'install_now' });
const completion = () => ({ protocol: 'vortex-agent/1', operation: 'advance_collection_wizard', requestId: 'wizard_request_01',
  at: '2026-11-03T19:00:00.000Z', ...identity(), transition: 'started', nativeTransitionVerified: true });
const readiness = () => ({ protocol: 'vortex-agent/1', schema: 'collection-wizard-readiness/1',
  observedAtUTC: '2026-11-03T19:00:00.000Z', status: 'ready', ...identity(), phase: 'start', reason: null,
  sourceAdmitted: true, bindingReady: true, writesAvailable: true, nativeTransitionVerified: false });
test('wizard operation, parameters and completion retain exact operational fields across account collisions', () => {
  const value = completion(); value.parameters = { ...identity(), requestId: value.requestId };
  const account = { name: 'collection', label: 'install_now', id: 'started', profile: 'profile', type: 'advance_collection_wizard' };
  assert.deepEqual(safe(value, api(undefined, account), 'receipt'), value);
  assert.deepEqual(safe(completion(), api(undefined, account), 'advance_collection_wizard'), completion());
  assert.deepEqual(safe({ completion: completion() }, api(undefined, account), 'reconcile_operation'), { completion: completion() });
});
test('flat readiness retains finite schema, phase, reason and identities', () => {
  const value = readiness(); const account = { name: 'collection', label: 'ready', phase: 'start', id: 'collection-wizard-readiness/1' };
  assert.deepEqual(safe(value, api(undefined, account), 'read_collection_wizard'), value);
  for (const status of ['held', 'idle', 'ambiguous']) {
    const held = { ...value, status, phase: null, action: null, collectionId: null, revisionId: null,
      revisionNumber: null, reason: 'COLLECTION_WIZARD_DOM_NOT_OBSERVED', writesAvailable: false };
    assert.deepEqual(safe(held, api(), 'read_collection_wizard'), held);
  }
});
test('operational secrets reject rather than silently corrupting wizard identities', () => {
  for (const secret of ['collection-owner', 'collection-archive', 'install_now', 'started', 'advance_collection_wizard', '123']) {
    assert.throws(() => safe(completion(), api(secret), 'receipt'), /OPERATIONAL_SECRET_OVERLAP/);
  }
  for (const secret of ['collection-wizard-readiness/1', 'ready', 'start', '456']) {
    assert.throws(() => safe(readiness(), api(secret), 'read_collection_wizard'), /OPERATIONAL_SECRET_OVERLAP/);
  }
});
test('wizard positive remote IDs reject strings, arrays, objects and invalid numbers', () => {
  for (const kind of ['receipt', 'advance_collection_wizard', 'operation_status']) {
    for (const bad of ['123', [123], { valueOf() { throw Error('must not invoke'); } }, 0, -1, 1.5, NaN, Infinity]) {
      assert.throws(() => safe({ ...completion(), collectionId: bad }, api(), kind), /OPERATIONAL_VALUE_NOT_CURATED/);
      assert.throws(() => safe({ parameters: { ...identity(), revisionNumber: bad } }, api(), kind), /OPERATIONAL_VALUE_NOT_CURATED/);
    }
  }
});
test('unknown actions, transitions and completion verification are refused', () => {
  for (const [key, value] of [['action', 'continue'], ['transition', 'clicked'], ['nativeTransitionVerified', false], ['nativeTransitionVerified', 'true']]) {
    assert.throws(() => safe({ ...completion(), [key]: value }, api(), 'receipt'), /OPERATIONAL_VALUE_NOT_CURATED/);
  }
});
test('readiness is never a verified native transition and boolean fields remain typed', () => {
  for (const [key, value] of [['nativeTransitionVerified', true], ['writesAvailable', 'true'], ['sourceAdmitted', 1],
    ['bindingReady', null], ['schema', 'other'], ['status', 'permitted'], ['phase', 'continue'], ['reason', 'https://private.invalid']]) {
    assert.throws(() => safe({ ...readiness(), [key]: value }, api(), 'read_collection_wizard'), /OPERATIONAL_VALUE_NOT_CURATED/);
  }
});
test('credential and URI redaction is preserved outside exact operational positions', () => {
  const value = { ...readiness(), debug: { action: 'private-credential https://private.invalid', token: 'private-credential',
    nested: { schema: 'account-name' } } };
  const result = safe(value, api(undefined, { name: 'account-name' }), 'read_collection_wizard');
  assert.equal(result.debug.action, '[redacted] [redacted-uri]'); assert.equal(result.debug.token, '[redacted]');
  assert.equal(result.debug.nested.schema, '[redacted]');
});
