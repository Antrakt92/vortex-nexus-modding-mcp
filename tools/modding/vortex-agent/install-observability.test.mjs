import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { crc32, deflateRawSync } from 'node:zlib';
import { EventEmitter } from 'node:events';
import { Module, createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import guard from './guard.cjs';
import diagnostics from './install-diagnostics.cjs';
const require = createRequire(import.meta.url);
const G = 'cyberpunk2077', P = 'active', ID = 'Own-Observation';
const payloadPath = 'archive/pc/mod/own_observation.archive';
const payload = Buffer.from('synthetic observability fixture');
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
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) {
  // A fixed number of immediate turns can expire before an fsync completes
  // under parallel suites. Yield to real I/O; the operation's fake clock stays fixed.
  const deadline = performance.now() + 5000;
  while (performance.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  assert.fail('Fixture did not reach expected stage');
}
function clock() {
  let time = 0, sequence = 0;
  const pending = new Map();
  return { options: { budgetMs: 500, now: () => time, timers: {
    setTimeout(fn, ms) { const id = ++sequence; pending.set(id, { fn, at: time + ms }); return id; },
    clearTimeout(id) { pending.delete(id); },
  } }, advance(ms) {
    time += ms;
    for (const [id, timer] of [...pending]) if (timer.at <= time) { pending.delete(id); timer.fn(); }
  } };
}
function fixture(t, options = {}, implementation = guard) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'install-observability-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dirs = Object.fromEntries(['gamePath', 'stagingPath', 'downloadPath'].map(key => {
    const value = path.join(root, key); fs.mkdirSync(value); return [key, fs.realpathSync(value)];
  }));
  const archivePath = path.join(root, ID + '.zip'), bytes = zip(); fs.writeFileSync(archivePath, bytes);
  const state = { session: { activeProfileId: P }, settings: { gameMode: { discovered: { [G]: { path: dirs.gamePath } } } },
    persistent: { mods: { [G]: {} }, profiles: { [P]: { id: P, gameId: G, modState: {} } }, downloads: { files: {} } } };
  const hooks = new Map(), events = new EventEmitter(), calls = [], callbacks = {}, timer = clock();
  let metadataCalls = 0, hostCalls = 0, stagedWrites = 0, processChecks = 0, gameRunning = false, hookError;
  const api = { getState: () => state, onAsync: (event, fn) => hooks.set(event, fn),
    lookupModMeta: () => { metadataCalls++; return options.metadata?.(metadataCalls) ?? Promise.resolve([]); },
    events: { prependListener: (...args) => events.prependListener(...args), removeListener: (...args) => events.removeListener(...args),
      emit(event, ...args) {
        events.emit(event, ...args); calls.push(event);
        if (event === 'import-downloads') {
          const [[archive], callback] = args; callbacks.import = callback;
          fs.copyFileSync(archive, path.join(dirs.downloadPath, path.basename(archive)));
          state.persistent.downloads.files.imported = { state: options.pendingImport ? 'init' : 'finished', game: [G], localPath: path.basename(archive) };
          queueMicrotask(() => callback(['imported']));
        } else if (event === 'start-install-download') {
          const [downloadId, , callback] = args; callbacks.install = callback;
          if (options.suspendNative) return true;
          void (async () => {
            await options.beforeHook?.();
            await hooks.get('will-install-mod')(G, downloadId, ID, {});
            const target = path.join(dirs.stagingPath, ID, payloadPath);
            fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, payload); stagedWrites++;
            state.persistent.mods[G][ID] = { id: ID, state: 'installed', installationPath: ID, archiveId: downloadId };
            state.persistent.profiles[P].modState[ID] = { enabled: false };
            callback(null, ID);
          })().catch(error => { hookError = error; callback(error); });
        } else throw Error('UNEXPECTED_NATIVE_EVENT');
        return true;
      } } };
  const args = { gameId: G, profileId: P, requestId: crypto.randomUUID(), ...dirs, archivePath,
    size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    filesystemIds: Object.fromEntries(Object.entries(dirs).map(([key, dir]) => [key, guard.identity(dir)])) };
  const selectors = { activeGameId: () => G, activeProfileId: () => state.session.activeProfileId,
    installPathForGame: () => dirs.stagingPath, downloadPathForGame: () => dirs.downloadPath };
  const receiptDir = path.join(root, 'receipts');
  const operations = () => implementation.createOperations(api, {}, selectors, { receipts: receiptDir,
    stopped: () => {
      processChecks++; options.onFullCheck?.(processChecks, state);
      if (Object.keys(state.session?.base?.toolsRunning || {}).length) throw Error('GAME_OR_TOOL_RUNNING');
      if (gameRunning) throw Error('GAME_RUNNING');
    }, admitLocalInstallHost: async () => { hostCalls++; await options.host?.(hostCalls); }, installDiagnosticsOptions: timer.options });
  const ops = operations();
  return { root, args, api, state, selectors, ops, operations, calls, callbacks, timer, receiptDir, hooks,
    processChecks: () => processChecks, hostCalls: () => hostCalls, startGame: () => { gameRunning = true; },
    metadataCalls: () => metadataCalls, stagedWrites: () => stagedWrites, hookError: () => hookError,
    file: suffix => path.join(receiptDir, args.requestId + suffix) };
}
const observe = promise => promise.then(value => ({ value }), error => ({ error }));
function valid(snapshot) { assert.equal(diagnostics.validInstallDiagnostics(snapshot), true); }

test('suspended pre-effect metadata exposes progress despite mutation lock and late resolution cannot import or replay', async t => {
  const metadata = deferred(), f = fixture(t, { metadata: () => metadata.promise });
  const outcome = observe(f.ops.install_local_archive(f.args));
  await until(() => f.metadataCalls() === 1);
  assert.equal(fs.existsSync(path.join(f.receiptDir, 'mutation.lock')), true);
  const live = await f.operations().reconcile_operation({ requestId: f.args.requestId });
  assert.equal(live.installDiagnosticsSource, 'live');
  valid(live.installDiagnostics);
  assert.equal(live.installDiagnostics.waitReason, 'metadata_reply');
  assert.equal(live.terminalOperationVerified, false); assert.equal(live.interlockCleared, false);
  f.timer.advance(501);
  const { error } = await outcome;
  assert.match(error.message, /DEADLINE|TIMEOUT/); valid(error.installDiagnostics);
  assert.equal(error.installDiagnostics.effectsMayHaveOccurred, false);
  metadata.resolve([]); await tick(); await tick();
  assert.deepEqual(f.calls, []);
  await assert.rejects(f.ops.install_local_archive(f.args), e => e.code === 'EEXIST');
  assert.deepEqual(f.calls, []);
});

test('native hook admission resolving after deadline cannot authorize staged writes or clear guards', async t => {
  const metadata = deferred(), f = fixture(t, { metadata: count => count === 3 ? metadata.promise : Promise.resolve([]) });
  const outcome = observe(f.ops.install_local_archive(f.args));
  await until(() => f.metadataCalls() === 3);
  const live = await f.operations().reconcile_operation({ requestId: f.args.requestId });
  assert.equal(live.installDiagnostics.phase, 'native_hook');
  f.timer.advance(501);
  const { error } = await outcome;
  assert.match(error.message, /DEADLINE|TIMEOUT/); valid(error.installDiagnostics);
  assert.equal(error.installDiagnostics.nativeMayContinue, true);
  metadata.resolve([]); await until(() => !!f.hookError());
  assert.equal(f.stagedWrites(), 0);
  assert.equal(fs.existsSync(path.join(f.args.stagingPath, ID)), false);
  assert.equal(fs.existsSync(path.join(f.receiptDir, 'unresolved.json')), true);
  assert.deepEqual(f.calls, ['import-downloads', 'start-install-download']);
  await assert.rejects(f.hooks.get('will-install-mod')(G, 'imported', ID, {}));
});

test('late and duplicate native callbacks leave frozen terminal metrics and dispatch count unchanged', async t => {
  const f = fixture(t, { suspendNative: true }), outcome = observe(f.ops.install_local_archive(f.args));
  await until(() => !!f.callbacks.install);
  f.timer.advance(501); const { error } = await outcome;
  valid(error.installDiagnostics);
  const before = await f.ops.reconcile_operation({ requestId: f.args.requestId });
  f.timer.advance(700);
  f.callbacks.install(null, ID); f.callbacks.install(Error('private upstream error'), ID);
  f.callbacks.import(['different']); await tick(); await tick();
  const after = await f.ops.reconcile_operation({ requestId: f.args.requestId });
  assert.deepEqual(after.installDiagnostics, before.installDiagnostics);
  assert.deepEqual(f.calls, ['import-downloads', 'start-install-download']);
  assert.equal(f.stagedWrites(), 0); assert.equal(after.terminalOperationVerified, false);
});

test('retained diagnostics are optional observations and corrupt sidecar cannot invalidate valid completion', async t => {
  const f = fixture(t), result = await f.ops.install_local_archive(f.args);
  valid(result.installDiagnostics); assert.equal(result.operationCompleted, true);
  const retainedOps = f.operations();
  const retained = await retainedOps.reconcile_operation({ requestId: f.args.requestId });
  assert.equal(retained.installDiagnosticsSource, 'retained');
  assert.deepEqual(retained.installDiagnostics, result.installDiagnostics);
  assert.equal(retained.terminalOperationVerified, true);
  const completionBytes = fs.readFileSync(f.file('.completion.json'), 'utf8');
  fs.writeFileSync(f.file('.diagnostics.json'), '{broken');
  const corrupt = await retainedOps.reconcile_operation({ requestId: f.args.requestId });
  assert.equal(corrupt.installDiagnosticsSource, 'unavailable');
  assert.ok(corrupt.diagnosticsIssues.length > 0);
  assert.equal(corrupt.terminalOperationVerified, true); assert.deepEqual(corrupt.receiptIssues, []);
  assert.equal(fs.readFileSync(f.file('.completion.json'), 'utf8'), completionBytes);
});

function withFailedUnlink(kind) {
  const filename = fileURLToPath(new URL('./guard.cjs', import.meta.url));
  const compiled = new Module(filename); compiled.filename = filename;
  compiled.paths = Module._nodeModulePaths(path.dirname(filename));
  let failed = false;
  compiled.require = name => name === 'node:fs/promises' ? new Proxy(fsp, { get(target, key) {
    if (key !== 'unlink') return target[key];
    return async file => {
      const match = kind === 'pending' ? String(file).includes('.completion.json.pending-') : path.basename(file) === 'unresolved.json';
      if (!failed && match) { failed = true; throw Object.assign(Error('synthetic cleanup failure'), { code: 'EIO' }); }
      return target.unlink(file);
    };
  } }) : require(name);
  compiled._compile(fs.readFileSync(filename, 'utf8'), filename);
  return compiled.exports;
}
for (const kind of ['pending', 'interlock']) test(`published completion survives ${kind} cleanup failure without contradictory failure receipt`, async t => {
  const f = fixture(t, {}, withFailedUnlink(kind));
  await observe(f.ops.install_local_archive(f.args));
  assert.equal(fs.existsSync(f.file('.completion.json')), true);
  assert.equal(fs.existsSync(f.file('.failed.json')), false);
  const readback = await f.ops.reconcile_operation({ requestId: f.args.requestId });
  assert.equal(readback.completion.operationCompleted, true);
  assert.equal(readback.failure, null);
  assert.equal(readback.interlockCleared, false);
});

test('import and later admission share remaining operation budget instead of resetting it', async t => {
  const metadata = deferred(); let f;
  f = fixture(t, { metadata: count => {
    if (count === 1) { f.timer.advance(350); return Promise.resolve([]); }
    return metadata.promise;
  } });
  const outcome = observe(f.ops.install_local_archive(f.args));
  await until(() => f.metadataCalls() === 2);
  const live = await f.ops.reconcile_operation({ requestId: f.args.requestId });
  assert.equal(live.installDiagnostics.remainingMs, 150);
  assert.deepEqual(f.calls, ['import-downloads']);
  f.timer.advance(151);
  const { error } = await outcome;
  assert.match(error.message, /DEADLINE/);
  assert.equal(error.installDiagnostics.reason, 'deadline');
  assert.equal(error.installDiagnostics.effectsMayHaveOccurred, true);
  metadata.resolve([]); await tick(); await tick();
  assert.deepEqual(f.calls, ['import-downloads']);
  assert.equal(f.stagedWrites(), 0);
  assert.equal(fs.existsSync(path.join(f.receiptDir, 'unresolved.json')), true);
});

test('completed diagnostic observation cannot substitute for missing authoritative completion receipt', async t => {
  const f = fixture(t), result = await f.ops.install_local_archive(f.args);
  assert.equal(result.installDiagnostics.state, 'completed');
  fs.unlinkSync(f.file('.completion.json'));
  const readback = await f.operations().reconcile_operation({ requestId: f.args.requestId });
  assert.equal(readback.installDiagnosticsSource, 'retained');
  assert.equal(readback.installDiagnostics.state, 'completed');
  assert.equal(readback.completion, null);
  assert.equal(readback.localInstall.installed, true);
  assert.equal(readback.terminalOperationVerified, false);
  assert.equal(readback.interlockCleared, false);
});

test('local install uses six fresh full probes while retaining inexpensive context validation', async t => {
  const f = fixture(t), result = await f.ops.install_local_archive(f.args);
  assert.equal(result.operationCompleted, true);
  assert.equal(f.processChecks(), 6);
  assert.ok(result.installDiagnostics.metrics.context_checks.calls >= 14);
});

for (const kind of ['host', 'metadata']) for (const stage of [1, 2, 3]) {
  for (const drift of ['profile', 'tools']) test(`${drift} drift after ${kind} await ${stage} refuses next native permission`, async t => {
    const wait = deferred(), f = fixture(t, { [kind]: count => count === stage ? wait.promise : Promise.resolve([]) });
    const outcome = observe(f.ops.install_local_archive(f.args));
    await until(() => (kind === 'host' ? f.hostCalls() : f.metadataCalls()) === stage);
    const probesBeforeDrift = f.processChecks();
    if (drift === 'profile') f.state.session.activeProfileId = 'different';
    else f.state.session.base = { toolsRunning: { synthetic: {} } };
    wait.resolve([]);
    const { error } = await outcome;
    assert.ok(error);
    assert.equal(f.processChecks(), probesBeforeDrift, 'Cheap guard must refuse before another process probe');
    if (kind === 'host') assert.equal(f.metadataCalls(), stage - 1);
    assert.equal(fs.existsSync(f.file('.completion.json')), false);
    assert.equal(f.stagedWrites(), 0);
    assert.deepEqual(f.calls, stage === 1 ? [] : stage === 2 ? ['import-downloads'] : ['import-downloads', 'start-install-download']);
    if (stage > 1) assert.equal(fs.existsSync(path.join(f.receiptDir, 'unresolved.json')), true);
  });
}

for (const stage of [1, 2, 3]) test(`fresh process scan rejects game launched during metadata await ${stage}`, async t => {
  const wait = deferred(), f = fixture(t, { metadata: count => count === stage ? wait.promise : Promise.resolve([]) });
  const outcome = observe(f.ops.install_local_archive(f.args));
  await until(() => f.metadataCalls() === stage);
  f.startGame(); wait.resolve([]);
  const { error } = await outcome;
  assert.ok(error);
  assert.equal(f.processChecks(), stage + 1, 'Each native permission requires a newly sampled process guard');
  if (stage === 3) assert.equal(f.hookError()?.message, 'GAME_RUNNING');
  assert.equal(fs.existsSync(f.file('.completion.json')), false);
  assert.equal(f.stagedWrites(), 0);
  assert.deepEqual(f.calls, stage === 1 ? [] : stage === 2 ? ['import-downloads'] : ['import-downloads', 'start-install-download']);
});

function withPendingSync(onSync) {
  const filename = fileURLToPath(new URL('./guard.cjs', import.meta.url));
  const compiled = new Module(filename); compiled.filename = filename;
  compiled.paths = Module._nodeModulePaths(path.dirname(filename));
  compiled.require = name => name === 'node:fs/promises' ? new Proxy(fsp, { get(target, key) {
    if (key !== 'open') return target[key];
    return async (...args) => {
      const handle = await target.open(...args);
      if (!String(args[0]).includes('.completion.json.pending-')) return handle;
      return new Proxy(handle, { get(file, member) {
        if (member === 'sync') return async () => { await file.sync(); await onSync(); };
        const value = file[member]; return typeof value === 'function' ? value.bind(file) : value;
      } });
    };
  } }) : require(name);
  compiled._compile(fs.readFileSync(filename, 'utf8'), filename);
  return compiled.exports;
}

test('game launched during completion fsync prevents publication and keeps the original interlock', async t => {
  let f;
  f = fixture(t, {}, withPendingSync(() => f.startGame()));
  const { error } = await observe(f.ops.install_local_archive(f.args));
  assert.equal(error?.message, 'GAME_RUNNING');
  assert.equal(f.stagedWrites(), 1);
  assert.equal(fs.existsSync(f.file('.completion.json')), false);
  assert.equal(fs.existsSync(path.join(f.receiptDir, 'unresolved.json')), true);
  const failed = JSON.parse(fs.readFileSync(f.file('.failed.json'), 'utf8'));
  assert.equal(failed.effectsMayHaveOccurred, true);
  assert.equal(failed.errorCode, 'GAME_RUNNING');
});

test('post-fsync full probe does not turn noncancelable finalization back into work-budget admission', async t => {
  let f;
  f = fixture(t, {}, withPendingSync(() => f.timer.advance(501)));
  const result = await f.ops.install_local_archive(f.args);
  assert.equal(result.operationCompleted, true);
  assert.equal(result.installDiagnostics.state, 'completed');
  assert.equal(result.installDiagnostics.remainingMs, 0);
  assert.equal(f.processChecks(), 6);
});

for (const operation of ['set_mods_enabled', 'deploy_mods']) test(`${operation} retains its existing full-check route`, async t => {
  const f = fixture(t);
  const { archivePath, size, sha256, ...context } = f.args;
  f.state.persistent.mods[G].existing = { id: 'existing', state: 'installed', installationPath: 'existing' };
  f.api.ext = { awaitModsDeployment: async () => {} };
  const result = operation === 'set_mods_enabled'
    ? await f.ops.set_mods_enabled({ ...context, modIds: ['existing'], enabled: false })
    : await f.ops.deploy_mods(context);
  assert.equal(result.operationCompleted, true);
  assert.equal(f.processChecks(), operation === 'set_mods_enabled' ? 3 : 4);
  assert.equal(result.installDiagnostics, undefined);
  assert.equal(fs.existsSync(f.file('.diagnostics.json')), false);
  assert.deepEqual(f.calls, []);
});

for (const drift of ['profile', 'tools']) test(`pending import polls retain cheap ${drift} guards without repeated process scans`, async t => {
  const f = fixture(t, { pendingImport: true });
  const outcome = observe(f.ops.install_local_archive(f.args));
  await until(() => f.calls.length === 1 && f.processChecks() === 2);
  const live = await f.ops.reconcile_operation({ requestId: f.args.requestId });
  assert.equal(live.installDiagnostics.waitReason, 'download_finished');
  if (drift === 'profile') f.state.session.activeProfileId = 'different';
  else f.state.session.base = { toolsRunning: { synthetic: {} } };
  const { error } = await outcome;
  assert.ok(error);
  assert.equal(f.processChecks(), 2);
  assert.deepEqual(f.calls, ['import-downloads']);
  assert.equal(f.stagedWrites(), 0);
  assert.equal(fs.existsSync(f.file('.completion.json')), false);
  assert.equal(fs.existsSync(path.join(f.receiptDir, 'unresolved.json')), true);
});
