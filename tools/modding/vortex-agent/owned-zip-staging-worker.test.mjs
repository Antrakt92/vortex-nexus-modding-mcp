// Opt-in actual NTFS custody tests: fresh own synthetic staging, never Vortex.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {fileURLToPath} from 'node:url';
import job from './install-job-contract.cjs';
import dispatch from './native-dispatch-contract.cjs';
import {createNativeExecutorJournal} from './native-executor-journal.mjs';
import * as sdk from './owned-zip-worker-client.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TASK = path.resolve(HERE, '../../../local-state/install-contract-20261031/owned-zip-staging-worker');
const ENABLED = process.platform === 'win32' && process.arch === 'x64'
  && process.env.VORTEX_OWNED_ZIP_WORKER_TEST === '1';
const ownTest = (name, fn) => test(name, {skip: !ENABLED, timeout: 60000}, fn);
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const nonce = () => crypto.randomBytes(16).toString('hex');
const encode = value => Buffer.from(JSON.stringify(value));
const SETUP = `
import sys,json,pathlib,hashlib,zipfile
r=pathlib.Path(sys.argv[1]);r.mkdir(parents=True,exist_ok=False)
for n in ['archives','synthetic-game','synthetic-staging']:(r/n).mkdir()
p=r/'archives/own.zip';payload={};total=0
with zipfile.ZipFile(p,'x',zipfile.ZIP_STORED,allowZip64=False) as z:
 for name,data in [('a.txt',b'own staging bytes'),('nested/b.bin',b'xyz'*8192)]:
  z.writestr(name,data);payload[name]=hashlib.sha256(data).hexdigest();total+=len(data)
def identity(p):
 s=p.stat();return {'schema':'win-file-id128/1','volumeSerialNumber':str(s.st_dev),'fileId':str(s.st_ino)}
b=p.read_bytes()
print(json.dumps({'archive':{'parent':str(p.parent),'parentIdentity':identity(p.parent),'leaf':p.name,'identity':identity(p),'bytes':len(b),'sha256':hashlib.sha256(b).hexdigest()},'payload':payload,'total':total,'md5':hashlib.md5(b).hexdigest(),'stagingIdentity':identity(r/'synthetic-staging')}))
`;

function archiveGuardFixture() {
  const roots={gamePath:'C:/own-guard-game',stagingPath:'C:/own-guard-stage',downloadPath:'C:/own-guard-downloads'};
  const plan={schema:'install-job-plan/1',family:'tracked-new-disabled',contractId:job.CONTRACT_ID,
    context:{gameId:'cyberpunk2077',profileId:'archive-guard',...roots,filesystemIds:{gamePath:'1:1',stagingPath:'1:2',downloadPath:'1:3'}},
    package:{downloadId:'own-archive',fileName:'own.zip',expectedModId:'own',expectedType:'',bytes:32,sha256:'a'.repeat(64),md5:'b'.repeat(32),expectedUncompressedBytes:1,payload:{'a.txt':'c'.repeat(64)}},
    evidence:{buildSHA256:'d'.repeat(64),sourceSHA256:'e'.repeat(64),nativeAdmissionSHA256:'f'.repeat(64)},options:{enabled:false,deploy:false}};
  const request={schema:'native-dispatch-request/1',contractId:dispatch.CONTRACT_ID,operationId:'op_'+nonce(),nativeJobId:'exec_'+nonce(),
    planId:job.installPlanId(plan),managerScope:'manager-archive-guard-1',rendererGeneration:'renderer_'+nonce(),admissionSHA256:'f'.repeat(64),plan};
  const archive={parent:roots.downloadPath,parentIdentity:{schema:'win-file-id128/1',volumeSerialNumber:'1',fileId:'3'},
    leaf:'own.zip',identity:{schema:'win-file-id128/1',volumeSerialNumber:'1',fileId:'4'},bytes:32,sha256:'a'.repeat(64)};
  return{request,archive};
}
test('staging archive parent and independent Node identity bind before spawn without coercing native identity',()=>{
  const names=['mkdirSync','writeFileSync','openSync','linkSync','lstatSync','readFileSync'];
  const originals=new Map(names.map(n=>[n,fs[n]])),spawn=childProcess.spawn;let effects=0,reads=0;
  const refuse=()=>{effects++;throw Error('Unexpected archive guard IO');};
  for(const name of names)fs[name]=refuse;
  // Controlled read-only Node stat domain, deliberately different from native64.
  fs.lstatSync=()=>{reads++;return{dev:1n,ino:3n,size:0n,mtimeNs:1n,ctimeNs:1n,nlink:1n,isDirectory:()=>true,isSymbolicLink:()=>false};};
  childProcess.spawn=refuse;syncBuiltinESMExports();
  try{
    const wrongPath=archiveGuardFixture();wrongPath.archive.parent='C:/another-downloads';
    assert.throws(()=>sdk.createOwnedStagingZipWorker(encode(wrongPath.request),encode(wrongPath.archive)),/ARCHIVE_CONTEXT_MISMATCH/);assert.equal(reads,0);
    for(const nodeId of ['1:5','2:3']){
      const input=archiveGuardFixture();input.request.plan.context.filesystemIds.downloadPath=nodeId;input.request.planId=job.installPlanId(input.request.plan);
      assert.equal(sdk.createOwnedZipWorker(encode(input.request),encode(input.archive)).status().startAttempted,false,'Scratch legacy remains admitted but inert');
      assert.throws(()=>sdk.createOwnedStagingZipWorker(encode(input.request),encode(input.archive)),/ARCHIVE_CONTEXT_MISMATCH/);
      assert.equal(effects,0);
    }
    const canonical=archiveGuardFixture();canonical.archive.parent='c:\\OWN-GUARD-DOWNLOADS';
    canonical.archive.parentIdentity.volumeSerialNumber='6967734032932866884';canonical.archive.parentIdentity.fileId=(2n**100n+3n).toString();
    assert.equal(sdk.createOwnedStagingZipWorker(encode(canonical.request),encode(canonical.archive)).status().startAttempted,false);
    assert.equal(canonical.archive.parentIdentity.volumeSerialNumber,'6967734032932866884');assert.equal(canonical.archive.parentIdentity.fileId,(2n**100n+3n).toString());
    const external=archiveGuardFixture();external.archive.md5=external.request.plan.package.md5;
    assert.throws(()=>sdk.createOwnedStagingZipWorker(encode(external.request),encode(external.archive)),/INVALID_ARCHIVE/);
    assert.equal(effects,0);
  }finally{for(const [name,fn]of originals)fs[name]=fn;childProcess.spawn=spawn;syncBuiltinESMExports();}
});

function fixture() {
  fs.mkdirSync(path.join(TASK, 'tests'), {recursive: true});
  const root = path.join(TASK, 'tests', 'run-'+nonce());
  const made = childProcess.spawnSync('C:/Python314/python.exe', ['-I','-S','-B','-c',SETUP,root],
    {encoding: 'utf8', windowsHide: true, timeout: 10000, maxBuffer: 1024*1024});
  assert.equal(made.status, 0, made.stderr);
  const value = JSON.parse(made.stdout);
  const roots = {gamePath: path.join(root, 'synthetic-game'), stagingPath: path.join(root, 'synthetic-staging'),
    downloadPath: path.join(root, 'archives')};
  const filesystemIds = Object.fromEntries(Object.entries(roots).map(([key, file]) => {
    const stat = fs.statSync(file, {bigint: true}); return [key, `${stat.dev}:${stat.ino}`];
  }));
  const evidence = sha(Buffer.from('Own synthetic staging only; no managed destination admission'));
  const plan = {schema: 'install-job-plan/1', family: 'tracked-new-disabled', contractId: job.CONTRACT_ID,
    context: {gameId: 'cyberpunk2077', profileId: 'staging-fixture', ...roots, filesystemIds},
    package: {downloadId: 'fixture-own', fileName: 'own.zip', expectedModId: 'own', expectedType: '',
      bytes: value.archive.bytes, sha256: value.archive.sha256, md5: value.md5,
      expectedUncompressedBytes: value.total, payload: value.payload},
    evidence: {buildSHA256: evidence, sourceSHA256: evidence, nativeAdmissionSHA256: evidence},
    options: {enabled: false, deploy: false}};
  const request = {schema: 'native-dispatch-request/1', contractId: dispatch.CONTRACT_ID,
    operationId: 'op_'+nonce(), nativeJobId: 'exec_'+nonce(), planId: job.installPlanId(plan),
    managerScope: 'manager-staging-fixture-1', rendererGeneration: 'renderer_'+nonce(), admissionSHA256: evidence, plan};
  // Process-local test receipts; production runtime workspace is never selected.
  process.env.NEXUS_WORKSPACE = path.join(TASK, 'coordinator-runtime');
  return {root, request, value, archive: encode(value.archive), target: path.join(roots.stagingPath, 'own')};
}
function factory(input) {
  assert.equal(typeof sdk.createOwnedStagingZipWorker, 'function', 'Reviewed staging SDK must be present');
  return sdk.createOwnedStagingZipWorker(encode(input.request), input.archive);
}
function owner(t, input) {
  const worker = factory(input);
  t.after(async () => {
    const state = worker.status();
    if (state.childClosed) return;
    if (!state.startSent) {await worker.retireInert(); return;}
    if (!['extracted','copied','cancelled'].includes(state.phase)) await worker.cancel();
    await worker.release();
  });
  return worker;
}
function identity(value) {
  assert.equal(value.schema, 'win-file-id128/1');
  for (const key of ['volumeSerialNumber','fileId']) assert.match(value[key], /^[1-9][0-9]*$/);
}
function stillHeld(worker) {
  const state = worker.inspectIntent();
  assert.equal(state.dispatchState, 'unknown'); assert.equal(state.canReplay, false);
  assert.equal(state.reconcileRequired, true); assert.equal(state.effectsAllowed, false);
}
async function capture(fn) {
  const original = childProcess.spawn, children = [];
  childProcess.spawn = (...args) => {const child = original(...args); children.push(child); return child;};
  syncBuiltinESMExports();
  try {return await fn(children);}
  finally {childProcess.spawn = original; syncBuiltinESMExports();}
}

ownTest('held synthetic parent is not replaceable and no final target exists before handoff', async t => {
  const input = fixture(), worker = owner(t, input);
  assert.equal(worker.status().workerPid, null);
  await worker.start(); await worker.waitFor('extracted', 15000);
  const state = worker.status(), destination = state.destination;
  assert.equal(destination.parent, input.request.plan.context.stagingPath);
  assert.equal(destination.leaf, input.request.plan.package.expectedModId);
  identity(destination.parentIdentity);
  assert.deepEqual(destination.parentIdentity, input.value.stagingIdentity);
  assert.equal(destination.directoryIdentity, null);
  assert.equal(fs.existsSync(input.target), false);
  assert.throws(() => fs.renameSync(destination.parent, path.join(input.root, 'renamed-staging')));
  assert.equal(fs.existsSync(destination.parent), true);
  await assert.rejects(async () => worker.copyProof());
  await worker.release();
  assert.equal(fs.existsSync(input.target), false);
});

ownTest('same-handle publish yields exact payload and bound proof, then releases all three pipes', async t => capture(async children => {
  const input = fixture(), worker = owner(t, input);
  await worker.start(); await worker.waitFor('extracted', 15000);
  await worker.handoff();
  const copied = worker.status(), proof = await worker.copyProof();
  identity(copied.destination.directoryIdentity);
  assert.equal(proof.schema, 'owned-zip-copy-proof/1');
  assert.deepEqual(proof.binding, copied.binding);
  assert.equal(proof.workerLifetime, copied.workerLifetime);
  assert.equal(proof.packetSHA256, copied.packetSHA256);
  assert.deepEqual(proof.destination, copied.destination);
  assert.equal(proof.copiedFiles, 2); assert.equal(proof.totalBytes, input.value.total);
  assert.equal(proof.files.length, 2);
  for (const row of proof.files) {
    assert.equal(row.sha256, input.value.payload[row.path]);
    const file = path.join(input.target, ...row.path.split('/'));
    assert.equal(fs.statSync(file).size, row.bytes);
    assert.equal(sha(fs.readFileSync(file)), row.sha256);
    identity(row.sourceIdentity); identity(row.destinationIdentity);
    assert.throws(() => fs.openSync(file, 'r+'));
  }
  proof.files[0].sha256 = '0'.repeat(64);
  assert.notEqual((await worker.copyProof()).files[0].sha256, proof.files[0].sha256, 'Returned proof is detached');
  assert.equal(copied.nativeInstallAccepted, false);
  stillHeld(worker);
  assert.throws(() => worker.handoff(), /HANDOFF_REFUSED/);
  await worker.release(); await worker.release();
  assert.equal(children.length, 1);
  assert.equal(worker.status().childClosed, true); assert.equal(worker.status().childExitCode, 0);
  assert.equal(children[0].stdin.destroyed, true);
  assert.equal(children[0].stdout.readableEnded, true); assert.equal(children[0].stderr.readableEnded, true);
  await assert.rejects(async () => worker.copyProof());
  for (const file of ['a.txt', path.join('nested','b.bin')]) fs.closeSync(fs.openSync(path.join(input.target,file), 'r+'));
}));

ownTest('case-fold existing target cannot be replaced or merged, and uncertainty stays held', async t => {
  const input = fixture(), existing = path.join(input.request.plan.context.stagingPath, 'OWN');
  fs.mkdirSync(existing); fs.writeFileSync(path.join(existing, 'keeper.txt'), 'preserve exact old bytes', {flag: 'wx'});
  const before = sha(fs.readFileSync(path.join(existing, 'keeper.txt'))), worker = owner(t, input);
  await worker.start(); await worker.waitFor('extracted', 15000);
  await assert.rejects(worker.handoff()); await worker.waitFor('held', 15000);
  assert.equal(sha(fs.readFileSync(path.join(existing, 'keeper.txt'))), before);
  assert.deepEqual(fs.readdirSync(existing), ['keeper.txt']);
  stillHeld(worker); await assert.rejects(async () => worker.copyProof());
  await worker.cancel(); await worker.release();
});

ownTest('v2-incompatible mod and archive IDs refuse before any SDK child spawn or destination creation', async () => capture(async children => {
  for (const change of [p => {p.package.fileName = 'own mod.zip'; p.package.expectedModId = 'own mod';},
    p => {p.package.downloadId = '_archive';}, p => {p.package.fileName = '__vortexown.zip'; p.package.expectedModId = '__vortexown';},
    p => {p.package.downloadId = 'Constructor';}, p => {p.package.downloadId = 'PROTOTYPE';}]) {
    const input = fixture(); change(input.request.plan); input.request.planId = job.installPlanId(input.request.plan);
    const leaf = input.request.plan.package.fileName;
    if (leaf !== input.value.archive.leaf) {
      fs.renameSync(path.join(input.value.archive.parent, input.value.archive.leaf), path.join(input.value.archive.parent, leaf));
      input.value.archive.leaf = leaf; input.archive = encode(input.value.archive);
    }
    const legacy = sdk.createOwnedZipWorker(encode(input.request), input.archive);
    assert.equal(legacy.status().startAttempted, false, 'The legacy scratch contract admits this otherwise valid descriptor');
    let worker;
    assert.throws(() => {worker = factory(input);}, /UNSUPPORTED_REGISTRATION_ID/);
    assert.equal(children.length, 0);
    if (worker) assert.equal(worker.status().startSent, false);
    assert.deepEqual(fs.readdirSync(input.request.plan.context.stagingPath), []);
  }
}));

ownTest('actual native64 and Node identities stay separate while wrong path or Node context remains inert',async()=>capture(async children=>{
  for(const change of [input=>{input.value.archive.parent=path.join(input.root,'other-archives');},
    input=>{input.request.plan.context.filesystemIds.downloadPath='1:3';input.request.planId=job.installPlanId(input.request.plan);}]){
    const input=fixture(),before=sha(fs.readFileSync(path.join(input.value.archive.parent,input.value.archive.leaf)));
    change(input);input.archive=encode(input.value.archive);
    assert.throws(()=>factory(input),/ARCHIVE_CONTEXT_MISMATCH/);assert.equal(children.length,0);
    assert.equal(fs.existsSync(input.target),false);
    assert.equal(sha(fs.readFileSync(path.join(input.request.plan.context.downloadPath,input.value.archive.leaf))),before);
  }
  const actual=fixture(),node=fs.lstatSync(actual.request.plan.context.downloadPath,{bigint:true});
  assert.equal(`${node.dev}:${node.ino}`,actual.request.plan.context.filesystemIds.downloadPath);
  assert.notEqual(actual.value.archive.parentIdentity.volumeSerialNumber,String(node.dev),'This real NTFS volume reproduces the distinct full-native64/Node-dev domains');
  assert.equal(factory(actual).status().startAttempted,false);assert.equal(children.length,0);
}));

ownTest('correct SHA with wrong plan MD5 or full native parent identity holds before Extract or target creation',async t=>{
 for(const kind of ['md5','native-parent']){
  const input=fixture(),file=path.join(input.value.archive.parent,input.value.archive.leaf),before=sha(fs.readFileSync(file));
  const actualMD5=input.request.plan.package.md5;
  if(kind==='md5'){input.request.plan.package.md5=(actualMD5[0]==='0'?'1':'0')+actualMD5.slice(1);input.request.planId=job.installPlanId(input.request.plan);assert.notEqual(input.request.plan.package.md5,actualMD5);}
  else{input.value.archive.parentIdentity.volumeSerialNumber=input.value.archive.parentIdentity.volumeSerialNumber==='1'?'2':'1';input.archive=encode(input.value.archive);}
  assert.equal(input.value.archive.sha256,before);
  const worker=owner(t,input);await worker.start();await worker.waitFor('held',15000);
  const state=worker.status();assert.equal(state.phase,'held');assert.equal(state.startSent,true);
  assert.equal(fs.existsSync(input.target),false);assert.equal(typeof state.worker.workRoot,'string');
  assert.equal(fs.existsSync(state.worker.workRoot),true);assert.equal(fs.existsSync(path.join(state.worker.workRoot,'Extract')),false);
  if(kind==='md5'){let opened,blocked=false;try{opened=fs.openSync(file,'r+');}catch{blocked=true;}finally{if(opened!==undefined)fs.closeSync(opened);}
    assert.equal(blocked,true,'The failed MD5 archive lease retains custody until explicit cancellation/release');}
  assert.equal(sha(fs.readFileSync(file)),before);stillHeld(worker);await assert.rejects(async()=>worker.copyProof());
  await worker.cancel();await worker.release();stillHeld(worker);
  assert.equal(fs.existsSync(state.worker.workRoot),true);assert.equal(fs.existsSync(input.target),false);
 }
});

ownTest('wrong Node context identity refuses before a final destination can be created', async t => {
  const input = fixture(); input.request.plan.context.filesystemIds.stagingPath = '1:1';
  input.request.planId = job.installPlanId(input.request.plan);
  let worker;
  await assert.rejects(async () => {worker = owner(t, input); await worker.start();});
  assert.equal(fs.existsSync(input.target), false);
  if (worker) assert.equal(worker.status().startSent, false);
});

ownTest('cancellation after extraction creates no final target and cannot be turned into a handoff', async t => {
  const input = fixture(), worker = owner(t, input);
  await worker.start(); await worker.waitFor('extracted', 15000);
  await worker.cancel(); assert.equal(worker.status().phase, 'cancelled');
  assert.throws(() => worker.handoff(), /HANDOFF_REFUSED/);
  await assert.rejects(async () => worker.copyProof());
  assert.equal(fs.existsSync(input.target), false);
  await worker.release();
});

ownTest('cancellation after destination creation retains its files and denies a successful copy proof', async t => {
  const input = fixture(), worker = owner(t, input);
  await worker.start(); await worker.waitFor('extracted', 15000);
  // Latest-status transport may coalesce copying into copied. Both observations
  // prove creation; an actual handoff failure must still fail before cancellation.
  const copy = worker.handoff();
  await Promise.race([worker.waitFor('copying', 15000), copy]);
  assert.equal(fs.existsSync(input.target), true);
  const settled = copy.then(() => null, error => error);
  await worker.cancel(); await settled;
  await assert.rejects(async () => worker.copyProof());
  assert.throws(() => worker.handoff(), /HANDOFF_REFUSED/);
  stillHeld(worker);
  await worker.release();
  assert.equal(fs.existsSync(input.target), true, 'Cancellation never recursively removes the created target');
});

ownTest('a released operation cannot begin another staging worker or overwrite its published target', async t => {
  const input = fixture(), first = owner(t, input);
  await first.start(); await first.waitFor('extracted', 15000); await first.handoff(); await first.release();
  const bytes = fs.readFileSync(path.join(input.target, 'a.txt'));
  const second = owner(t, input);
  await assert.rejects(second.start());
  assert.equal(second.status().startSent, false);
  assert.deepEqual(fs.readFileSync(path.join(input.target, 'a.txt')), bytes);
  await second.retireInert();
});

ownTest('actual guardian death after copy invalidates live proof and does not permit replay', async t => capture(async children => {
  const input = fixture(), worker = owner(t, input);
  await worker.start(); await worker.waitFor('extracted', 15000); await worker.handoff();
  assert.equal((await worker.copyProof()).files.length, 2);
  // Test-only exact retained child termination, after the autonomous pump is quiescent.
  // Production SDK exposes no active kill route and no cancellation timeout refund.
  assert.equal(children.length, 1); assert.equal(children[0].exitCode, null);
  const exited = new Promise(resolve => children[0].once('exit', () => {
    let refused = false;
    try {worker.copyProof();} catch {refused = true;}
    resolve({refused, observed: worker.status().workerTerminal.exitObserved});
  }));
  assert.equal(children[0].kill('SIGTERM'), true);
  await worker.waitFor('closed', 15000);
  assert.deepEqual(await exited, {refused: true, observed: true}, 'Native exit already ended custody before pipe closure');
  assert.equal(worker.status().errorCode, 'CUSTODY_LOST');
  await assert.rejects(async () => worker.copyProof());
  stillHeld(worker);
  assert.equal(sha(fs.readFileSync(path.join(input.target, 'a.txt'))), input.value.payload['a.txt']);
}));

ownTest('explicit staging prepare retains the real parent but creates no target until separately acknowledged START and handoff',async t=>{
 const input=fixture();process.env.NEXUS_WORKSPACE=path.join(input.root,'prepared-runtime');const journalRoot=path.join(process.env.NEXUS_WORKSPACE,'local-state/vortex-agent-build/native-install-executor');fs.mkdirSync(path.dirname(journalRoot),{recursive:true});fs.mkdirSync(journalRoot);const inventory=createNativeExecutorJournal({root:journalRoot}).inventory();assert.equal(inventory.complete,true);const anchor=encode({schema:'native-executor-anchor/1',rootId:inventory.observedRootId,inventorySHA256:inventory.observedInventorySHA256});
 const worker=owner(t,input),receipt=await worker.prepare(anchor);assert.equal(worker.status().startSent,false);assert.equal(fs.existsSync(input.target),false);assert.deepEqual(worker.status().destination.parentIdentity,input.value.stagingIdentity);assert.equal(worker.status().destination.directoryIdentity,null);assert.throws(()=>fs.renameSync(input.request.plan.context.stagingPath,path.join(input.root,'moved-stage')));
 await new Promise(resolve=>setTimeout(resolve,50));assert.equal(worker.status().startSent,false);fs.writeFileSync(path.join(input.root,'OWN-MAIN-ACK.json'),JSON.stringify(receipt.transition)+'\n',{flag:'wx'});await worker.startPrepared();await worker.waitFor('extracted',15000);assert.equal(fs.existsSync(input.target),false);await worker.handoff();assert.equal(worker.copyProof().files.length,2);await worker.release();assert.equal(worker.status().workerTerminal.childResourcesClosed,true);
});
