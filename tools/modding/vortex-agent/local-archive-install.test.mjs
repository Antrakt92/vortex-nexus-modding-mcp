import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { crc32, deflateRawSync } from 'node:zlib';
import { EventEmitter } from 'node:events';
import installer from './local-archive-install.cjs';
import guard from './guard.cjs';
import receipts from './receipts.cjs';
import diagnostics from './install-diagnostics.cjs';

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
        const id = options.importId ?? 'newdownload';
        fs.copyFileSync(archive, path.join(downloadPath, path.basename(archive)));
        state.persistent.downloads.files[id] = { state: options.importState ?? 'finished', game: [G], localPath: path.basename(archive) };
        queueMicrotask(() => callback([id]));
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
          const download = state.persistent.downloads.files[downloadId];
          const info = { download: options.alternateHookPath ? { ...download, localPath: 'alternate/' + download.localPath } : download };
          await hooks.get('will-install-mod')(G, downloadId, ID, info);
          if (options.lateMetadata) info.meta = { fileId: 123 };
          if (info.meta) {
            replacementReached = true;
            state.persistent.profiles[P].modState.previous.enabled = false;
            fs.writeFileSync(oldPath, 'replacement reached');
          }
          const staged = path.join(stagingPath, ID, payloadPath);
          fs.mkdirSync(path.dirname(staged), { recursive: true }); fs.writeFileSync(staged, payload);
          if (options.extraStagedFile) fs.writeFileSync(path.join(path.dirname(staged), 'unexpected.txt'), 'fixture extra');
          state.persistent.mods[G][ID] = { id: ID, state: 'installed', installationPath: ID, archiveId: downloadId };
          if (options.installedLink !== undefined) download.installed = options.installedLink;
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
    async admitHost() { hostChecks++; options.onHostAdmission?.(hostChecks, state); },
    timeoutMs: options.timeout ? 30 : 1000,
  };
  return { api, args, services, state, baseline, hooks, calls, guards, root, oldPath, gameFile,
    installationStarted, nativeFailure: () => nativeError,
    counts: () => ({ effectCount, checkCount, hostChecks, replacementReached }) };
}

test('completion accepts only the exact stock local download installation link', async t => {
  const link = {gameId: G, modId: ID};
  const accepted = fixture(t, {installedLink: link});
  const result = await installLocalArchive(accepted.api, accepted.args, accepted.services);
  assert.equal(result.installedRecordVerified, true);
  for (const installedLink of [{...link, modId: 'other'}, {...link, gameId: 'other'},
    {...link, fileId: 123}, null]) {
    const refused = fixture(t, {installedLink});
    await assert.rejects(installLocalArchive(refused.api, refused.args, refused.services),
      /LOCAL_ARCHIVE_METADATA_UNSAFE/);
  }
});

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

test('archive growth after descriptor admission refuses after reading only the pinned bytes', async t => {
  const f = fixture(t);
  const fstat = fs.fstatSync, readFile = fs.readFileSync, read = fs.readSync;
  let target, positionedBytes = 0, wholeFileBytes = 0;
  const open = fs.openSync;
  t.mock.method(fs, 'openSync', (filename, ...options) => {
    const descriptor = open(filename, ...options);
    if (filename === f.args.archivePath && options[0] === 'r') target = descriptor;
    return descriptor;
  });
  let grew = false;
  t.mock.method(fs, 'fstatSync', (descriptor, ...options) => {
    const stat = fstat(descriptor, ...options);
    if (descriptor === target && !grew) {
      grew = true;
      fs.appendFileSync(f.args.archivePath, Buffer.alloc(8192));
    }
    return stat;
  });
  t.mock.method(fs, 'readSync', (descriptor, ...options) => {
    const count = read(descriptor, ...options);
    if (descriptor === target) positionedBytes += count;
    return count;
  });
  t.mock.method(fs, 'readFileSync', (filename, ...options) => {
    const data = readFile(filename, ...options);
    if (filename === target) wholeFileBytes += data.length;
    return data;
  });
  await assert.rejects(installLocalArchive(f.api, f.args, f.services), /LOCAL_ARCHIVE_CHANGED/);
  assert.equal(grew, true);
  assert.equal(wholeFileBytes, 0);
  assert.equal(positionedBytes, f.args.size);
  assert.equal(f.counts().effectCount, 0);
});

for (const timing of ['before', 'after']) {
  test(`oversized staged payload is refused when its size grows ${timing} admission`, async t => {
    const f = fixture(t);
    const staged = path.join(f.args.stagingPath, ID, payloadPath);
    const write = fs.writeFileSync, readFile = fs.readFileSync, open = fs.openSync, fstat = fs.fstatSync, read = fs.readSync;
    const extra = Buffer.alloc(8192);
    let descriptor, positionedBytes = 0, wholeFileBytes = 0, grew = false;
    if (timing === 'before') t.mock.method(fs, 'writeFileSync', (filename, data, ...options) =>
      write(filename, filename === staged ? Buffer.concat([data, extra]) : data, ...options));
    t.mock.method(fs, 'openSync', (filename, ...options) => {
      const handle = open(filename, ...options);
      if (filename === staged && options[0] === 'r') descriptor = handle;
      return handle;
    });
    if (timing === 'after') t.mock.method(fs, 'fstatSync', (handle, ...options) => {
      const stat = fstat(handle, ...options);
      if (handle === descriptor && !grew) {
        grew = true;
        fs.appendFileSync(staged, extra);
      }
      return stat;
    });
    t.mock.method(fs, 'readSync', (handle, ...options) => {
      const count = read(handle, ...options);
      if (handle === descriptor) positionedBytes += count;
      return count;
    });
    t.mock.method(fs, 'readFileSync', (filename, ...options) => {
      const data = readFile(filename, ...options);
      if (filename === staged || filename === descriptor) wholeFileBytes += data.length;
      return data;
    });
    await assert.rejects(installLocalArchive(f.api, f.args, f.services), /LOCAL_ARCHIVE_STAGED_BYTES_UNVERIFIED/);
    assert.equal(wholeFileBytes, 0);
    assert.equal(positionedBytes, timing === 'before' ? 0 : payload.length);
  });
}

test('the staged inventory walk stops on the existing install deadline', async t => {
  const f = fixture(t), stage = path.join(f.args.stagingPath, ID);
  const staged = path.join(stage, payloadPath), opendir = fs.opendirSync, open = fs.openSync;
  let time = 0, stagedOpens = 0;
  f.services.diagnostics = diagnostics.createInstallDiagnostics({budgetMs: 10000, now: () => time});
  t.mock.method(fs, 'opendirSync', (...args) => {
    const directory = opendir(...args);
    if (args[0] === path.dirname(staged)) time = 10000;
    return directory;
  });
  t.mock.method(fs, 'openSync', (...args) => {
    if (args[0] === staged && args[1] === 'r') stagedOpens++;
    return open(...args);
  });
  await assert.rejects(installLocalArchive(f.api, f.args, f.services), /LOCAL_ARCHIVE_DEADLINE_EXCEEDED/);
  assert.equal(stagedOpens, 0);
  assert.equal(f.services.diagnostics.snapshot().reason, 'deadline');
});

test('installed file inventory must match the authored package', async t => {
  const f = fixture(t, { extraStagedFile: true });
  await assert.rejects(installLocalArchive(f.api, f.args, f.services), /LOCAL_ARCHIVE_STAGED_BYTES_UNVERIFIED/);
});

test('Nexus archive hashing reads at most the admitted size and refuses growth', async t => {
  const f = fixture(t);
  const localPath = 'tracked.zip', file = path.join(f.args.downloadPath, localPath);
  const bytes = Buffer.from('synthetic tracked archive');
  fs.writeFileSync(file, bytes);
  f.state.settings = {gameMode: {discovered: {[G]: {path: f.args.gamePath}}}};
  f.state.persistent.downloads.files.tracked = {
    state: 'finished', game: [G], localPath, modInfo: {modId: 42, fileId: 43},
  };
  const selectors = {
    activeGameId: () => G, activeProfileId: () => P,
    downloadPathForGame: () => f.args.downloadPath, installPathForGame: () => f.args.stagingPath,
  };
  f.api.store = {getState: f.api.getState};
  const ops = guard.createOperations(f.api, {}, selectors, {receipts: path.join(f.root, 'receipts'), stopped: () => {}});
  const open = fsPromises.open;
  let total = 0;
  t.mock.method(fsPromises, 'open', async (filename, ...options) => {
    const handle = await open(filename, ...options);
    if (filename !== file) return handle;
    return {
      stat: (...args) => handle.stat(...args), close: () => handle.close(),
      async *createReadStream(...args) {
        fs.appendFileSync(file, Buffer.alloc(8192));
        for await (const chunk of handle.createReadStream(...args)) {
          total += chunk.length;
          yield chunk;
        }
      },
    };
  });
  await assert.rejects(ops.download_nexus({ ...f.args, requestId: 'growth-proof-01',
    filesystemIds: Object.fromEntries(['gamePath', 'stagingPath', 'downloadPath'].map(key => [key, guard.identity(f.args[key])])),
    nexusModId: 42, nexusFileId: 43, size: bytes.length, sha256: sha(bytes), reuseOnly: true,
  }), /DOWNLOAD_ARCHIVE_CHANGED/);
  assert.equal(total, bytes.length);
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

test('an untracked file at the import destination is never offered for replacement', async t => {
  const f = fixture(t), existing = path.join(f.args.downloadPath, ID + '.zip');
  fs.writeFileSync(existing, 'untracked original');
  await assert.rejects(installLocalArchive(f.api, f.args, f.services), /LOCAL_ARCHIVE_DOWNLOAD_PATH_COLLISION/);
  assert.equal(f.counts().effectCount, 0);
  assert.deepEqual(f.calls, []);
  assert.equal(fs.readFileSync(existing, 'utf8'), 'untracked original');
});

test('reports a terminal import state without dispatching installation', async t => {
  for (const importState of ['failed', 'paused', 'cancelled']) {
    const f = fixture(t, { importState });
    await assert.rejects(installLocalArchive(f.api, f.args, f.services), /LOCAL_ARCHIVE_IMPORT_REQUIRES_USER_ATTENTION/);
    assert.deepEqual(f.calls.map(call => call.name), ['import-downloads']);
    await assert.rejects(installLocalArchive(f.api, f.args, f.services), /LOCAL_ARCHIVE_NATIVE_OPERATION_HELD/);
  }
});

test('an invalid native import ID holds the original effect before installation', async t => {
  for (const importId of ['x'.repeat(513), 'tracked\x7f']) {
    const f = fixture(t, { importId });
    await assert.rejects(installLocalArchive(f.api, f.args, f.services), /LOCAL_ARCHIVE_IMPORT_RESULT_INVALID/);
    assert.deepEqual(f.calls.map(call => call.name), ['import-downloads']);
    assert.equal(f.counts().effectCount, 1);
    assert.equal(f.state.persistent.downloads.files[importId]?.state, 'finished');
    await assert.rejects(installLocalArchive(f.api, f.args, f.services), /LOCAL_ARCHIVE_NATIVE_OPERATION_HELD/);
    assert.equal(f.counts().effectCount, 1);
  }
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

test('a different imported record path cannot dispatch a native install after metadata admission', async t => {
  const f = fixture(t, { onHostAdmission(count, state) {
    if (count === 2) state.persistent.downloads.files.newdownload.localPath = 'alternate/' + ID + '.zip';
  } });
  await assert.rejects(installLocalArchive(f.api, f.args, f.services), /LOCAL_ARCHIVE_IMPORTED_IDENTITY_MISMATCH/);
  assert.deepEqual(f.calls.map(call => call.name), ['import-downloads']);
  assert.equal(f.state.persistent.mods[G][ID], undefined);
});

test('a native capture of a different same-basename download path refuses even when Redux is restored', async t => {
  const f = fixture(t, { alternateHookPath: true });
  await assert.rejects(installLocalArchive(f.api, f.args, f.services), /LOCAL_ARCHIVE_NATIVE_FAILED_RECONCILE/);
  assert.match(f.nativeFailure().message, /LOCAL_ARCHIVE_IMPORTED_IDENTITY_MISMATCH/);
  assert.equal(f.state.persistent.downloads.files.newdownload.localPath, ID + '.zip');
  assert.equal(f.state.persistent.mods[G][ID], undefined);
  assert.equal(fs.existsSync(path.join(f.args.stagingPath, ID)), false);
});

test('active profile drift before will-install aborts before staging files', async t => {
  const f = fixture(t, { contextDrift: true });
  await assert.rejects(installLocalArchive(f.api, f.args, f.services), /LOCAL_ARCHIVE_NATIVE_FAILED_RECONCILE/);
  assert.match(f.nativeFailure().message, /ACTIVE_PROFILE_CHANGED/);
  assert.deepEqual(f.state.persistent.profiles, f.baseline.profiles);
  assert.equal(fs.readFileSync(f.oldPath, 'utf8'), 'preserved staging');
  assert.equal(fs.existsSync(path.join(f.args.stagingPath, ID)), false);
});

function guardedFixture(t, options) {
  const f = fixture(t, options), dir = path.join(f.root, 'receipts');
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
  const operations = guard.createOperations(f.api, {}, selectors, {
    receipts: dir, stopped: () => {}, admitLocalInstallHost: async () => {},
  });
  return { ...f, dir, operations };
}

test('reconciliation keeps local install evidence and all valid observations when a stored ID is malformed', async t => {
  const bad = 'download\x7f', f = guardedFixture(t, {importId: bad});
  await assert.rejects(f.operations.install_local_archive(f.args), /LOCAL_ARCHIVE_IMPORT_RESULT_INVALID/);
  const record = f.state.persistent.downloads.files[bad];
  f.state.persistent.downloads.files['retained-a'] = {...record};
  f.state.persistent.downloads.files['retained-b'] = {...record};
  f.state.persistent.mods[G][ID] = {state: 'installed', installationPath: ID, archiveId: bad};
  const result = guard.safe(await f.operations.reconcile_operation({requestId: f.args.requestId}), f.api, 'reconcile_operation');
  assert.equal(result.attempt.requestId, f.args.requestId);
  assert.equal(result.failure.requestId, f.args.requestId);
  assert.equal(result.interlock.requestId, f.args.requestId);
  assert.equal(result.terminalOperationVerified, false);
  assert.equal(result.localInstall.downloadId, null);
  assert.equal(result.localInstall.replayAllowed, false);
  assert.deepEqual(result.download.map(row => row.id), ['retained-a', 'retained-b']);
  assert.deepEqual(result.receiptIssues, ['DOWNLOAD_IDENTITY_UNVERIFIABLE']);
});

for (const [label, change, error] of [
  ['installed flags', state => { state.persistent.profiles[P].modState[ID] = { enabled: true }; },
    /LOCAL_ARCHIVE_INSTALLED_RECORD_UNVERIFIED/],
  ['imported record', state => { state.persistent.downloads.files.newdownload.state = 'removed'; },
    /LOCAL_ARCHIVE_IMPORTED_IDENTITY_MISMATCH/],
  ['unrelated records', state => { state.persistent.mods[G].previous.state = 'removed'; },
    /LOCAL_ARCHIVE_EXISTING_STATE_CHANGED/],
  ['staged bytes', (_, stagingPath) => {
    fs.writeFileSync(path.join(stagingPath, ID, payloadPath), Buffer.alloc(payload.length, 65));
  }, /LOCAL_ARCHIVE_STAGED_BYTES_UNVERIFIED/],
  ['staged inventory', (_, stagingPath) => {
    fs.writeFileSync(path.join(stagingPath, ID, path.dirname(payloadPath), 'unexpected.txt'), 'fixture extra');
  }, /LOCAL_ARCHIVE_STAGED_BYTES_UNVERIFIED/],
]) {
  test(`completion receipt rejects changed ${label} after syncing its pending record`, async t => {
    const f = guardedFixture(t);
    const open = fsPromises.open;
    t.mock.method(fsPromises, 'open', async (file, ...args) => {
      const handle = await open(file, ...args);
      if (String(file).includes('.completion.json.pending-')) {
        const sync = handle.sync.bind(handle);
        handle.sync = async () => { await sync(); change(f.state, f.args.stagingPath); };
      }
      return handle;
    });
    await assert.rejects(f.operations.install_local_archive(f.args), error);
    assert.deepEqual(f.calls.map(call => call.name), ['import-downloads', 'start-install-download']);
    assert.equal(fs.existsSync(path.join(f.dir, 'unresolved.json')), true);
    assert.equal(fs.existsSync(path.join(f.dir, f.args.requestId + '.completion.json')), false);
  });
}

test('real operation guard retains one durable intent across import and install, then refuses replay', async t => {
  const f = guardedFixture(t), {dir, operations} = f;
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
  const inspect = () => operations.reconcile_operation({requestId: f.args.requestId});
  assert.equal((await inspect()).terminalOperationVerified, true);

  const alias = path.join(f.root, 'foreign-completion.json');
  fs.linkSync(completionPath, alias);
  const linked = await inspect();
  assert.equal(linked.terminalOperationVerified, false);
  assert.equal(linked.completion, null);
  assert(linked.receiptIssues.includes('INVALID_RECEIPT'));
  fs.unlinkSync(alias);
  assert.equal((await inspect()).terminalOperationVerified, true);

  const relocated = path.join(f.root, 'relocated-receipts');
  fs.renameSync(dir, relocated);
  fs.symlinkSync(relocated, dir, 'junction');
  await assert.rejects(inspect(), /RECEIPT_DIRECTORY_UNVERIFIABLE/);
});
