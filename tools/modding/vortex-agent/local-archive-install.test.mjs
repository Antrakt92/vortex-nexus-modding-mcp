import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { crc32, deflateRawSync } from 'node:zlib';
import { EventEmitter } from 'node:events';
import installer from './local-archive-install.cjs';
import guard from './guard.cjs';
import receipts from './receipts.cjs';

const { installLocalArchive } = installer;
const G = 'cyberpunk2077', P = 'active', ID = 'Own-Test';
const payloadPath = 'archive/pc/mod/own_test.archive';
const payload = Buffer.from('own bounded synthetic mod payload\n');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function zip() {
  const name = Buffer.from(payloadPath), packed = deflateRawSync(payload);
  const local = Buffer.alloc(30), central = Buffer.alloc(46), end = Buffer.alloc(22);
  local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
  local.writeUInt32LE(crc32(payload), 14); local.writeUInt32LE(packed.length, 18);
  local.writeUInt32LE(payload.length, 22); local.writeUInt16LE(name.length, 26);
  central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10); central.writeUInt32LE(crc32(payload), 16);
  central.writeUInt32LE(packed.length, 20); central.writeUInt32LE(payload.length, 24);
  central.writeUInt16LE(name.length, 28);
  const first = Buffer.concat([local, name, packed]), directory = Buffer.concat([central, name]);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(first.length, 16);
  return Buffer.concat([first, directory, end]);
}

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-archive-install-test-'));
  t.after(() => fs.rmSync(root, { recursive: true }));
  const archivePath = path.join(root, ID + '.zip'), stagingPath = path.join(root, 'staging');
  const downloadPath = path.join(root, 'downloads'), gamePath = path.join(root, 'game');
  for (const dir of [stagingPath, downloadPath, gamePath]) fs.mkdirSync(dir);
  const bytes = zip(); fs.writeFileSync(archivePath, bytes);
  const oldPath = path.join(stagingPath, 'previous', 'old.txt');
  fs.mkdirSync(path.dirname(oldPath)); fs.writeFileSync(oldPath, 'preserved staging');
  const gameFile = path.join(gamePath, 'old.txt'); fs.writeFileSync(gameFile, 'preserved game');
  const state = { session: { activeProfileId: P }, persistent: {
    mods: { [G]: { previous: { id: 'previous', state: 'installed', installationPath: 'previous' } },
      othergame: { separate: { id: 'separate', installationPath: 'separate' } } },
    profiles: {
      [P]: { id: P, gameId: G, modState: { previous: { enabled: true } } },
      other: { id: 'other', gameId: G, modState: { previous: { enabled: false } } },
    },
    downloads: { files: { older: { state: 'finished', game: [G], localPath: 'previous.zip' } } },
  } };
  const baseline = structuredClone(state.persistent), hooks = new Map(), calls = [], guards = new EventEmitter();
  let effectCount = 0, checkCount = 0, hostChecks = 0, nativeError, replacementReached = false;
  let started; const installationStarted = new Promise(resolve => { started = resolve; });
  const api = {
    getState: () => state,
    onAsync: (name, handler) => hooks.set(name, handler),
    lookupModMeta: async () => options.metadata ?? [],
    events: {
      prependListener: (...args) => guards.prependListener(...args),
      removeListener: (...args) => guards.removeListener(...args),
      emit(name, ...args) {
      guards.emit(name, ...args);
      calls.push({ name, args });
      if (options.missingListener === name) return false;
      if (name === 'import-downloads') {
        const [[archive], callback] = args;
        fs.copyFileSync(archive, path.join(downloadPath, path.basename(archive)));
        state.persistent.downloads.files.newdownload = { state: 'finished', game: [G], localPath: path.basename(archive) };
        queueMicrotask(() => callback(['newdownload']));
      } else if (name === 'start-install-download') {
        const [downloadId, installOptions, callback] = args;
        started();
        if (options.timeout) return true;
        void (async () => {
          const imported = path.join(downloadPath, ID + '.zip');
          if (options.changedImport === 'mutate') fs.writeFileSync(imported, 'changed after initial proof');
          if (options.changedImport === 'swap') {
            fs.renameSync(imported, imported + '.retained');
            fs.copyFileSync(archivePath, imported);
          }
          if (options.contextDrift) state.session.activeProfileId = 'other';
          const info = {};
          await hooks.get('will-install-mod')(G, downloadId, ID, info);
          if (options.lateMetadata) info.meta = { fileId: 123 };
          if (info.meta) {
            replacementReached = true;
            state.persistent.profiles[P].modState.previous.enabled = false;
            fs.writeFileSync(oldPath, 'replacement reached');
          }
          const staged = path.join(stagingPath, ID, payloadPath);
          fs.mkdirSync(path.dirname(staged), { recursive: true }); fs.writeFileSync(staged, payload);
          state.persistent.mods[G][ID] = { id: ID, state: 'installed', installationPath: ID, archiveId: downloadId };
          state.persistent.profiles[installOptions.profileId].modState[ID] = { enabled: false };
          if (options.mutatePrevious) state.persistent.mods[G].previous.installationPath = 'changed';
          callback(null, options.wrongId ? 'different-mod' : ID);
        })().catch(error => { nativeError = error; callback(error); });
      } else throw Error('UNEXPECTED_NATIVE_EVENT');
      return true;
    } },
  };
  const args = { gameId: G, profileId: P, archivePath, stagingPath, downloadPath, gamePath,
    size: bytes.length, sha256: sha(bytes) };
  const services = {
    check() {
      checkCount++;
      if (state.session.activeProfileId !== P) throw Error('ACTIVE_PROFILE_CHANGED');
    },
    async effect(operation, verify) { verify(); effectCount++; return operation(); },
    async admitHost() { hostChecks++; },
    timeoutMs: options.timeout ? 30 : 1000,
  };
  return { api, args, services, state, baseline, hooks, calls, guards, root, oldPath, gameFile,
    installationStarted, nativeFailure: () => nativeError,
    counts: () => ({ effectCount, checkCount, hostChecks, replacementReached }) };
}

test('installs verified archive disabled while preserving existing mods, profiles and files', async t => {
  const f = fixture(t), unrelated = () => {};
  f.guards.on('remove-mods', unrelated);
  const result = await installLocalArchive(f.api, f.args, f.services);
  assert.deepEqual(result, { modId: ID, downloadId: 'newdownload', installedRecordVerified: true,
    enabled: false, archiveSha256Verified: true, payloadFilesVerified: 1 });
  assert.deepEqual(f.state.persistent.mods[G].previous, f.baseline.mods[G].previous);
  assert.deepEqual(f.state.persistent.mods.othergame, f.baseline.mods.othergame);
  assert.deepEqual(f.state.persistent.profiles.other, f.baseline.profiles.other);
  assert.deepEqual(f.state.persistent.profiles[P].modState.previous, f.baseline.profiles[P].modState.previous);
  assert.equal(fs.readFileSync(f.oldPath, 'utf8'), 'preserved staging');
  assert.equal(fs.readFileSync(f.gameFile, 'utf8'), 'preserved game');
  assert.deepEqual(f.calls.map(call => call.name), ['import-downloads', 'start-install-download']);
  assert.deepEqual(f.calls[1].args[1], { allowAutoEnable: false, profileId: P });
  assert.equal(f.counts().effectCount, 2); assert.ok(f.counts().hostChecks >= 3);
  assert.deepEqual(f.guards.eventNames(), ['remove-mods']);
  assert.deepEqual(f.guards.listeners('remove-mods'), [unrelated]);
  await f.hooks.get('will-install-mod')(G, 'later-download', 'later-mod', {});
  await f.hooks.get('will-remove-mods')();
});

test('rejects archive hash mismatch before any native effect', async t => {
  const f = fixture(t); f.args.sha256 = '0'.repeat(64);
  await assert.rejects(installLocalArchive(f.api, f.args, f.services), /LOCAL_ARCHIVE_HASH_MISMATCH/);
  assert.equal(f.counts().effectCount, 0); assert.deepEqual(f.calls, []);
  assert.deepEqual(f.state.persistent, f.baseline);
});

test('rejects existing owner and staging collisions before any native effect', async t => {
  for (const kind of ['key', 'id', 'installationPath', 'directory', 'installing']) {
    const f = fixture(t);
    if (kind === 'key') f.state.persistent.mods[G][ID.toUpperCase()] = {};
    else if (['id', 'installationPath'].includes(kind)) f.state.persistent.mods[G].previous[kind] = ID.toUpperCase();
    else fs.mkdirSync(path.join(f.args.stagingPath, ID + (kind === 'installing' ? '.installing' : '')));
    await assert.rejects(installLocalArchive(f.api, f.args, f.services), /LOCAL_ARCHIVE_(?:MOD|DIRECTORY)_COLLISION/);
    assert.equal(f.counts().effectCount, 0); assert.deepEqual(f.calls, []);
  }
});

test('rejects native metadata matches before import or installation', async t => {
  const f = fixture(t, { metadata: [{ value: { source: 'nexus', modId: 123 } }] });
  await assert.rejects(installLocalArchive(f.api, f.args, f.services), /LOCAL_ARCHIVE_METADATA_UNSAFE/);
  assert.equal(f.counts().effectCount, 0); assert.deepEqual(f.calls, []);
});

test('rejects native wrong returned ID and keeps operation held against replay', async t => {
  const f = fixture(t, { wrongId: true });
  await assert.rejects(installLocalArchive(f.api, f.args, f.services), /LOCAL_ARCHIVE_INSTALLED_IDENTITY_MISMATCH/);
  const effects = f.counts().effectCount;
  await assert.rejects(installLocalArchive(f.api, f.args, f.services), /LOCAL_ARCHIVE_NATIVE_OPERATION_HELD/);
  assert.equal(f.counts().effectCount, effects);
});

test('native timeout holds API against retry and late unowned hook calls', async t => {
  const f = fixture(t, { timeout: true });
  const outcome = assert.rejects(installLocalArchive(f.api, f.args, f.services), /LOCAL_ARCHIVE_NATIVE_TIMEOUT_RECONCILE/);
  await f.installationStarted;
  assert.throws(() => f.api.events.emit('start-install', 'unowned.zip', () => {}), /LOCAL_ARCHIVE_UNOWNED_INSTALL/);
  assert.throws(() => f.api.events.emit('start-install-download', 'newdownload',
    { allowAutoEnable: false, profileId: P }, () => {}), /LOCAL_ARCHIVE_UNOWNED_INSTALL/);
  assert.throws(() => f.api.events.emit('remove-mods', ['previous']), /LOCAL_ARCHIVE_REPLACEMENT_REFUSED/);
  await assert.rejects(f.hooks.get('will-install-mod')(G, 'foreign-download', 'foreign-mod', {}), /LOCAL_ARCHIVE_UNOWNED_INSTALL/);
  await assert.rejects(f.hooks.get('will-remove-mods')(), /LOCAL_ARCHIVE_REPLACEMENT_REFUSED/);
  await outcome;
  await assert.rejects(f.hooks.get('will-install-mod')(G, 'newdownload', ID, {}), /LOCAL_ARCHIVE_UNOWNED_INSTALL/);
  await assert.rejects(installLocalArchive(f.api, f.args, f.services), /LOCAL_ARCHIVE_NATIVE_OPERATION_HELD/);
  assert.equal(f.counts().effectCount, 2);
});

test('detects an existing mod changed during native installation instead of claiming success', async t => {
  const f = fixture(t, { mutatePrevious: true });
  await assert.rejects(installLocalArchive(f.api, f.args, f.services), /LOCAL_ARCHIVE_EXISTING_STATE_CHANGED/);
});

test('a denied host admission cannot start native import', async t => {
  const f = fixture(t); f.services.admitHost = async () => { throw Error('HOST_SOURCE_REFUSED'); };
  await assert.rejects(installLocalArchive(f.api, f.args, f.services), /HOST_SOURCE_REFUSED/);
  assert.equal(f.counts().effectCount, 0); assert.deepEqual(f.calls, []);
});

test('late native metadata assignment cannot reach replacement or profile disabling', async t => {
  const f = fixture(t, { lateMetadata: true });
  await assert.rejects(installLocalArchive(f.api, f.args, f.services), /LOCAL_ARCHIVE_NATIVE_FAILED_RECONCILE/);
  assert.match(f.nativeFailure().message, /LOCAL_ARCHIVE_METADATA_CHANGED/);
  assert.equal(f.counts().replacementReached, false);
  assert.equal(f.state.persistent.profiles[P].modState.previous.enabled, true);
  assert.equal(fs.readFileSync(f.oldPath, 'utf8'), 'preserved staging');
  assert.equal(fs.readFileSync(f.gameFile, 'utf8'), 'preserved game');
  assert.equal(f.state.persistent.mods[G][ID], undefined);
  await assert.rejects(installLocalArchive(f.api, f.args, f.services), /LOCAL_ARCHIVE_NATIVE_OPERATION_HELD/);
  assert.equal(f.counts().effectCount, 2);
});

test('rejects imported archive mutation or identical-byte replacement before will-install', async t => {
  for (const changedImport of ['mutate', 'swap']) {
    const f = fixture(t, { changedImport });
    await assert.rejects(installLocalArchive(f.api, f.args, f.services), /LOCAL_ARCHIVE_NATIVE_FAILED_RECONCILE/);
    assert.match(f.nativeFailure().message, /LOCAL_ARCHIVE_CHANGED/);
    assert.equal(f.state.persistent.mods[G][ID], undefined);
    assert.deepEqual(f.state.persistent.profiles, f.baseline.profiles);
    assert.equal(fs.readFileSync(f.oldPath, 'utf8'), 'preserved staging');
    assert.equal(fs.readFileSync(f.gameFile, 'utf8'), 'preserved game');
    assert.equal(fs.existsSync(path.join(f.args.stagingPath, ID)), false);
    await assert.rejects(installLocalArchive(f.api, f.args, f.services), /LOCAL_ARCHIVE_NATIVE_OPERATION_HELD/);
  }
});

test('active profile drift before will-install aborts before staging files', async t => {
  const f = fixture(t, { contextDrift: true });
  await assert.rejects(installLocalArchive(f.api, f.args, f.services), /LOCAL_ARCHIVE_NATIVE_FAILED_RECONCILE/);
  assert.match(f.nativeFailure().message, /ACTIVE_PROFILE_CHANGED/);
  assert.deepEqual(f.state.persistent.profiles, f.baseline.profiles);
  assert.equal(fs.readFileSync(f.oldPath, 'utf8'), 'preserved staging');
  assert.equal(fs.existsSync(path.join(f.args.stagingPath, ID)), false);
});

test('real operation guard retains one durable intent across import and install, then refuses replay', async t => {
  const f = fixture(t), dir = path.join(f.root, 'receipts');
  for (const key of ['gamePath', 'stagingPath', 'downloadPath']) f.args[key] = fs.realpathSync(f.args[key]);
  f.state.settings = { gameMode: { discovered: { [G]: { path: f.args.gamePath } } } };
  const selectors = {
    activeGameId: () => G,
    activeProfileId: state => state.session.activeProfileId,
    installPathForGame: () => f.args.stagingPath,
    downloadPathForGame: () => f.args.downloadPath,
  };
  f.args.filesystemIds = Object.fromEntries(['gamePath', 'stagingPath', 'downloadPath']
    .map(key => [key, guard.identity(f.args[key])]));
  f.args.requestId = 'local_archive_multistage_001';
  const snapshots = [], unresolved = path.join(dir, 'unresolved.json');
  const emit = f.api.events.emit.bind(f.api.events);
  f.api.events.emit = (name, ...args) => {
    if (['import-downloads', 'start-install-download'].includes(name)) {
      const stat = fs.statSync(unresolved, { bigint: true });
      snapshots.push({ name, bytes: fs.readFileSync(unresolved, 'utf8'),
        generation: [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':') });
    }
    return emit(name, ...args);
  };
  const operations = guard.createOperations(f.api, {}, selectors, {
    receipts: dir, stopped: () => {}, admitLocalInstallHost: async () => {},
  });
  const result = await operations.install_local_archive(f.args);
  assert.equal(result.operationCompleted, true);
  assert.equal(result.modId, ID); assert.equal(result.downloadId, 'newdownload');
  assert.deepEqual(snapshots.map(item => item.name), ['import-downloads', 'start-install-download']);
  assert.equal(snapshots[0].bytes, snapshots[1].bytes, 'Original intent bytes retained across native stages');
  assert.equal(snapshots[0].generation, snapshots[1].generation, 'Original durable intent file retained');
  const attemptPath = path.join(dir, f.args.requestId + '.attempt.json');
  const completionPath = path.join(dir, f.args.requestId + '.completion.json');
  const attemptBytes = fs.readFileSync(attemptPath, 'utf8'), completionBytes = fs.readFileSync(completionPath, 'utf8');
  const attempt = JSON.parse(attemptBytes), completion = JSON.parse(completionBytes);
  assert.equal(receipts.validAttempt(attempt), true);
  assert.equal(receipts.validCompletion(completion, attempt), true);
  assert.deepEqual(JSON.parse(snapshots[0].bytes), attempt);
  assert.equal(fs.existsSync(unresolved), false);
  assert.equal(fs.existsSync(path.join(dir, 'mutation.lock')), false);
  await assert.rejects(operations.install_local_archive(f.args), error => error.code === 'EEXIST');
  assert.equal(snapshots.length, 2, 'Same request cannot invoke another native stage');
  assert.equal(fs.readFileSync(attemptPath, 'utf8'), attemptBytes);
  assert.equal(fs.readFileSync(completionPath, 'utf8'), completionBytes);
  assert.equal(fs.existsSync(unresolved), false);
});
