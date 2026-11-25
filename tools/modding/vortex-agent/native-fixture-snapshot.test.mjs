import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import vm from 'node:vm';
import path from 'node:path';
import { ORDINARY_MOD_LIMIT, assertOrdinaryModSnapshot, hasGracefulFixtureClose, observeFixtureTerminal,
  observeOrdinaryHold, ordinaryProcessesPreserved, stoppedOrdinaryCohort } from './native-fixture-snapshot.mjs';

function holdFixture(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'vortex-fixture-hold-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const parent = path.join(root, 'receipts');
  fs.mkdirSync(parent);
  return { root, parent, file: path.join(parent, 'unresolved.json') };
}

test('absent ordinary operation marker is pinned, and appearance is visible', t => {
  const { file } = holdFixture(t);
  const absent = observeOrdinaryHold(file);
  assert.equal(absent.present, false);
  assert.deepEqual(observeOrdinaryHold(file), absent);
  fs.writeFileSync(file, '{"pending":true}');
  const present = observeOrdinaryHold(file);
  assert.deepEqual(Object.keys(present), ['file', 'generation', 'sha256']);
  assert.match(present.sha256, /^[0-9a-f]{64}$/);
  fs.writeFileSync(file, '{"pending":false}');
  assert.notDeepEqual(observeOrdinaryHold(file), present);
});

test('absence requires the same ordinary parent, and rejects missing or aliased parents', t => {
  const { root, parent, file } = holdFixture(t);
  const absent = observeOrdinaryHold(file);
  const moved = path.join(root, 'retired');
  fs.renameSync(parent, moved);
  assert.throws(() => observeOrdinaryHold(file), { code: 'ENOENT' });
  fs.symlinkSync(moved, parent, 'junction');
  assert.throws(() => observeOrdinaryHold(file), /STOPPED_ORDINARY_FILE_ALIAS/);
  if (process.platform === 'win32') fs.rmdirSync(parent);
  else fs.unlinkSync(parent);
  fs.mkdirSync(parent);
  assert.notDeepEqual(observeOrdinaryHold(file), absent);
});

test('an existing nonordinary marker does not count as absent', t => {
  const { file } = holdFixture(t);
  fs.mkdirSync(file);
  assert.throws(() => observeOrdinaryHold(file), /STOPPED_ORDINARY_FILE_REFUSED/);
});

test('ordinary process preservation rejects PID reuse, missing generations and changed identities', () => {
  const row = {pid:123,parent:1,exe:'C:/Vortex.exe',type:'',generation:'639000000000000000'};
  assert.equal(ordinaryProcessesPreserved([row],[{...row}]),true);
  for (const changed of [{generation:'639000000000000001'},{generation:undefined},{exe:'foreign'},
    {parent:2},{type:'helper'},{pid:124}]) assert.equal(ordinaryProcessesPreserved([row],[{...row,...changed}]),false);
  assert.equal(ordinaryProcessesPreserved([row],[row,row]),false);
  assert.equal(ordinaryProcessesPreserved([],[]),false);
});

function runnerSnapshot(count) {
  const source = fs.readFileSync(new URL('./native-fixture.mjs', import.meta.url), 'utf8');
  const body = source.slice(source.indexOf('async function snapshot()'), source.indexOf('async function main()'));
  const mods = Array.from({ length: count }, (_, index) => ({ id: 'mod_' + index }));
  const context = {
    tool: async name => name === 'health' ? { gamePath: 'C:/synthetic-game' }
      : name === 'list_mods' ? mods : [],
    fs: { readFileSync: () => Buffer.from('synthetic manifest') }, path,
    sha: () => 'synthetic hash', processes: () => [],
    ORDINARY_MOD_LIMIT, assertOrdinaryModSnapshot,
  };
  return vm.runInNewContext(body + '; snapshot()', context);
}

test('native fixture refuses capped ordinary inventories before claiming preservation', async () => {
  for (const count of [500, 501]) {
    await assert.rejects(runnerSnapshot(count), /ORDINARY_MOD_INVENTORY_INCOMPLETE/);
  }
});

test('empty and under-limit inventories remain usable for modeled preservation checks', async () => {
  for (const count of [0, 1, 499]) {
    const snapshot = await runnerSnapshot(count);
    assert.equal(snapshot.mods.length, count);
  }
});

test('malformed and duplicate identities cannot masquerade as a complete snapshot', () => {
  for (const mods of [undefined, null, {}, [null], [[]], [{}], [{ id: '' }],
    [{ id: 1 }], [{ id: 'same' }, { id: 'same' }]]) {
    assert.throws(() => assertOrdinaryModSnapshot(mods), /ORDINARY_MOD_INVENTORY_INVALID/);
  }
});

test('a capped legacy receipt is also refused by the independent verifier', () => {
  const source = fs.readFileSync(new URL('./native-fixture-verify.mjs', import.meta.url), 'utf8');
  const start = source.indexOf("const before = read('ordinary-before.json')");
  const end = source.indexOf('if (input.hostVersion) {', start);
  assert.ok(start >= 0 && end > start);
  const code = source.slice(start, end);
  const complete = { mods: [{ id: 'own' }], health: {}, profiles: [], manifestSha256: 'same' };
  for (const cappedSide of ['ordinary-before.json', 'ordinary-after.json']) {
    const context = { assert, assertOrdinaryModSnapshot, ordinaryProcessesPreserved,
      read: name => name === cappedSide ? { ...complete,
        mods: Array.from({ length: ORDINARY_MOD_LIMIT }, (_, index) => ({ id: 'mod_' + index })) } : complete };
    assert.throws(() => vm.runInNewContext(code, context), /ORDINARY_MOD_INVENTORY_INCOMPLETE/);
  }
});

test('independent verifier requires zero exit and the matching graceful close request', () => {
  const source = fs.readFileSync(new URL('./native-fixture-verify.mjs', import.meta.url), 'utf8');
  const start = source.indexOf("assert.equal(receipt.status, 'passed')");
  const end = source.indexOf('const event = phase', start);
  assert.ok(start >= 0 && end > start);
  const gate = vm.compileFunction(source.slice(start, end), ['assert', 'receipt', 'result', 'hasGracefulFixtureClose']);
  const check = (receipt, result) => gate(assert, receipt, result, hasGracefulFixtureClose);
  const close = { phase: 'graceful-fixture-window-close-request', windowId: 1 };
  const passed = { status: 'passed', events: [close] };
  const valid = { fixtureExited: true, ordinaryUnchanged: true, remainingFixturePids: [],
    fixtureTerminal: { event: 'exit', code: 0, signal: null } };
  assert.doesNotThrow(() => check(passed, valid));
  assert.throws(() => check(passed, {...valid, fixtureProcessRecordError: 'FIXTURE_PROCESS_RECORD_UNAVAILABLE'}), /recorded fixture process/);
  for (const terminal of [undefined, null, { event: 'exit', code: 3, signal: null },
    { event: 'exit', code: null, signal: 'SIGTERM' }, { event: 'error', code: 'ENOENT' }]) {
    assert.throws(() => check(passed, { ...valid, fixtureTerminal: terminal }), /clean fixture exit/);
  }
  for (const events of [[], [{...close, windowId: 0}], [close, close],
    [close, { phase: 'graceful-close-unavailable' }]]) {
    assert.throws(() => check({...passed, events}, valid), /graceful fixture close/);
  }
});

test('independent verifier reads and joins the launch record to the owned fixture and ordinary cohort', () => {
  const source = fs.readFileSync(new URL('./native-fixture-verify.mjs', import.meta.url), 'utf8');
  const start = source.indexOf("const fixtureProcess = read('process.json');");
  const end = source.indexOf('if (input.hostVersion)', start);
  assert.ok(start >= 0 && end > start);
  const root = path.resolve('synthetic-fixture'), input = {userData: path.join(root, 'userdata')};
  const before = {processes: [{pid: 64, exe: 'fixture.exe', type: ''}]}, after = structuredClone(before);
  const record = {pid: 128, executable: 'fixture.exe', args: ['--user-data', input.userData, '--start-minimized'], ordinaryPids: [64]};
  const verify = vm.compileFunction(source.slice(start, end), ['assert', 'read', 'result', 'path', 'root', 'input', 'before', 'after']);
  const check = (launch = record, result = {fixturePid: 128}) => verify(assert, () => launch, result, path, root, input, before, after);
  assert.doesNotThrow(() => check());
  assert.throws(() => verify(assert, () => {throw Error('missing launch');}, {}, path, root, input, before, after), /missing launch/);
  assert.throws(() => check({...record, pid: 129}), /Fixture PID evidence changed/);
  assert.throws(() => check({...record, pid: 64}, {}), /Fixture PID aliases an ordinary process/);
  assert.throws(() => check({...record, args: ['--user-data', 'another-profile', '--start-minimized']}), /Expected values to be strictly deep-equal/);
  assert.throws(() => check({...record, executable: 'another.exe'}), /Fixture executable differs from the admitted host/);
});

test('fixture runner records the process exit or error without treating a signal as a clean exit', () => {
  for (const [event, args, expected] of [
    ['exit', [0, null], { event: 'exit', code: 0, signal: null }],
    ['exit', [3, null], { event: 'exit', code: 3, signal: null }],
    ['exit', [null, 'SIGTERM'], { event: 'exit', code: null, signal: 'SIGTERM' }],
    ['error', [{ code: 'ENOENT', message: 'Untrusted diagnostic' }], { event: 'error', code: 'ENOENT' }],
  ]) {
    const child = new EventEmitter();
    const read = observeFixtureTerminal(child);
    assert.equal(read(), null);
    child.emit(event, ...args);
    assert.deepEqual(read(), expected);
  }
});

test('fixture runner exposes owned PID and keeps observing after process record publication fails', () => {
  const source = fs.readFileSync(new URL('./native-fixture.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('  const readTerminal = observeFixtureTerminal(child);');
  const end = source.indexOf('  const deadline = ', start);
  assert.ok(start >= 0 && end > start);
  const infos = [];
  const child = Object.assign(new EventEmitter(), {pid: 257});
  const fixture = {observeFixtureTerminal, child, path, root: 'fixture', log: 2, vortexExe: 'fixture.exe', args: [],
    before: {processes: [{pid: 5, type: ''}, {pid: 6, type: 'renderer'}]},
    fs: {closeSync() {}}, console: {log(line) {infos.push(JSON.parse(line));}},
    write() {throw Object.assign(Error('private fixture path'), {code: 'ENOSPC'});},
  };
  const finalize = vm.compileFunction(source.slice(start, end) + '\nreturn {readTerminal, fixtureProcessRecordError};', Object.keys(fixture));
  const result = finalize(...Object.values(fixture));
  assert.deepEqual(infos, [{root: 'fixture', fixturePid: child.pid, ordinaryMainPids: [5]}]);
  assert.equal(result.fixtureProcessRecordError, 'FIXTURE_PROCESS_RECORD_UNAVAILABLE');
  child.emit('exit', 0, null);
  assert.deepEqual(result.readTerminal(), {event: 'exit', code: 0, signal: null});
});

test('fixture runner retains terminal evidence when the ordinary after snapshot fails', async () => {
  const source = fs.readFileSync(new URL('./native-fixture.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('  const cleanExit = ');
  const end = source.indexOf('\n}\nmain().catch', start);
  assert.ok(start >= 0 && end > start);
  const terminal = { event: 'exit', code: 0, signal: null };
  const receipt = { status: 'passed', events: [{ phase: 'graceful-fixture-window-close-request', windowId: 1 }] };
  const must = (ok, code) => { if (!ok) throw Error(code); };
  for (const stopped of [false, true]) {
    const records = new Map();
    const fixtures = {fixtureTerminal: terminal, fixtureProcessRecordError: undefined, path, root: 'fixture', stopped, stockReview: true,
      child: {pid: 100}, fixtureObserved: true, stoppedObservationFailure: undefined,
      hasGracefulFixtureClose, ordinaryProcessesPreserved, must, before: {processes: []},
      fs: {existsSync: () => true, readFileSync: () => JSON.stringify(receipt)},
      readOrdinary: async () => { throw Error('ORDINARY_PROBE_UNAVAILABLE'); },
      write: (file, value) => records.set(path.basename(file), value), console: {log() {}},
    };
    const run = vm.compileFunction('return (async () => {\n' + source.slice(start, end) + '\n})();', Object.keys(fixtures));
    await assert.rejects(run(...Object.values(fixtures)), /NATIVE_FIXTURE_INCOMPLETE_INSPECT_RECEIPTS/);
    assert.deepEqual([...records.keys()], ['runner-result.json']);
    const result = records.get('runner-result.json');
    assert.deepEqual(result.fixtureTerminal, terminal);
    assert.equal(result.fixtureExited, true);
    assert.equal(result.nativeStatus, 'passed');
    assert.equal(result.ordinaryUnchanged, false);
    assert.equal(result.remainingFixturePids, null);
    assert.equal(result.ordinaryAfterSnapshotError, 'ORDINARY_PROBE_UNAVAILABLE');
  }
});

test('fixture runner records ordinary and terminal evidence even if the worker receipt is unreadable', async () => {
  const source = fs.readFileSync(new URL('./native-fixture.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('  const cleanExit = ');
  const end = source.indexOf('\n}\nmain().catch', start);
  assert.ok(start >= 0 && end > start);
  const records = new Map(), terminal = {event: 'exit', code: 0, signal: null};
  const before = {manifestSha256: 'fixture', processes: [{pid: 2, generation: '123456789012345'}]};
  const fixtures = {fixtureTerminal: terminal, fixtureProcessRecordError: undefined, path, root: 'fixture', stopped: false, stockReview: true,
    child: {pid: 100}, hasGracefulFixtureClose, ordinaryProcessesPreserved, before,
    must: (ok, code) => { if (!ok) throw Error(code); },
    fs: {existsSync: () => true, readFileSync: () => '{'},
    readOrdinary: async () => before,
    write: (file, value) => records.set(path.basename(file), value), console: {log() {}},
  };
  const run = vm.compileFunction('return (async () => {\n' + source.slice(start, end) + '\n})();', Object.keys(fixtures));
  await assert.rejects(run(...Object.values(fixtures)), /NATIVE_FIXTURE_INCOMPLETE_INSPECT_RECEIPTS/);
  assert.deepEqual([...records.keys()], ['ordinary-after.json', 'runner-result.json']);
  const result = records.get('runner-result.json');
  assert.deepEqual(result.fixtureTerminal, terminal);
  assert.equal(result.nativeStatus, 'invalid');
  assert.equal(result.nativeReceiptError, 'NATIVE_FIXTURE_WORKER_RECEIPT_UNREADABLE');
  assert.equal(result.ordinaryUnchanged, true);
  assert.equal(result.remainingFixturePids.length, 0);
});

test('stopped ordinary admits only no host or the separately spawned fixture cohort', () => {
  const main = { pid: 100, type: '' };
  const helper = { pid: 101, type: 'helper' };
  const unexpected = { pid: 200, type: '' };
  assert.equal(stoppedOrdinaryCohort([]), true);
  assert.equal(stoppedOrdinaryCohort([], 100), false);
  assert.equal(stoppedOrdinaryCohort([main]), false);
  assert.equal(stoppedOrdinaryCohort([main, helper], 100), true);
  assert.equal(stoppedOrdinaryCohort([main, unexpected], 100), false);
  assert.equal(stoppedOrdinaryCohort([unexpected], 100), false);
  assert.equal(stoppedOrdinaryCohort(null), false);
});

test('fixture host admission is chosen from tracked versions and exhausts only the reviewed bundled sources', () => {
  const source = fs.readFileSync(new URL('./native-fixture.mjs', import.meta.url), 'utf8');
  const helpers = source.slice(source.indexOf('function loadFixtureAdmission('), source.indexOf('async function stoppedSnapshot('));
  const files = [];
  const support = 'Cyberpunk 2077 Support for Vortex exact';
  const sourceCommit = 'a'.repeat(40), appAsarSha256 = 'b'.repeat(64), indexHash = 'c'.repeat(64);
  const manifest = { schema: 'stock-vortex-source-admission/1', vortexVersion: '2.10.1', appAsarSha256,
    provenance: { vortexSourceCommit: sourceCommit }, extensions: [
      { kind: 'bundled', folder: 'offered-by-stock', files: [{ path: 'index.cjs', sha256: indexHash }] },
      { kind: 'user', folder: support, files: [{ path: 'index.js', sha256: indexHash }] },
      { kind: 'user', folder: 'ordinary-profile-plugin', files: [{ path: 'index.js', sha256: indexHash }] },
    ] };
  const { loadFixtureAdmission, reviewedFixtureExtensions } = vm.runInNewContext(helpers
    + '; ({loadFixtureAdmission, reviewedFixtureExtensions})', {
    fs: { readFileSync: file => { files.push(file); return Buffer.from(JSON.stringify(manifest)); } },
    must: (ok, code) => { if (!ok) throw Error(code); },
    here: 'C:\\review', path: path.win32, sha: () => 'd'.repeat(64),
  });
  assert.throws(() => loadFixtureAdmission('..\\evil'), /FIXTURE_HOST_VERSION_UNREVIEWED/);
  assert.equal(files.length, 0);
  const review = loadFixtureAdmission('2.10.1');
  assert.equal(files[0], 'C:\\review\\stock-vortex-2.10.1-admission.json');
  const resolved = reviewedFixtureExtensions(review, path.win32.join('C:\\support', support), indexHash,
    'C:\\Program Files\\Vortex\\Vortex.exe');
  assert.equal(resolved.hostVersion, '2.10.1');
  assert.equal(resolved.appAsarSha256, appAsarSha256);
  assert.equal(resolved.supportIndexSha256, indexHash);
  assert.equal(resolved.dynamicSources.length, 1);
  assert.equal(resolved.dynamicSources[0].path,
    'C:\\Program Files\\Vortex\\resources\\app.asar.unpacked\\bundledPlugins\\offered-by-stock');
  assert.throws(() => reviewedFixtureExtensions(review, support, appAsarSha256, 'C:/Vortex.exe'),
    /FIXTURE_SUPPORT_NOT_STOCK_REVIEWED/);
  assert.throws(() => reviewedFixtureExtensions(review, 'ordinary-profile-plugin', indexHash, 'C:/Vortex.exe'),
    /FIXTURE_SUPPORT_NOT_STOCK_REVIEWED/);
  delete manifest.provenance.vortexSourceCommit;
  assert.throws(() => loadFixtureAdmission('2.10.1'), /FIXTURE_HOST_ADMISSION_INVALID/);
});
