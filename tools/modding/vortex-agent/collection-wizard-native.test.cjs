'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { observeNative, normalizeSession } = require('./collection-wizard-native.cjs');
function fixture() {
  return { sourceAdmitted: true, modId: 'owner',
    selectors: { activeGameId: () => 'cyberpunk2077', activeProfileId: () => 'profile' },
    util: { renderModName: mod => mod.attributes.customFileName },
    t: (key, options) => key.replace(/\{\{(\w+)\}\}/g, (_, name) => options.replace[name]),
    state: { persistent: { profiles: { profile: { gameId: 'cyberpunk2077', name: 'DEV' } },
      mods: { cyberpunk2077: { owner: { state: 'installed', type: 'collection', archiveId: 'archive',
        attributes: { collectionId: 123, revisionId: 456, revisionNumber: 13, version: '13', customFileName: 'Our Collection' } } } },
      downloads: { files: { archive: { state: 'finished', modInfo: { nexus: { ids: { collectionId: 123, revisionId: 456 } } } } } } },
      settings: { profiles: { nextProfileId: 'profile' } },
      session: { collections: {}, notifications: { dialogs: [] } } } };
}
const owner = f => f.state.persistent.mods.cyberpunk2077.owner;
const info = f => f.state.persistent.downloads.files.archive.modInfo;
function rawSession() { return { collectionId: 'owner', profileId: 'profile', gameId: 'cyberpunk2077',
  totalRequired: 1, totalOptional: 0, mods: { rule: { type: 'requires', status: 'installed' } } }; }
test('exact state projects only bounded policy metadata', () => {
  const result = observeNative(fixture());
  assert.deepEqual(result.owner, { id: 'owner', state: 'installed', type: 'collection', archiveId: 'archive',
    collectionId: 123, revisionId: 456, revisionNumber: 13, name: 'Our Collection', revisionLabel: 'Revision 13' });
  assert.equal(result.profileLabel, 'DEV (Current)'); assert.equal(result.profileLabelMatches, 1);
  assert.equal(result.ownerDisplayMatches, 1); assert.equal(result.pendingDialogCount, 0); assert.equal(result.session, null);
});
for (const [name, mutate] of [
  ['attribute ID array', f => { owner(f).attributes.collectionId = [123]; }],
  ['attribute ID object', f => { owner(f).attributes.revisionId = { valueOf: () => 456 }; }],
  ['unsafe integer', f => { owner(f).attributes.revisionId = Number.MAX_SAFE_INTEGER + 1; }],
  ['version conflict', f => { owner(f).attributes.version = '12'; }],
  ['nonnumeric version', f => { owner(f).attributes.version = '13.0'; }],
  ['download collection conflict', f => { info(f).nexus.ids.collectionId = 999; }],
  ['download revision conflict', f => { info(f).nexus.ids.revisionId = 999; }],
  ['missing primary download IDs', f => { info(f).ids = info(f).nexus.ids; delete info(f).nexus; }],
  ['contradictory alternate IDs', f => { info(f).ids = { revisionId: 999 }; }],
  ['array alternate IDs', f => { info(f).ids = []; }],
  ['profile game conflict', f => { f.state.persistent.profiles.profile.gameId = 'other'; }],
  ['missing collection SSOT', f => { delete f.state.session.collections; }],
  ['malformed active session', f => { f.state.session.collections.activeSession = null; }],
]) test(`refuses ${name}`, () => { const f = fixture(); mutate(f); assert.throws(() => observeNative(f), /COLLECTION_WIZARD_NATIVE_/); });
test('canonical numeric strings normalize without loose object coercion', () => {
  const f = fixture(); owner(f).attributes.collectionId = '123'; info(f).nexus.ids.collectionId = '123';
  assert.equal(observeNative(f).owner.collectionId, 123);
});
test('duplicate display is counted rather than silently selecting owner', () => {
  const f = fixture(); f.state.persistent.mods.cyberpunk2077.other = structuredClone(owner(f));
  assert.equal(observeNative(f).ownerDisplayMatches, 2);
});
test('profile option collisions use rendered current label and plain other names', () => {
  const f = fixture(); f.state.persistent.profiles.other = { gameId: 'cyberpunk2077', name: 'DEV (Current)' };
  f.state.persistent.profiles.foreign = { gameId: 'other', name: 'DEV (Current)' };
  assert.equal(observeNative(f).profileLabelMatches, 2);
});
test('unknown dialog count remains null; pending dialogs remain counted', () => {
  const f = fixture(); delete f.state.session.notifications;
  assert.equal(observeNative(f).pendingDialogCount, null);
  f.state.session.notifications = { dialogs: [{ id: 'bounded but not exported' }] };
  assert.equal(observeNative(f).pendingDialogCount, 1);
});
test('source flag cannot be fabricated by truthiness', () => {
  const f = fixture(); f.sourceAdmitted = 'true'; assert.equal(observeNative(f).sourceAdmitted, false);
});
test('selectors determine source game rather than a fixed CP projection', () => {
  const f = fixture(); f.selectors.activeGameId = () => 'other';
  assert.throws(() => observeNative(f), /PROFILE_GAME_CONFLICT/);
});
test('valid session counts member statuses and source optional stalled semantics', () => {
  assert.deepEqual(normalizeSession(rawSession()), { collectionId: 'owner', profileId: 'profile', gameId: 'cyberpunk2077',
    statuses: { installed: 1, failed: 0, ignored: 0, pending: 0 }, totalMembers: 1, stalled: false });
  const f = fixture(); f.state.session.collections.activeSession = rawSession();
  assert.equal(observeNative(f).session.totalMembers, 1);
});
test('failed ignored and nonterminal statuses are never reported installed', () => {
  for (const status of ['failed', 'ignored', 'pending', 'downloading', 'downloaded', 'installing', 'optional']) {
    const raw = rawSession(); raw.mods.rule.status = status;
    const result = normalizeSession(raw);
    assert.equal(result.statuses.installed, 0);
    assert.equal(result.statuses[['failed', 'ignored'].includes(status) ? status : 'pending'], 1);
  }
});
for (const [name, mutate] of [
  ['unknown status', raw => { raw.mods.rule.status = 'surprise'; }],
  ['unknown stalled', raw => { raw.stalled = 'false'; }],
  ['missing member map', raw => { delete raw.mods; }],
  ['wrong total', raw => { raw.totalRequired = 2; }],
  ['unknown rule type', raw => { raw.mods.rule.type = 'after'; }],
]) test(`session refuses ${name}`, () => { const raw = rawSession(); mutate(raw); assert.throws(() => normalizeSession(raw), /COLLECTION_WIZARD_NATIVE_/); });
test('state getters are refused without invoking them', () => {
  const f = fixture(); let reads = 0;
  Object.defineProperty(owner(f).attributes, 'revisionId', { get() { reads++; return 456; } });
  assert.throws(() => observeNative(f), /ACCESSOR_REFUSED/); assert.equal(reads, 0);
});
