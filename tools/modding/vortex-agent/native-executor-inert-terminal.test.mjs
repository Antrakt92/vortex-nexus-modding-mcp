// Pure filesystem codec/transition tests. Evidence hashes are fixture claims,
// not actual worker closure, Main ownership, cancellation or installation proof.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createNativeExecutorJournal, appendNativeExecutorTerminalAnchored} from './native-executor-journal.mjs';

// Reuse the existing reviewed request/dual-index/transition fixtures without
// importing that test module (which would register and run its test bodies).
let helpers;
function fixtureHelpers() {
  if (helpers) return helpers;
  const url = new URL('./native-executor-terminal-transition.test.mjs', import.meta.url);
  const original = fs.readFileSync(url, 'utf8');
  const marker = "\ntest('module helper preserves exact old six-method factory ABI";
  assert.equal(original.split(marker).length, 2);
  let source = original.slice(0, original.indexOf(marker));
  const scratch = "../../../local-state/native-completion/recovery/journal-cases";
  assert.equal(source.split(scratch).length, 2);
  source = source.replace(scratch, '../../../local-state/native-inert-terminal-tests');
  source = source.replace(/(from\s*['"])(\.\/[^'"]+)(['"])/g,
    (_all, before, relative, after) => before + new URL(relative, url).href + after)
    .replaceAll('import.meta.url', JSON.stringify(url.href));
  source += '\nexport {fixture,request,binding,begin,anchor,terminalPath,withFS,onTerminalDir,assertHeld,evidence,encode,sha,packet};\n';
  helpers = import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
  return helpers;
}
const inertEvidence = () => ({schema: 'native-executor-terminal-evidence/3',
  outcome: 'prepared_no_start_cancelled_worker_closed', inertCancelObservationSHA256: '1'.repeat(64),
  workerClosureObservationSHA256: '2'.repeat(64), ownershipHoldObservationSHA256: '3'.repeat(64)});
const noAuthority = value => {
  for (const key of ['canReplay', 'effectsAllowed', 'installationPermit', 'powerLossPersistenceVerified',
    'independentCompletionVerified', 'currentStateVerified']) assert.equal(value[key], false, key);
};
function close(h, f, b, seal = h.anchor(f.store), evidence = inertEvidence()) {
  return appendNativeExecutorTerminalAnchored(f.store, b, h.encode(evidence), seal);
}

test('v3 direct append stores no registration/adoption/release fiction and preserves six-method ABI', async () => {
  const h = await fixtureHelpers(), f = h.fixture(), b = h.begin(f);
  assert(Object.isFrozen(f.store));
  assert.deepEqual(Object.keys(f.store), ['begin', 'read', 'appendTerminal', 'inventory', 'reservePending', 'provision']);
  let getters = 0;
  const fake = {get inventory() {getters++; assert.fail('foreign journal getter');}};
  assert.throws(() => appendNativeExecutorTerminalAnchored(fake,b,h.encode(inertEvidence()),h.anchor(f.store)), /INVALID_JOURNAL/);
  assert.equal(getters, 0);
  const observed = f.store.appendTerminal(b, h.encode(inertEvidence()));
  assert.equal(observed.state, 'historical_closed'); noAuthority(observed);
  const record = JSON.parse(fs.readFileSync(h.terminalPath(f)));
  assert.deepEqual(Object.keys(record), ['schema','operationId','nativeJobId','requestSHA256','packetSHA256','workerLifetime',
    'rootId','jobsRootId','jobDirectoryId','terminalsRootId','directoryId','outcome','inertCancelObservationSHA256',
    'workerClosureObservationSHA256','ownershipHoldObservationSHA256','evidenceSHA256']);
  assert.equal(record.schema, 'native-executor-terminal/3');
  assert.equal(record.outcome, inertEvidence().outcome);
  assert.equal(record.evidenceSHA256, h.sha(h.encode(inertEvidence())));
  for (const field of ['fullRecordSHA256','registrationObservationSHA256','adoptionObservationSHA256','releaseObservationSHA256'])
    assert.equal(Object.hasOwn(record, field), false, field);
  const fresh = createNativeExecutorJournal({root: f.root});
  const status = fresh.read(b.operationId, b.requestSHA256, b.nativeJobId, b.packetSHA256);
  assert.equal(status.state, 'reserved'); assert.equal(status.dispatchState, 'unknown');
  assert.equal(status.reconcileRequired, true); assert.equal(status.canReplay, false);
  const census = fresh.inventory(); assert.equal(census.closedCount, 1); assert.equal(census.startupHoldRequired, true);
  assert.equal(census.historySealVerified, false); noAuthority(census);
});

test('v3 anchored B to C uses the unchanged ten-field transition and remains historical only', async () => {
  const h = await fixtureHelpers(), f = h.fixture(), b = h.begin(f), before = h.anchor(f.store);
  const result = close(h, f, b, before);
  assert.deepEqual(Object.keys(result), ['schema','rootId','previousInventorySHA256','inventorySHA256',
    'operationId','nativeJobId','requestSHA256','packetSHA256','workerLifetime','evidenceSHA256']);
  assert(Object.isFrozen(result)); assert.equal(result.schema, 'native-executor-terminal-transition/1');
  assert.equal(result.previousInventorySHA256, JSON.parse(before).inventorySHA256);
  assert.notEqual(result.inventorySHA256, result.previousInventorySHA256);
  const fresh = createNativeExecutorJournal({root: f.root}), stale = fresh.inventory({
    expectedRootId: result.rootId, expectedInventorySHA256: result.previousInventorySHA256});
  assert.equal(stale.historySealVerified, false); assert.equal(stale.startupHoldRequired, true);
  // An independently supplied Main C is modeled here; this codec cannot mint it.
  const closed = fresh.inventory({expectedRootId: result.rootId, expectedInventorySHA256: result.inventorySHA256});
  assert.equal(closed.complete, true); assert.equal(closed.historySealVerified, true);
  assert.equal(closed.startupHoldRequired, false); assert.equal(closed.closedCount, 1);
  assert.equal(closed.unresolvedCount, 0); assert.equal(closed.discoveryPermit, false); noAuthority(closed);
});

test('old v1 and v2 terminal bytes survive v3 publication in the same journal', async () => {
  const h = await fixtureHelpers(), f = h.fixture(), old = [h.request(1), h.request(2)];
  const legacy = {...h.evidence(), schema: 'native-executor-terminal-evidence/1', outcome: 'committed_adopted_closed'};
  delete legacy.ownershipHoldObservationSHA256; legacy.releaseObservationSHA256 = '5'.repeat(64);
  f.store.appendTerminal(h.begin(f, old[0]), h.encode(legacy));
  f.store.appendTerminal(h.begin(f, old[1]), h.encode(h.evidence()));
  const files = old.flatMap(r => [path.join(f.root,'operations',r.operationId,'intent.json'),
    path.join(f.root,'jobs',r.nativeJobId,'binding.json'),h.terminalPath(f,r)]);
  const original = new Map(files.map(file => [file,fs.readFileSync(file)]));
  const b = h.begin(f,h.request(3)); close(h,f,b);
  for (const [file,bytes] of original) assert.deepEqual(fs.readFileSync(file), bytes);
  assert.equal(JSON.parse(fs.readFileSync(h.terminalPath(f,old[0]))).schema, 'native-executor-terminal/1');
  assert.equal(JSON.parse(fs.readFileSync(h.terminalPath(f,old[1]))).schema, 'native-executor-terminal/2');
  assert.equal(f.store.inventory().closedCount, 3);
});

test('cancelled operation and job IDs remain consumed after reopening while a distinct operation can close', async () => {
  const h = await fixtureHelpers(), f = h.fixture(), first = h.request(), b = h.begin(f,first);
  const transition = close(h,f,b), c = h.encode({schema:'native-executor-anchor/1',rootId:transition.rootId,inventorySHA256:transition.inventorySHA256});
  const original = fs.readFileSync(h.terminalPath(f,first));
  assert.throws(() => close(h,f,b,c), /TERMINAL_TRANSITION_CONSUMED/);
  for (const r of [first,h.request(1,9),h.request(9,1)]) {
    const fresh = createNativeExecutorJournal({root:f.root}), next = h.binding(r);
    assert.throws(() => fresh.reservePending(h.encode(r),next.workerLifetime,next.packetSHA256,c), /RESERVATION_CONSUMED/);
  }
  const fresh = createNativeExecutorJournal({root:f.root}), r = h.request(2), next = h.binding(r);
  fresh.reservePending(h.encode(r),next.workerLifetime,next.packetSHA256,c);
  const successor = appendNativeExecutorTerminalAnchored(fresh,next,h.encode(inertEvidence()),h.anchor(fresh));
  assert.equal(successor.operationId,r.operationId); assert.equal(fresh.inventory().closedCount,2);
  assert.deepEqual(fs.readFileSync(h.terminalPath(f,first)),original);
  assert.equal(fs.existsSync(path.join(f.root,'operations',first.operationId)),true);
  assert.equal(fs.existsSync(path.join(f.root,'jobs',first.nativeJobId)),true);
});

test('v3 rejects mixed fields/versions/outcomes and noncanonical evidence before publication', async () => {
  const h = await fixtureHelpers(), f = h.fixture(), b = h.begin(f), seal = h.anchor(f.store);
  const bad = [
    {...inertEvidence(),schema:'native-executor-terminal-evidence/2'},
    {...inertEvidence(),schema:'native-executor-terminal-evidence/4'},
    {...inertEvidence(),outcome:'committed_adopted_worker_closed'},
    {...inertEvidence(),outcome:'cancelled'},
    {...inertEvidence(),fullRecordSHA256:'f'.repeat(64)},
    {...inertEvidence(),registrationObservationSHA256:'f'.repeat(64)},
    {...inertEvidence(),adoptionObservationSHA256:'f'.repeat(64)},
    {...inertEvidence(),releaseObservationSHA256:'f'.repeat(64)},
    {...inertEvidence(),effectsAllowed:false},
    {...inertEvidence(),workerClosureObservationSHA256:null},
    {...inertEvidence(),ownershipHoldObservationSHA256:'F'.repeat(64)},
  ].map(h.encode);
  const missing = inertEvidence(); delete missing.inertCancelObservationSHA256; bad.push(h.encode(missing));
  bad.push(Buffer.from(JSON.stringify(inertEvidence()).replace('{','{"outcome":"ignored",')),
    h.encode(Object.fromEntries(Object.entries(inertEvidence()).reverse())),
    Buffer.concat([Buffer.from([239,187,191]),h.encode(inertEvidence())]),
    Buffer.concat([h.encode(inertEvidence()),Buffer.from([255])]), Buffer.alloc(8193),
    new Uint8Array(new SharedArrayBuffer(20)),new Proxy(h.encode(inertEvidence()),{}));
  for (const bytes of bad) {
    assert.throws(() => f.store.appendTerminal(b,bytes), /INVALID_TERMINAL/);
    assert.throws(() => appendNativeExecutorTerminalAnchored(f.store,b,bytes,seal), /INVALID_TERMINAL/);
  }
  const legacy = {...h.evidence(),schema:'native-executor-terminal-evidence/1',outcome:'committed_adopted_closed'};
  delete legacy.ownershipHoldObservationSHA256; legacy.releaseObservationSHA256 = '5'.repeat(64);
  assert.throws(() => appendNativeExecutorTerminalAnchored(f.store,b,h.encode(legacy),seal), /INVALID_TERMINAL/);
  assert.equal(fs.existsSync(path.dirname(h.terminalPath(f))),false);
  assert.equal(close(h,f,b,seal).operationId,b.operationId);
});

test('cached v3 inventory rejects persisted version, binding and evidence substitutions', async () => {
  const h = await fixtureHelpers();
  for (const mutate of [r=>{r.schema='native-executor-terminal/2';},r=>{r.outcome='committed_adopted_worker_closed';},
    r=>{r.fullRecordSHA256='f'.repeat(64);},r=>{r.inertCancelObservationSHA256='f'.repeat(64);},
    r=>{r.workerLifetime='worker_'+'f'.repeat(32);},r=>{r.rootId='9:9';}]) {
    const f=h.fixture(),b=h.begin(f);f.store.appendTerminal(b,h.encode(inertEvidence()));
    const file=h.terminalPath(f),record=JSON.parse(fs.readFileSync(file));mutate(record);fs.writeFileSync(file,JSON.stringify(record)+'\n');
    const fresh=createNativeExecutorJournal({root:f.root}),observation=fresh.inventory();
    assert.equal(observation.complete,false);assert.equal(observation.startupHoldRequired,true);noAuthority(observation);
    assert.throws(()=>fresh.appendTerminal(b,h.encode(inertEvidence())),/TERMINAL_EXISTS_HOLD/);
  }
});

test('wrong trusted root or old census cannot bless v3 and leaves the attempt sticky held', async () => {
  const h=await fixtureHelpers();
  for(const field of ['rootId','inventorySHA256']){
    const f=h.fixture(),b=h.begin(f),anchor=JSON.parse(h.anchor(f.store));
    anchor[field]=field==='rootId'?'9:9':'f'.repeat(64);
    assert.throws(()=>close(h,f,b,h.encode(anchor)),/PREDECESSOR_NOT_SEALED/);
    assert.equal(fs.existsSync(path.dirname(h.terminalPath(f))),false);h.assertHeld(f);
    assert.equal(f.store.inventory().unresolvedCount,1);
  }
});

test('v3 reentry through a filesystem callback holds the outer transition without another operation', async () => {
  const h=await fixtureHelpers(),f=h.fixture(),b=h.begin(f),seal=h.anchor(f.store);let entered=false;
  h.withFS('lstatSync',(original,...args)=>{
    if(!entered){entered=true;const r=h.request(99),other=h.binding(r);
      assert.throws(()=>f.store.begin(h.encode(r),other.workerLifetime,other.packetSHA256),/TERMINAL_TRANSITION_BUSY/);}
    return original(...args);
  },()=>assert.throws(()=>close(h,f,b,seal),/TERMINAL_TRANSITION_HELD/));
  assert(entered);assert.equal(fs.existsSync(path.join(f.root,'operations',h.request(99).operationId)),false);h.assertHeld(f);
});

test('unknown acknowledgement after immutable v3 publication cannot retry or bless the old seal', async () => {
  const h=await fixtureHelpers(),f=h.fixture(),b=h.begin(f),seal=h.anchor(f.store),target=h.terminalPath(f);let published=false;
  h.withFS('linkSync',(original,from,to,...args)=>{
    const value=original(from,to,...args);
    if(String(to)===target){published=true;throw Error('owned uncertain terminal publication');}
    return value;
  },()=>assert.throws(()=>close(h,f,b,seal),/NATIVE_EXECUTOR_IO_FAILED/));
  assert(published);assert.equal(fs.existsSync(target),true);h.assertHeld(f);
  const old=JSON.parse(seal),fresh=createNativeExecutorJournal({root:f.root}).inventory({expectedRootId:old.rootId,expectedInventorySHA256:old.inventorySHA256});
  assert.equal(fresh.historySealVerified,false);assert.equal(fresh.startupHoldRequired,true);noAuthority(fresh);
});

test('a self-consistent old terminal byte rewrite cannot be hidden by the v3 successor census', async () => {
  const h=await fixtureHelpers(),f=h.fixture(),r=h.request(),first=h.begin(f,r);
  f.store.appendTerminal(first,h.encode(h.evidence()));
  const next=h.request(2),b=h.begin(f,next),seal=h.anchor(f.store),oldFile=h.terminalPath(f,r);let changed=false;
  h.onTerminalDir(f,next,()=>assert.throws(()=>close(h,f,b,seal),/TERMINAL_TRANSITION_CHANGED/),()=>{
    changed=true;const old=JSON.parse(fs.readFileSync(oldFile));fs.writeFileSync(oldFile,JSON.stringify(Object.fromEntries(Object.entries(old).reverse()))+'\n');
  });
  assert(changed);h.assertHeld(f);
  const old=JSON.parse(seal),fresh=createNativeExecutorJournal({root:f.root}).inventory({expectedRootId:old.rootId,expectedInventorySHA256:old.inventorySHA256});
  assert.equal(fresh.startupHoldRequired,true);assert.equal(fresh.historySealVerified,false);noAuthority(fresh);
});
