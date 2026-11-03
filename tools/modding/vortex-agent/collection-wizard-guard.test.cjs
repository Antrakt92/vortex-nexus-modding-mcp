'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path');
const { EventEmitter } = require('node:events');
const { createOperations, identity } = require('./guard.cjs');
const receipts = require('./receipts.cjs');
const { createCollectionWizardController } = require('./collection-wizard-controller.cjs');

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wizard-guard-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const gameId = 'cyberpunk2077', profileId = 'profile';
  const state = { settings: { profiles: { nextProfileId: profileId }, gameMode: { discovered: { [gameId]: { path: dir } } } },
    persistent: { profiles: { profile: { gameId, name: 'DEV', modState: {} } }, mods: { [gameId]: {
      other: { id: 'other', state: 'installed', installationPath: 'other', archiveId: 'other-archive' } } },
      downloads: { files: {} }, nexus: { userInfo: { userId: 1 } } },
    session: { collections: { sessionHistory: {} }, notifications: { dialogs: [] } } };
  let mode = 'idle', clicks = 0, writes = 0, versionRead = async () => '2.31', clickBehavior;
  const selectors = { activeGameId: () => gameId, activeProfileId: () => profileId,
    discoveryByGame: () => ({ path: dir }), installPathForGame: () => dir, downloadPathForGame: () => dir };
  const api = { events: new EventEmitter(), getState: () => state, awaitUI: async () => {},
    translate: (key, opts) => key.replace(/\{\{(\w+)\}\}/g, (_, name) => opts.replace[name]) };
  const element = { click() { clicks++; clickBehavior(); } }, modal = {};
  const session = () => ({ sessionId: 'owner_profile', collectionId: 'owner', profileId, gameId,
    totalRequired: 1, totalOptional: 0, mods: { member: { type: 'requires', status: 'installed' } } });
  clickBehavior = () => {
    if (mode === 'start') { state.session.collections.activeSession = session(); mode = 'working'; }
    else if (mode === 'finish') {
      const c = state.session.collections; c.lastActiveSessionId = c.activeSession.sessionId;
      c.sessionHistory[c.activeSession.sessionId] = c.activeSession; c.activeSession = undefined; mode = 'idle';
    }
  };
  const admit = async () => ({}); admit.revalidate = () => true;
  const controller = createCollectionWizardController(api, { selectors, admit, admitRead:admit,
    util: { renderModName: mod => mod.attributes.customFileName,
      getGame: () => ({ getInstalledVersion: () => versionRead() }) },
    pollMs: 1, transitionTimeoutMs: 10,
    inspectDOM: () => ['idle', 'working'].includes(mode) ? { status: 'idle', candidate: null }
      : { status: 'observed', phase: mode, name: 'Our Collection', revisionLabel: 'Revision 13',
        selectedProfileLabel: mode === 'start' ? 'DEV (Current)' : null,
        buttons: mode === 'start' ? [{ action: 'later', enabled: true }, { action: 'install_now', enabled: true }]
          : [{ action: 'done', enabled: true }], candidate: { element, modal } } });
  await controller.initialized;
  const revision = { id: 456, revisionNumber: 13, collection: { id: 123, slug: 'ours', game: { domainName: gameId } },
    gameVersions: [{ reference: '2.31' }], modFiles: [] };
  state.persistent.mods[gameId].owner = { state: 'installed', type: 'collection', archiveId: 'archive', rules: [],
    attributes: { collectionId: 123, revisionId: 456, revisionNumber: 13, version: '13', customFileName: 'Our Collection' } };
  state.persistent.downloads.files.archive = { state: 'finished', modInfo: { nexus: { revisionInfo: revision,
    ids: { collectionId: 123, revisionId: 456, revisionNumber: 13, collectionSlug: 'ours' } } } };
  mode = 'start'; api.events.emit('did-install-mod', gameId, 'archive', 'owner');
  const wizard = Object.fromEntries(['prepare', 'validate', 'click', 'waitForTransition', 'verifyTransition']
    .map(key => [key, (...args) => controller[key](...args)]));
  const ops = createOperations(api, { setModsEnabled: async () => {
    writes++; state.persistent.profiles.profile.modState.other = { enabled: true };
  } }, selectors, { wizard, receipts: path.join(dir, 'receipts'), stopped: () => {} });
  const common = { gameId, profileId, gamePath: dir, stagingPath: dir, downloadPath: dir,
    filesystemIds: { gamePath: identity(dir), stagingPath: identity(dir), downloadPath: identity(dir) } };
  const args = { ...common, requestId: 'wizard_request_start', modId: 'owner', archiveId: 'archive',
    collectionId: 123, revisionId: 456, revisionNumber: 13, action: 'install_now' };
  return { dir, state, controller, wizard, ops, args, common,
    read: async name => JSON.parse(await fs.readFile(path.join(dir, 'receipts', name), 'utf8')),
    get clicks() { return clicks; }, get writes() { return writes; },
    set mode(value) { mode = value; }, set versionRead(value) { versionRead = value; },
    set clickBehavior(value) { clickBehavior = value; } };
}

test('real guard/controller start and finish each produce exact verified receipts and one click', async t => {
  const f = await fixture(t);
  for (const action of ['install_now', 'done']) {
    const args = { ...f.args, action, requestId: 'wizard_request_' + action };
    if (action === 'done') f.mode = 'finish';
    const result = await f.ops.advance_collection_wizard(args);
    const attempt = await f.read(args.requestId + '.attempt.json');
    const completion = await f.read(args.requestId + '.completion.json');
    assert.equal(receipts.validAttempt(attempt), true); assert.equal(receipts.validCompletion(completion, attempt), true);
    for (const key of ['modId', 'archiveId', 'collectionId', 'revisionId', 'revisionNumber', 'action']) assert.equal(completion[key], args[key]);
    assert.equal(result.transition, action === 'done' ? 'finished' : 'started');
    assert.equal(result.nativeTransitionVerified, true); assert.equal(result.diskDeploymentVerified, false);
    assert.equal(f.clicks, action === 'done' ? 2 : 1);
    await assert.rejects(fs.access(path.join(f.dir, 'receipts/unresolved.json')));
  }
});

test('wizard holds the shared mutation lock across asynchronous preparation', async t => {
  const f = await fixture(t); let release, entered;
  const inVersionRead = new Promise(resolve => { entered = resolve; });
  f.versionRead = () => { entered(); return new Promise(resolve => { release = () => resolve('2.31'); }); };
  const first = f.ops.advance_collection_wizard(f.args);
  await inVersionRead; await fs.access(path.join(f.dir, 'receipts/mutation.lock'));
  let settled = false;
  const second = f.ops.set_mods_enabled({ ...f.common, requestId: 'other_write_request', modIds: ['other'], enabled: true })
    .finally(() => { settled = true; });
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(f.writes, 0); assert.equal(settled, false); assert.equal(f.clicks, 0);
  release(); await first; await second; assert.equal(f.clicks, 1); assert.equal(f.writes, 1);
});

test('uncertain click records effects, retains global interlock and cannot be replayed or reconciled as success', async t => {
  const f = await fixture(t); f.clickBehavior = () => { throw Error('SYNTHETIC_CLICK_FAILURE'); };
  await assert.rejects(f.ops.advance_collection_wizard(f.args), /SYNTHETIC_CLICK_FAILURE/);
  const attempt = await f.read(f.args.requestId + '.attempt.json'), failure = await f.read(f.args.requestId + '.failed.json');
  assert.equal(receipts.validFailure(failure, attempt), true); assert.equal(failure.effectsMayHaveOccurred, true);
  assert.equal(failure.inspectBeforeRetry, true); assert.equal(f.clicks, 1);
  for (const requestId of [f.args.requestId, 'different_wizard_request']) {
    await assert.rejects(f.ops.advance_collection_wizard({ ...f.args, requestId }), /UNRESOLVED_OPERATION_INTERLOCK/);
  }
  await assert.rejects(f.ops.set_mods_enabled({ ...f.common, requestId: 'other_write_request', modIds: ['other'], enabled: true }), /UNRESOLVED_OPERATION_INTERLOCK/);
  const reconciled = await f.ops.reconcile_operation({ requestId: f.args.requestId });
  assert.equal(reconciled.terminalOperationVerified, false); assert.equal(f.clicks, 1); assert.equal(f.writes, 0);
  await fs.access(path.join(f.dir, 'receipts/unresolved.json'));
});

test('late pre-click validation failure records no effects and releases the armed interlock', async t => {
  const f = await fixture(t), original = f.wizard.validate;
  f.wizard.validate = args => { f.state.session.notifications.dialogs.push({}); return original(args); };
  await assert.rejects(f.ops.advance_collection_wizard(f.args), /NATIVE_DIALOG_PENDING/);
  const attempt = await f.read(f.args.requestId + '.attempt.json'), failure = await f.read(f.args.requestId + '.failed.json');
  assert.equal(receipts.validFailure(failure, attempt), true); assert.equal(failure.effectsMayHaveOccurred, false);
  assert.equal(failure.inspectBeforeRetry, false); assert.equal(f.clicks, 0);
  await assert.rejects(fs.access(path.join(f.dir, 'receipts/unresolved.json')));
  await assert.rejects(fs.access(path.join(f.dir, 'receipts/mutation.lock')));
});

test('click without native transition never writes a successful completion', async t => {
  const f = await fixture(t); f.clickBehavior = () => {};
  await assert.rejects(f.ops.advance_collection_wizard(f.args), /TRANSITION_TIMEOUT/);
  assert.equal(f.clicks, 1); assert.equal((await f.read(f.args.requestId + '.failed.json')).effectsMayHaveOccurred, true);
  await assert.rejects(fs.access(path.join(f.dir, 'receipts', f.args.requestId + '.completion.json')));
  assert.equal((await f.ops.reconcile_operation({ requestId: f.args.requestId })).terminalOperationVerified, false);
});
