import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {createNativeExecutorJournal, INVENTORY_LIMITS} from './native-executor-journal.mjs';
import {createNativeIntentJournal} from './native-intent-journal.mjs';
import job from './install-job-contract.cjs';
import dispatch from './native-dispatch-contract.cjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const scratch = path.resolve(HERE, '../../../local-state/executor-journal-tests');
const moduleURL = new URL('./native-executor-journal.mjs', import.meta.url).href;
const hex = n => n.toString(16).padStart(32, '0');
const worker = 'worker_' + hex(1), packet = 'd'.repeat(64), h = 'a'.repeat(64);
const encode = value => Buffer.from(JSON.stringify(value));
function request(n = 1, nativeJob = n) {
  const plan = {schema: 'install-job-plan/1', family: 'tracked-new-disabled', contractId: job.CONTRACT_ID,
    context: {gameId: 'cyberpunk2077', profileId: 'fixture', gamePath: 'F:/Fixture/Game', stagingPath: 'F:/Fixture/Stage',
      downloadPath: 'D:/Fixture/Downloads', filesystemIds: {gamePath: '1:2', stagingPath: '1:3', downloadPath: '2:4'}},
    package: {downloadId: 'tracked', fileName: 'Own.zip', expectedModId: 'Own', expectedType: '', bytes: 200,
      sha256: h, md5: 'b'.repeat(32), expectedUncompressedBytes: 10, payload: {'r6/scripts/own.reds': h}},
    evidence: {buildSHA256: h, sourceSHA256: h, nativeAdmissionSHA256: h}, options: {enabled: false, deploy: false}};
  return {schema: 'native-dispatch-request/1', contractId: dispatch.CONTRACT_ID,
    operationId: 'op_' + hex(n), nativeJobId: 'exec_' + hex(nativeJob), planId: job.installPlanId(plan),
    managerScope: 'manager-fixture-1', rendererGeneration: 'renderer_' + hex(1), admissionSHA256: 'c'.repeat(64), plan};
}
const digest = r => dispatch.dispatchRequestDigest(encode(r));
function fixture() {
  fs.mkdirSync(scratch, {recursive: true});
  // Retain own regenerable fixtures; no recursive deletion or shared runtime roots.
  const workspace = fs.mkdtempSync(path.join(scratch, 'run-'));
  const root = path.join(workspace, 'executor');
  return {workspace, root, store: createNativeExecutorJournal({root})};
}
const read = (store, r = request(), p = packet) => store.read(r.operationId, digest(r), r.nativeJobId, p);
const bindingPath = (root, r = request()) => path.join(root, 'jobs', r.nativeJobId, 'binding.json');
const intentPath = (root, r = request()) => path.join(root, 'operations', r.operationId, 'intent.json');
const terminalPath = (root, r = request()) => path.join(root, 'terminals', r.operationId, 'terminal.json');
const rootIdentity = root => {const s = fs.lstatSync(root, {bigint: true}); return `${s.dev}:${s.ino}`;};
const binding = (r = request()) => ({operationId: r.operationId, nativeJobId: r.nativeJobId,
  requestSHA256: digest(r), packetSHA256: packet, workerLifetime: worker});
const evidence = () => ({schema: 'native-executor-terminal-evidence/1', outcome: 'committed_adopted_closed',
  fullRecordSHA256: '1'.repeat(64), registrationObservationSHA256: '2'.repeat(64),
  adoptionObservationSHA256: '3'.repeat(64), workerClosureObservationSHA256: '4'.repeat(64), releaseObservationSHA256: '5'.repeat(64)});
function noAuthority(value) {
  for (const key of ['canReplay', 'effectsAllowed', 'installationPermit', 'powerLossPersistenceVerified',
    'independentCompletionVerified', 'currentStateVerified']) assert.equal(value[key], false, key);
  assert.equal(value.historicalOnly, true);
}
function held(s) {
  assert.equal(s.dispatchState, 'unknown'); assert.equal(s.reconcileRequired, true);
  assert.equal(s.canReplay, false); assert.equal(s.effectsAllowed, false);
  assert.equal(s.powerLossPersistenceVerified, false);
}
function mutate(file, fn) {
  const value = JSON.parse(fs.readFileSync(file)); fn(value); fs.writeFileSync(file, JSON.stringify(value));
}

test('missing and invalid requests are inert unknowns, never an unused-operation permit', () => {
  const {root, store} = fixture(), r = request();
  const missing = read(store); held(missing); assert.equal(missing.state, 'not_observed');
  assert.equal(fs.existsSync(root), false);
  for (const args of [[encode({...r, extra: true}), worker, packet], [encode(r), 'worker_bad', packet],
    [encode(r), worker, 'bad'], [Buffer.from('{'), worker, packet]])
    assert.throws(() => store.begin(...args), /NATIVE_EXECUTOR_(INVALID_REQUEST|INVALID_WORKER_LIFETIME|INVALID_BINDING)/);
  assert.throws(() => store.read('../escape', digest(r), r.nativeJobId, packet), /INVALID_ID/);
  assert.throws(() => store.read(r.operationId, undefined, r.nativeJobId, packet), /INVALID_BINDING/);
  assert.equal(fs.existsSync(root), false);
});

test('immutable dual-index reservation survives a fresh bound reader and detaches input', () => {
  const {root, store} = fixture(), r = request(), bytes = encode(r);
  const result = store.begin(bytes, worker, packet); bytes.fill(0); r.plan.context.profileId = 'changed';
  held(result); assert.equal(result.state, 'reserved'); assert.equal(result.workerLifetime, worker);
  assert.equal(result.packetSHA256, packet); assert.equal(result.request.plan.context.profileId, 'fixture');
  assert(Object.isFrozen(result.request.plan)); assert.deepEqual(Object.keys(store).sort(), ['appendTerminal', 'begin', 'inventory', 'read']);
  assert.deepEqual(read(createNativeExecutorJournal({root})), result);
  assert.deepEqual(fs.readdirSync(path.dirname(bindingPath(root))), ['binding.json']);
  assert.deepEqual(fs.readdirSync(path.dirname(intentPath(root))), ['intent.json']);
});

test('every externally supplied read binding must match without modifying either index', () => {
  const {root, store} = fixture(), r = request(); store.begin(encode(r), worker, packet);
  const before = [intentPath(root), bindingPath(root)].map(p => fs.readFileSync(p));
  for (const args of [[request(2).operationId, digest(r), r.nativeJobId, packet],
    [r.operationId, 'e'.repeat(64), r.nativeJobId, packet],
    [r.operationId, digest(r), request(2).nativeJobId, packet],
    [r.operationId, digest(r), r.nativeJobId, 'e'.repeat(64)]])
    assert.throws(() => createNativeExecutorJournal({root}).read(...args), /NATIVE_EXECUTOR_/);
  [intentPath(root), bindingPath(root)].forEach((p, n) => assert(fs.readFileSync(p).equals(before[n])));
});

test('duplicates and same operation with another job never publish a second reservation', () => {
  const {root, store} = fixture(), r = request(); store.begin(encode(r), worker, packet);
  const original = fs.readFileSync(intentPath(root));
  for (const other of [r, request(1, 2)]) {
    assert.throws(() => createNativeExecutorJournal({root}).begin(encode(other), worker, packet), /INTENT_EXISTS_HOLD/);
    assert(fs.readFileSync(intentPath(root)).equals(original));
  }
  assert.deepEqual(fs.readdirSync(path.join(root, 'jobs')), [r.nativeJobId]);
});

test('same job with another operation preserves the new operation intent and original job', () => {
  const {root, store} = fixture(), first = request(1, 7), second = request(2, 7);
  store.begin(encode(first), worker, packet); const original = fs.readFileSync(bindingPath(root, first));
  assert.throws(() => createNativeExecutorJournal({root}).begin(encode(second), worker, packet), /JOB_EXISTS_HOLD/);
  const intent = createNativeIntentJournal({root: path.join(root, 'operations')}).read(second.operationId, digest(second));
  held(intent); assert.equal(intent.state, 'intent_observed');
  assert(fs.readFileSync(bindingPath(root, first)).equals(original));
  assert.throws(() => read(createNativeExecutorJournal({root}), second), /BINDING_MISMATCH/);
  assert.throws(() => createNativeExecutorJournal({root}).begin(encode(second), worker, packet), /INTENT_EXISTS_HOLD/);
});

test('empty or pending job reservations hold; a completed operation alone stays intent_only', () => {
  for (const mode of ['empty', 'pending', 'extra']) {
    const {root, store} = fixture(), r = request(); store.begin(encode(r), worker, packet);
    const file = bindingPath(root);
    if (mode === 'extra') fs.writeFileSync(path.join(path.dirname(file), 'foreign'), 'preserve');
    else fs.renameSync(file, mode === 'pending' ? path.join(path.dirname(file), '.binding.json.pending-held')
      : path.join(root, 'retained-binding.json'));
    assert.throws(() => read(createNativeExecutorJournal({root})), /CORRUPT/);
    assert.throws(() => createNativeExecutorJournal({root}).begin(encode(r), worker, packet), /INTENT_EXISTS_HOLD/);
  }
  const {root} = fixture(), r = request();
  createNativeIntentJournal({root: path.join(root, 'operations')}).begin(encode(r));
  const status = read(createNativeExecutorJournal({root})); held(status); assert.equal(status.state, 'intent_only');
  assert.equal(fs.existsSync(path.join(root, 'jobs')), false);
});

test('pre-existing incomplete job directories consume no retry and keep the newly written intent', () => {
  for (const pending of [false, true]) {
    const {root, store} = fixture(), r = request();
    const dir = path.dirname(bindingPath(root)); fs.mkdirSync(dir, {recursive: true});
    if (pending) fs.writeFileSync(path.join(dir, '.binding.json.pending-original'), 'original partial bytes');
    const before = fs.readdirSync(dir);
    assert.throws(() => read(createNativeExecutorJournal({root})), /CORRUPT/);
    assert.throws(() => store.begin(encode(r), worker, packet), /JOB_EXISTS_HOLD/);
    assert.deepEqual(fs.readdirSync(dir), before);
    assert.equal(createNativeIntentJournal({root: path.join(root, 'operations')})
      .read(r.operationId, digest(r)).state, 'intent_observed');
  }
});

test('a surviving job reservation without its operation stays unknown and cannot authorize replay', () => {
  const {root, store} = fixture(), r = request(); store.begin(encode(r), worker, packet);
  fs.renameSync(path.join(root, 'operations'), path.join(root, 'operations-retained'));
  const status = read(createNativeExecutorJournal({root}));
  held(status); assert.equal(status.state, 'reservation_only'); assert.equal(status.intentObserved, false);
  assert.equal(status.jobReservationObserved, true); assert.equal(status.request, null);
  assert.equal(fs.existsSync(path.join(root, 'operations')), false);
  const binding = fs.readFileSync(bindingPath(root));
  assert.throws(() => createNativeExecutorJournal({root}).begin(encode(r), worker, packet), /JOB_EXISTS_HOLD/);
  assert(fs.readFileSync(bindingPath(root)).equals(binding));
});

test('every persisted binding field and unexpected field is validated by fresh reads', () => {
  const changes = [r => {r.schema = 'other';}, r => {r.operationId = request(2).operationId;},
    r => {r.nativeJobId = request(2).nativeJobId;}, r => {r.requestSHA256 = 'e'.repeat(64);},
    r => {r.packetSHA256 = 'e'.repeat(64);}, r => {r.workerLifetime = 'invalid';},
    r => {r.rootId = '0:0';}, r => {r.jobsRootId = '0:0';}, r => {r.directoryId = '0:0';},
    r => {r.extra = true;}];
  for (const change of changes) {
    const {root, store} = fixture(); store.begin(encode(request()), worker, packet);
    mutate(bindingPath(root), change);
    assert.throws(() => read(createNativeExecutorJournal({root})), /NATIVE_EXECUTOR_(CORRUPT|BINDING_MISMATCH)/);
  }
});

test('moving original job children into replacement ancestors cannot make them authoritative', () => {
  for (const replaceRoot of [true, false]) {
    const {root, store} = fixture(); store.begin(encode(request()), worker, packet);
    const target = replaceRoot ? root : path.join(root, 'jobs'), retained = target + '-retained';
    fs.renameSync(target, retained); fs.mkdirSync(target);
    fs.renameSync(path.join(retained, replaceRoot ? 'jobs' : request().nativeJobId),
      path.join(target, replaceRoot ? 'jobs' : request().nativeJobId));
    if (replaceRoot) fs.renameSync(path.join(retained, 'operations'), path.join(target, 'operations'));
    assert.throws(() => read(store), /PATH_CHANGED/);
    assert.throws(() => read(createNativeExecutorJournal({root})), /CORRUPT/);
    assert(fs.existsSync(bindingPath(root)));
  }
});

test('symlink ancestors refuse without writing into the foreign target', () => {
  const {workspace} = fixture(), foreign = path.join(workspace, 'foreign'), alias = path.join(workspace, 'alias');
  fs.mkdirSync(foreign); fs.symlinkSync(foreign, alias, 'junction');
  const store = createNativeExecutorJournal({root: path.join(alias, 'executor')});
  assert.throws(() => store.begin(encode(request()), worker, packet), /UNSAFE_PATH/);
  assert.deepEqual(fs.readdirSync(foreign), []);
});

test('job binding publication I/O failures retain the intent and refuse another begin', () => {
  for (const method of ['writeFileSync', 'fsyncSync', 'linkSync', 'unlinkSync']) {
    const {root, store} = fixture(), original = fs[method]; let injected = false;
    fs[method] = (...args) => {
      const target = String(args[0]);
      // fd-only calls are selected by counting: the operation record is flushed first.
      if (method === 'fsyncSync' || method === 'writeFileSync') {
        fs[method].calls++;
        if (fs[method].calls === 2) {injected = true; throw Error('own binding flush failure');}
      } else if (target.includes(path.join(root, 'jobs'))) {injected = true; throw Error('own binding publication failure');}
      return original(...args);
    };
    fs[method].calls = 0;
    try {assert.throws(() => store.begin(encode(request()), worker, packet), /NATIVE_EXECUTOR_/);}
    finally {fs[method] = original;}
    assert(injected, method); assert(fs.existsSync(intentPath(root)));
    assert(fs.existsSync(path.dirname(bindingPath(root))));
    assert.throws(() => createNativeExecutorJournal({root}).begin(encode(request()), worker, packet), /INTENT_EXISTS_HOLD/);
  }
});

test('a completed binding writer close followed by an error is held even when fresh readback succeeds', () => {
  const {root, store} = fixture(), original = fs.closeSync; let injected = false;
  fs.closeSync = fd => {
    let selected = false;
    if (!injected && fs.existsSync(bindingPath(root))) {
      const opened = fs.fstatSync(fd, {bigint: true}), published = fs.lstatSync(bindingPath(root), {bigint: true});
      selected = opened.dev === published.dev && opened.ino === published.ino;
    }
    if (selected) {injected = true; original(fd); throw Error('own post-close interruption');}
    return original(fd);
  };
  try {assert.throws(() => store.begin(encode(request()), worker, packet), /IO_FAILED/);}
  finally {fs.closeSync = original;}
  assert(injected);
  const observed = read(createNativeExecutorJournal({root})); held(observed); assert.equal(observed.state, 'reserved');
  assert.throws(() => createNativeExecutorJournal({root}).begin(encode(request()), worker, packet), /INTENT_EXISTS_HOLD/);
});

test('replacing jobs root at reservation creation refuses even if original child is moved back', () => {
  const {root, store} = fixture(), original = fs.mkdirSync; let swapped = false;
  fs.mkdirSync = (file, ...args) => {
    const result = original(file, ...args);
    if (!swapped && String(file) === path.dirname(bindingPath(root))) {
      swapped = true;
      fs.renameSync(path.join(root, 'jobs'), path.join(root, 'jobs-retained'));
      original(path.join(root, 'jobs'));
      fs.renameSync(path.join(root, 'jobs-retained', request().nativeJobId), path.dirname(bindingPath(root)));
    }
    return result;
  };
  try {assert.throws(() => store.begin(encode(request()), worker, packet), /PATH_CHANGED/);}
  finally {fs.mkdirSync = original;}
  assert(swapped); assert.deepEqual(fs.readdirSync(path.dirname(bindingPath(root))), []);
  assert(fs.existsSync(intentPath(root)));
});

test('two real processes preserve both operation intents but reserve a shared job only once', {timeout: 15000}, async () => {
  const {root} = fixture(), requests = [request(11, 99), request(12, 99)];
  const code = `import {createNativeExecutorJournal} from ${JSON.stringify(moduleURL)};
    process.stdout.write('ready\\n');
    await new Promise(resolve => process.stdin.once('data', resolve));
    try {const status=createNativeExecutorJournal({root:process.argv[1]}).begin(Buffer.from(process.argv[2],'base64'),process.argv[3],process.argv[4]);
      process.stdout.write(JSON.stringify({ok:true,state:status.state})+'\\n');}
    catch(error){process.stdout.write(JSON.stringify({ok:false,code:error.message})+'\\n');}`;
  const runners = requests.map(r => {
    const child = spawn(process.execPath, ['--input-type=module', '--eval', code, root, encode(r).toString('base64'), worker, packet],
      {stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true});
    let output = '', errors = '', readyResolve;
    const ready = new Promise(resolve => {readyResolve = resolve;});
    const done = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {child.kill(); reject(Error('Own test child deadline'));}, 8000);
      child.on('error', error => {clearTimeout(timer); reject(error);});
      child.stdout.on('data', chunk => {output += chunk; if (output.includes('\n')) readyResolve();
        if (output.length > 8192) {child.kill(); reject(Error('Own test output limit'));}});
      child.stderr.on('data', chunk => {errors += chunk;
        if (errors.length > 8192) {child.kill(); reject(Error('Own test stderr limit'));}});
      child.on('close', exit => {clearTimeout(timer);
        try {assert.equal(exit, 0, errors); assert.equal(errors, ''); resolve(JSON.parse(output.trim().split('\n').at(-1)));}
        catch (error) {reject(error);}});
    });
    return {child, ready, done};
  });
  try {
    await Promise.race([Promise.all(runners.map(r => r.ready)), ...runners.map(r => r.done)]);
    runners.forEach(r => r.child.stdin.end('go'));
    const outcomes = await Promise.all(runners.map(r => r.done));
    assert.equal(outcomes.filter(r => r.ok).length, 1);
    assert.match(outcomes.find(r => !r.ok).code, /JOB_EXISTS_HOLD/);
    const binding = JSON.parse(fs.readFileSync(bindingPath(root, requests[0])));
    assert(requests.some(r => r.operationId === binding.operationId && digest(r) === binding.requestSHA256));
    for (const r of requests) assert.equal(createNativeIntentJournal({root: path.join(root, 'operations')})
      .read(r.operationId, digest(r)).state, 'intent_observed');
  } finally {runners.forEach(r => {if (r.child.exitCode === null) r.child.kill();});}
});

test('replacement of the jobs ancestor during the final record-name check is held', () => {
  const {root, workspace, store} = fixture();
  store.begin(encode(request()), worker, packet);
  const reader = createNativeExecutorJournal({root});
  const original = fs.opendirSync;
  const jobsRoot = path.join(root, 'jobs'), retained = path.join(workspace, 'retained-jobs');
  for (const candidate of [jobsRoot, retained])
    assert(path.resolve(candidate).startsWith(path.resolve(scratch)+path.sep));
  let scans = 0, swapped = false;
  fs.opendirSync = (file, ...args) => {
    if (String(file) === path.dirname(bindingPath(root)) && ++scans === 2) {
      fs.renameSync(jobsRoot, retained);
      fs.mkdirSync(jobsRoot);
      fs.renameSync(path.join(retained, request().nativeJobId), path.dirname(bindingPath(root)));
      swapped = true;
    }
    return original(file, ...args);
  };
  try {assert.throws(() => read(reader), /PATH_CHANGED|CORRUPT/);}
  finally {fs.opendirSync = original;}
  assert(swapped);
});

test('inventory missing/recreated roots cannot report a clean unanchored startup', () => {
  const {workspace, root, store} = fixture();
  const missing = store.inventory(); assert.equal(missing.complete, false); assert.equal(missing.startupHoldRequired, true);
  assert.equal(missing.observedRootId, null); assert.equal(missing.rootIdentityVerified, false); noAuthority(missing);
  assert.equal(fs.existsSync(root), false);
  fs.mkdirSync(root); const originalId = rootIdentity(root);
  const empty = store.inventory(); assert.equal(empty.complete, true); assert.equal(empty.observedRootId, originalId);
  assert.equal(empty.rootIdentityVerified, false); assert.equal(empty.startupHoldRequired, true);
  const anchored = store.inventory({expectedRootId: originalId});
  assert.equal(anchored.rootIdentityVerified, true); assert.equal(anchored.startupHoldRequired, true);
  assert.equal(anchored.observedEmpty, true); assert.equal(anchored.discoveryPermit, false);
  assert.equal(anchored.historySealVerified, false);
  const sealedEmpty = store.inventory({expectedRootId: originalId, expectedInventorySHA256: empty.observedInventorySHA256});
  assert.equal(sealedEmpty.historySealVerified, true); assert.equal(sealedEmpty.startupHoldRequired, false);
  assert.equal(sealedEmpty.discoveryPermit, false); noAuthority(sealedEmpty);
  fs.renameSync(root, path.join(workspace, 'retained-root')); fs.mkdirSync(root);
  const recreated = createNativeExecutorJournal({root}).inventory({expectedRootId: originalId});
  assert.equal(recreated.complete, false); assert.equal(recreated.rootIdentityVerified, false); assert.equal(recreated.startupHoldRequired, true);
  assert.match(recreated.code, /ROOT_ID_MISMATCH/);
});

test('terminal history is immutable and cross-index bound while begin/read remain compatible', () => {
  const {root, store} = fixture(), r = request(); const before = store.begin(encode(r), worker, packet);
  const terminal = store.appendTerminal(binding(r), encode(evidence()));
  noAuthority(terminal); assert.equal(terminal.state, 'historical_closed');
  assert.deepEqual(read(store, r), before);
  const fresh = createNativeExecutorJournal({root});
  const unanchored = fresh.inventory(); assert.equal(unanchored.complete, true); assert.equal(unanchored.closedCount, 1);
  assert.equal(unanchored.rootIdentityVerified, false); assert.equal(unanchored.startupHoldRequired, true);
  const rootOnly = fresh.inventory({expectedRootId: rootIdentity(root)});
  assert.equal(rootOnly.startupHoldRequired, true); assert.equal(rootOnly.historySealVerified, false);
  const result = fresh.inventory({expectedRootId: rootIdentity(root), expectedInventorySHA256: unanchored.observedInventorySHA256});
  noAuthority(result); assert.equal(result.complete, true); assert.equal(result.startupHoldRequired, false);
  assert.equal(result.historySealVerified, true);
  assert.equal(result.discoveryPermit, false); assert.equal(result.closedCount, 1); assert.equal(result.unresolvedCount, 0);
  assert.equal(result.records[0].state, 'historical_closed'); assert(Object.isFrozen(result.records));
  const old = fs.readFileSync(terminalPath(root));
  assert.throws(() => fresh.appendTerminal(binding(r), encode(evidence())), /TERMINAL_EXISTS_HOLD/);
  assert(fs.readFileSync(terminalPath(root)).equals(old));
  assert.throws(() => fresh.begin(encode(r), worker, packet), /INTENT_HELD/);
  assert.throws(() => fresh.begin(encode(request(2, 1)), worker, packet), /JOB_EXISTS_HOLD/);
});

test('closed history does not hide a second unresolved operation or grant replay', () => {
  const {root, store} = fixture(), a = request(1), b = request(2);
  store.begin(encode(a), worker, packet); store.appendTerminal(binding(a), encode(evidence()));
  store.begin(encode(b), worker, packet);
  const snapshot = store.inventory();
  const result = store.inventory({expectedRootId: rootIdentity(root), expectedInventorySHA256: snapshot.observedInventorySHA256});
  assert.equal(result.complete, true); assert.equal(result.closedCount, 1); assert.equal(result.unresolvedCount, 1);
  assert.equal(result.historySealVerified, true);
  assert.equal(result.startupHoldRequired, true); assert.equal(result.records[1].reason, 'terminal_missing'); noAuthority(result);
});

test('invalid terminal evidence/bindings are inert and never invoke accessors', () => {
  const {root, store} = fixture(), r = request(); store.begin(encode(r), worker, packet);
  for (const bytes of [encode({...evidence(), installationPermit: true}), encode({...evidence(), outcome: 'failed'}),
    Buffer.from(' ' + encode(evidence())), Buffer.from([255]),
    Buffer.from(encode(evidence()).toString().replace('"outcome":', '"outcome":"committed_adopted_closed","outcome":'))])
    assert.throws(() => store.appendTerminal(binding(r), bytes), /INVALID_TERMINAL/);
  let calls = 0; const getter = {...binding(r)};
  Object.defineProperty(getter, 'operationId', {enumerable: true, get() {calls++; throw Error('protected');}});
  assert.throws(() => store.appendTerminal(getter, encode(evidence())), /INVALID_BINDING/); assert.equal(calls, 0);
  assert.throws(() => store.appendTerminal(new Proxy(binding(r), {ownKeys() {calls++; throw Error('protected');}}), encode(evidence())), /INVALID_BINDING/);
  assert.equal(calls, 0); assert.equal(fs.existsSync(path.join(root, 'terminals')), false);
});

test('every terminal input binding must match actual intent/job records before publication', () => {
  for (const key of Object.keys(binding())) {
    const {root, store} = fixture(); store.begin(encode(request()), worker, packet);
    const value = {...binding(), [key]: key === 'operationId' ? request(2).operationId : key === 'nativeJobId'
      ? request(2).nativeJobId : key === 'workerLifetime' ? 'worker_' + hex(2) : 'e'.repeat(64)};
    assert.throws(() => store.appendTerminal(value, encode(evidence())), /NATIVE_EXECUTOR_/);
    assert.equal(fs.existsSync(path.join(root, 'terminals')), false);
  }
});

test('every persisted terminal identity/digest and unknown field fail closed under fresh inventory', () => {
  const identityKeys = ['operationId','nativeJobId','requestSHA256','packetSHA256','workerLifetime','rootId','jobsRootId',
    'jobDirectoryId','terminalsRootId','directoryId','fullRecordSHA256','registrationObservationSHA256',
    'adoptionObservationSHA256','workerClosureObservationSHA256','releaseObservationSHA256','evidenceSHA256','outcome','schema','extra'];
  for (const key of identityKeys) {
    const {root, store} = fixture(); store.begin(encode(request()), worker, packet); store.appendTerminal(binding(), encode(evidence()));
    mutate(terminalPath(root), value => {value[key] = 'changed';});
    const result = createNativeExecutorJournal({root}).inventory({expectedRootId: rootIdentity(root)});
    assert.equal(result.complete, false, key); assert.equal(result.startupHoldRequired, true); assert.equal(result.closedCount, 0);
  }
});

test('partial terminal publication never clears permanent intent/job consumption', () => {
  for (const method of ['writeFileSync','fsyncSync','linkSync','unlinkSync']) {
    const {root, store} = fixture(); store.begin(encode(request()), worker, packet);
    const original = fs[method]; let injected = false;
    fs[method] = (...args) => {if (!injected) {injected = true; throw Error('own terminal fault');} return original(...args);};
    try {assert.throws(() => store.appendTerminal(binding(), encode(evidence())), /NATIVE_EXECUTOR_/);}
    finally {fs[method] = original;}
    assert(injected); const result = createNativeExecutorJournal({root}).inventory({expectedRootId: rootIdentity(root)});
    assert.equal(result.complete, false); assert.equal(result.startupHoldRequired, true);
    assert.throws(() => createNativeExecutorJournal({root}).begin(encode(request()), worker, packet), /INTENT_EXISTS_HOLD/);
  }
});

test('a terminal published before a lost close acknowledgement is observed only as historical closure', () => {
  const {root, store} = fixture(); store.begin(encode(request()), worker, packet);
  const original = fs.closeSync; let injected = false;
  fs.closeSync = fd => {
    if (!injected && fs.existsSync(terminalPath(root))) {
      const opened = fs.fstatSync(fd, {bigint: true}), terminal = fs.lstatSync(terminalPath(root), {bigint: true});
      if (opened.dev === terminal.dev && opened.ino === terminal.ino) {injected = true; original(fd); throw Error('own lost close acknowledgement');}
    }
    return original(fd);
  };
  try {assert.throws(() => store.appendTerminal(binding(), encode(evidence())), /IO_FAILED/);}
  finally {fs.closeSync = original;}
  assert(injected); const result = createNativeExecutorJournal({root}).inventory({expectedRootId: rootIdentity(root)});
  assert.equal(result.complete, true); assert.equal(result.closedCount, 1); noAuthority(result);
  assert.throws(() => createNativeExecutorJournal({root}).appendTerminal(binding(), encode(evidence())), /EXISTS_HOLD/);
});

test('orphan intent/job and terminal without both original indexes stay held', () => {
  const orphanIntent = fixture(); createNativeIntentJournal({root: path.join(orphanIntent.root, 'operations')}).begin(encode(request()));
  const a = orphanIntent.store.inventory({expectedRootId: rootIdentity(orphanIntent.root)});
  assert.equal(a.complete, true); assert.equal(a.records[0].reason, 'intent_only'); assert.equal(a.startupHoldRequired, true);
  const {root, workspace, store} = fixture(); store.begin(encode(request()), worker, packet); store.appendTerminal(binding(), encode(evidence()));
  fs.renameSync(path.join(root, 'operations'), path.join(workspace, 'retained-operations'));
  const b = createNativeExecutorJournal({root}).inventory({expectedRootId: rootIdentity(root)});
  assert.equal(b.complete, false); assert.equal(b.closedCount, 0); assert.equal(b.startupHoldRequired, true);
});

test('record-count and aggregate-read limits stop before unbounded directory/file reads', () => {
  const {root, store} = fixture(); store.begin(encode(request()), worker, packet);
  const original = fs.opendirSync; let reads = 0, closes = 0;
  fs.opendirSync = (file, ...args) => String(file) === path.join(root, 'operations') ? {
    readSync() {reads++; return {name: 'op_' + hex(reads)};}, closeSync() {closes++;},
  } : original(file, ...args);
  let result;
  try {result = store.inventory();} finally {fs.opendirSync = original;}
  assert.equal(result.complete, false); assert.match(result.code, /LIMIT/); assert.equal(reads, INVENTORY_LIMITS.records + 1); assert.equal(closes, 1);
  const lstat = fs.lstatSync, open = fs.openSync; let opened = false;
  fs.lstatSync = (file, ...args) => {
    const value = lstat(file, ...args);
    return String(file) === intentPath(root) ? new Proxy(value, {get(target, key) {
      return key === 'size' ? BigInt(INVENTORY_LIMITS.bytes + 1) : Reflect.get(target, key, target);
    }}) : value;
  };
  fs.openSync = (file, ...args) => {if (String(file) === intentPath(root)) opened = true; return open(file, ...args);};
  try {result = createNativeExecutorJournal({root}).inventory();}
  finally {fs.lstatSync = lstat; fs.openSync = open;}
  assert.equal(result.complete, false); assert.match(result.code, /LIMIT/); assert.equal(opened, false);
});

test('late mutation of an earlier terminal invalidates the entire inventory', () => {
  const {root, store} = fixture();
  for (const n of [1,2]) {store.begin(encode(request(n)), worker, packet); store.appendTerminal(binding(request(n)), encode(evidence()));}
  const original = fs.closeSync; let changed = false;
  fs.closeSync = fd => {
    if (!changed) {
      const value = fs.fstatSync(fd, {bigint: true}), target = fs.lstatSync(terminalPath(root, request(2)), {bigint: true});
      if (value.dev === target.dev && value.ino === target.ino) {
        changed = true; mutate(terminalPath(root, request(1)), record => {record.fullRecordSHA256 = 'e'.repeat(64);});
      }
    }
    return original(fd);
  };
  let result;
  try {result = createNativeExecutorJournal({root}).inventory({expectedRootId: rootIdentity(root)});}
  finally {fs.closeSync = original;}
  assert(changed); assert.equal(result.complete, false); assert.equal(result.closedCount, 0); assert.equal(result.startupHoldRequired, true);
});

test('same reader cannot forget a previously observed job when other closed history remains', () => {
  const {root, workspace, store} = fixture();
  for (const n of [1,2]) {store.begin(encode(request(n)), worker, packet); store.appendTerminal(binding(request(n)), encode(evidence()));}
  assert.equal(store.inventory({expectedRootId: rootIdentity(root)}).closedCount, 2);
  for (const [kind, name] of [['operations', request(2).operationId], ['jobs', request(2).nativeJobId], ['terminals', request(2).operationId]])
    fs.renameSync(path.join(root, kind, name), path.join(workspace, 'retained-' + kind));
  const result = store.inventory({expectedRootId: rootIdentity(root)});
  assert.equal(result.complete, false); assert.match(result.code, /PATH_CHANGED/); assert.equal(result.startupHoldRequired, true);
});

test('trusted previous census detects a deleted pending operation while another closed operation remains', () => {
  const {root, workspace, store} = fixture();
  store.begin(encode(request(1)), worker, packet); store.begin(encode(request(2)), worker, packet);
  store.appendTerminal(binding(request(2)), encode(evidence()));
  const observed = store.inventory();
  // Test memory stands in for a separately trusted main-state anchor saved before deletion.
  const trusted = {expectedRootId: observed.observedRootId, expectedInventorySHA256: observed.observedInventorySHA256};
  const before = createNativeExecutorJournal({root}).inventory(trusted);
  assert.equal(before.historySealVerified, true); assert.equal(before.unresolvedCount, 1);
  for (const kind of ['operations','jobs']) {
    const name = kind === 'operations' ? request(1).operationId : request(1).nativeJobId;
    fs.renameSync(path.join(root, kind, name), path.join(workspace, 'retained-pending-' + kind));
  }
  const after = createNativeExecutorJournal({root}).inventory(trusted);
  assert.equal(after.complete, true); assert.equal(after.rootIdentityVerified, true);
  assert.equal(after.closedCount, 1); assert.equal(after.unresolvedCount, 0);
  assert.equal(after.historySealVerified, false); assert.equal(after.startupHoldRequired, true);
  assert.notEqual(after.observedInventorySHA256, trusted.expectedInventorySHA256); assert.match(after.code, /INVENTORY_MISMATCH/);
});

test('trusted nonempty census detects deletion of all history under the same root identity', () => {
  const {root, workspace, store} = fixture(); store.begin(encode(request()), worker, packet); store.appendTerminal(binding(), encode(evidence()));
  const observed = store.inventory(), trusted = {expectedRootId: observed.observedRootId, expectedInventorySHA256: observed.observedInventorySHA256};
  for (const kind of ['operations','jobs','terminals']) {
    const name = kind === 'jobs' ? request().nativeJobId : request().operationId;
    fs.renameSync(path.join(root, kind, name), path.join(workspace, 'retained-all-' + kind));
  }
  const result = createNativeExecutorJournal({root}).inventory(trusted);
  assert.equal(result.complete, true); assert.equal(result.observedEmpty, true); assert.equal(result.rootIdentityVerified, true);
  assert.equal(result.historySealVerified, false); assert.equal(result.startupHoldRequired, true); noAuthority(result);
});

test('census seal is deterministic and binds worker lifetime and canonical job record contents', () => {
  const {root, store} = fixture(); store.begin(encode(request()), worker, packet);
  const before = store.inventory(), trusted = {expectedRootId: before.observedRootId, expectedInventorySHA256: before.observedInventorySHA256};
  assert.equal(createNativeExecutorJournal({root}).inventory().observedInventorySHA256, before.observedInventorySHA256);
  const record = JSON.parse(fs.readFileSync(bindingPath(root))); record.workerLifetime = 'worker_' + hex(2);
  fs.writeFileSync(bindingPath(root), JSON.stringify(record) + '\n');
  const after = createNativeExecutorJournal({root}).inventory(trusted);
  assert.equal(after.complete, true); assert.equal(after.historySealVerified, false); assert.equal(after.startupHoldRequired, true);
  assert.notEqual(after.observedInventorySHA256, before.observedInventorySHA256);
});

test('inventory anchor options are closed own data and never invoke getters or initialize roots', () => {
  const {root, store} = fixture(); let calls = 0;
  const options = {get expectedInventorySHA256() {calls++; return 'a'.repeat(64);}};
  for (const value of [options, {expectedInventorySHA256:'bad'}, {expectedRootId:'1:2',extra:true}])
    assert.throws(() => store.inventory(value), /NATIVE_EXECUTOR_INVALID_/);
  assert.equal(calls, 0); assert.equal(fs.existsSync(root), false);
});

test('replacing a scanned jobs/terminals ancestor cannot adopt its moved original child', () => {
  for (const kind of ['jobs','terminals']) {
    const {root, workspace, store} = fixture(); store.begin(encode(request()), worker, packet); store.appendTerminal(binding(), encode(evidence()));
    const name = kind === 'jobs' ? request().nativeJobId : request().operationId;
    const parent = path.join(root, kind), child = path.join(parent, name), retained = path.join(workspace, 'retained-' + kind);
    const original = fs.opendirSync; let scans = 0, swapped = false;
    fs.opendirSync = (file, ...args) => {
      if (String(file) === child && ++scans === 2) {
        swapped = true; fs.renameSync(parent, retained); fs.mkdirSync(parent); fs.renameSync(path.join(retained, name), child);
      }
      return original(file, ...args);
    };
    let result;
    try {result = createNativeExecutorJournal({root}).inventory({expectedRootId: rootIdentity(root)});}
    finally {fs.opendirSync = original;}
    assert(swapped); assert.equal(result.complete, false); assert.equal(result.startupHoldRequired, true);
  }
});

test('two real processes append one immutable terminal without overwriting the other attempt', {timeout:15000}, async () => {
  const {root, store} = fixture(); store.begin(encode(request()), worker, packet);
  const code = `import {createNativeExecutorJournal} from ${JSON.stringify(moduleURL)};
    process.stdout.write('ready\\n');await new Promise(r=>process.stdin.once('data',r));
    try{const result=createNativeExecutorJournal({root:process.argv[1]}).appendTerminal(JSON.parse(process.argv[2]),Buffer.from(process.argv[3],'base64'));
      process.stdout.write(JSON.stringify({ok:true,state:result.state})+'\\n');}
    catch(error){process.stdout.write(JSON.stringify({ok:false,code:error.message})+'\\n');}`;
  const runners = [0,1].map(() => {
    const child=spawn(process.execPath,['--input-type=module','--eval',code,root,JSON.stringify(binding()),encode(evidence()).toString('base64')],{stdio:['pipe','pipe','pipe'],windowsHide:true});
    let output='',errors='',readyResolve;const ready=new Promise(r=>{readyResolve=r;});
    const done=new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{child.kill();reject(Error('Own terminal test child deadline'));},8000);
      child.on('error',e=>{clearTimeout(timer);reject(e);});
      child.stdout.on('data',c=>{output+=c;if(output.includes('\n'))readyResolve();if(output.length>8192){child.kill();reject(Error('Own output cap'));}});
      child.stderr.on('data',c=>{errors+=c;if(errors.length>8192){child.kill();reject(Error('Own stderr cap'));}});
      child.on('close',exit=>{clearTimeout(timer);try{assert.equal(exit,0,errors);assert.equal(errors,'');resolve(JSON.parse(output.trim().split('\n').at(-1)));}catch(e){reject(e);}});
    });return{child,ready,done};
  });
  try {
    await Promise.race([Promise.all(runners.map(r=>r.ready)),...runners.map(r=>r.done)]);runners.forEach(r=>r.child.stdin.end('go'));
    const results=await Promise.all(runners.map(r=>r.done));assert.equal(results.filter(r=>r.ok).length,1);
    assert.match(results.find(r=>!r.ok).code,/TERMINAL_EXISTS_HOLD/);
    assert.equal(createNativeExecutorJournal({root}).inventory({expectedRootId:rootIdentity(root)}).closedCount,1);
  } finally {runners.forEach(r=>{if(r.child.exitCode===null)r.child.kill();});}
});


test('growth between inventory admission and reader admission cannot spend uncharged bytes', () => {
  const {root, store} = fixture(); store.begin(encode(request()), worker, packet);
  const target = intentPath(root), before = fs.readFileSync(target);
  const lstat = fs.lstatSync, open = fs.openSync, read = fs.readSync, close = fs.closeSync;
  let injected = false, bytesRead = 0; const targetFDs = new Set();
  fs.lstatSync = (file, ...args) => {
    const stat = lstat(file, ...args);
    if (!injected && String(file) === target) {
      injected = true; fs.appendFileSync(target, ' '.repeat(1024 * 1024));
    }
    return stat;
  };
  fs.openSync = (file, ...args) => {
    const fd = open(file, ...args); if (String(file) === target) targetFDs.add(fd); return fd;
  };
  fs.readSync = (fd, ...args) => {const count = read(fd, ...args); if (targetFDs.has(fd)) bytesRead += count; return count;};
  fs.closeSync = fd => {targetFDs.delete(fd); return close(fd);};
  let result;
  try {result = createNativeExecutorJournal({root}).inventory();}
  finally {fs.lstatSync = lstat; fs.openSync = open; fs.readSync = read; fs.closeSync = close;}
  assert(injected); assert.equal(result.complete, false); assert.equal(result.startupHoldRequired, true);
  assert.equal(bytesRead, 0, 'grown file must be refused before opening, rather than charged its earlier small size');
  assert(before.length < 1024 * 1024); noAuthority(result);
});


test('inventory-only reader remembers validated pending jobs after both indexes move to keepers', () => {
  const {root, workspace, store} = fixture(); const req = request();
  store.begin(encode(req), worker, packet);
  const reader = createNativeExecutorJournal({root});
  const first = reader.inventory();
  assert.equal(first.complete, true); assert.equal(first.unresolvedCount, 1);
  for (const [kind, name] of [['operations', req.operationId], ['jobs', req.nativeJobId]])
    fs.renameSync(path.join(root, kind, name), path.join(workspace, 'inventory-only-keeper-' + kind));
  const second = reader.inventory();
  assert.equal(second.complete, false); assert.match(second.code, /PATH_CHANGED/);
  assert.equal(second.startupHoldRequired, true); assert.equal(second.observedInventorySHA256, null); noAuthority(second);
});
