import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {pathToFileURL, fileURLToPath} from 'node:url';
import job from './install-job-contract.cjs';
import dispatch from './native-dispatch-contract.cjs';
import {
  RELAY_NODE_SHA256, RELAY_SOURCE_NAMES, readRelaySourceClosure,
  snapshotNativeExecutorRuntimeBinding, createBoundOwnedZipRelay,
} from './owned-zip-relay-client.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PREP = path.resolve(HERE, '../../../local-state/native-runtime-binding/prep');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const json = value => Buffer.from(JSON.stringify(value));
const normalize = value => path.resolve(value).replaceAll('\\', '/');
function tuple(workspaceRoot, sourceSHA256 = readRelaySourceClosure()) {
  return {schema:'native-executor-runtime-binding/1', workspaceRoot:normalize(workspaceRoot),
    relayNodeSHA256:RELAY_NODE_SHA256, sourceSHA256};
}
function copiedSDK() {
  fs.mkdirSync(PREP, {recursive:true});
  const root = fs.mkdtempSync(path.join(PREP, 'sdk-'));
  const sdk = path.join(root, 'tools/modding/vortex-agent');
  fs.mkdirSync(sdk, {recursive:true});
  for (const name of RELAY_SOURCE_NAMES) fs.copyFileSync(path.join(HERE, name), path.join(sdk, name));
  return {root, sdk};
}
function request(root) {
  const h = '1'.repeat(64);
  const plan = {schema:'install-job-plan/1', family:'tracked-new-disabled', contractId:job.CONTRACT_ID,
    context:{gameId:'cyberpunk2077',profileId:'own-runtime-binding',
      gamePath:path.join(root,'model-game'),stagingPath:path.join(root,'model-stage'),downloadPath:path.join(root,'archives'),
      filesystemIds:{gamePath:'1:2',stagingPath:'1:3',downloadPath:'1:4'}},
    package:{downloadId:'own-archive',fileName:'own.zip',expectedModId:'own',expectedType:'',bytes:7,sha256:h,
      md5:'2'.repeat(32),expectedUncompressedBytes:1,payload:{'own.txt':h}},
    evidence:{buildSHA256:h,sourceSHA256:h,nativeAdmissionSHA256:h},options:{enabled:false,deploy:false}};
  return {schema:'native-dispatch-request/1',contractId:dispatch.CONTRACT_ID,operationId:'op_'+'3'.repeat(32),
    nativeJobId:'exec_'+'4'.repeat(32),planId:job.installPlanId(plan),managerScope:'manager-own-fixture-1',
    rendererGeneration:'renderer_'+'5'.repeat(32),admissionSHA256:h,plan};
}

test('canonical bound tuple is detached, fixed15 and frozen', () => {
  const input = tuple(path.resolve(HERE,'../../..'));
  const bytes = json(input), result = snapshotNativeExecutorRuntimeBinding(bytes);
  bytes.fill(0);
  assert.equal(RELAY_SOURCE_NAMES.length,15);
  assert.deepEqual(result,input);
  assert(Object.isFrozen(result));
  assert(Object.isFrozen(result.sourceSHA256));
});

test('binding rejects BOM, duplicates, extra fields, missing or reordered closure, and oversized bytes', () => {
  const input = tuple(path.resolve(HERE,'../../..')), bytes = json(input);
  const missing = structuredClone(input); delete missing.sourceSHA256['paths-core.cjs'];
  const reorder = {...input, sourceSHA256:Object.fromEntries(Object.entries(input.sourceSHA256).reverse())};
  for (const bad of [Buffer.concat([Buffer.from([239,187,191]),bytes]), Buffer.concat([bytes,Buffer.from('\n')]),
    Buffer.from(bytes.toString().replace('"schema":', '"schema":"duplicate","schema":')),
    json({...input, extra:true}), json(missing), json(reorder), json({...input,relayNodeSHA256:'0'.repeat(64)}),
    json({...input,workspaceRoot:input.workspaceRoot+'/../foreign'}), Buffer.alloc(8193), {},
    new Proxy(bytes,{})]) assert.throws(()=>snapshotNativeExecutorRuntimeBinding(bad));
  const shared = new Uint8Array(new SharedArrayBuffer(bytes.length));shared.set(bytes);
  assert.throws(()=>snapshotNativeExecutorRuntimeBinding(shared));
});

test('wrong physical workspace and source hashes refuse before parsing request or spawning', () => {
  const root = path.resolve(HERE,'../../..');
  assert.throws(()=>createBoundOwnedZipRelay(Buffer.from('{}'),Buffer.from('{}'),json(tuple(path.dirname(root)))), /RUNTIME_LAYOUT/);
  const bad = tuple(root);bad.sourceSHA256={...bad.sourceSHA256,'paths-core.cjs':'0'.repeat(64)};
  assert.throws(()=>createBoundOwnedZipRelay(Buffer.from('{}'),Buffer.from('{}'),json(bad)),/RUNTIME_SOURCE/);
});

test('real copied15 SDK imports synchronously and binds explicit workspace despite hostile environment and cwd', () => {
  const f = copiedSDK();
  const script = `const fs=require('node:fs'),p=JSON.parse(fs.readFileSync(0,'utf8'));const m=require(p.module);
    const closure=m.readRelaySourceClosure();const input={schema:'native-executor-runtime-binding/1',workspaceRoot:p.root,relayNodeSHA256:m.RELAY_NODE_SHA256,sourceSHA256:closure};
    const o=m.createBoundOwnedZipRelay(Buffer.from(JSON.stringify(p.request)),Buffer.from('{}'),Buffer.from(JSON.stringify(input)));
    const core=require(p.core);const j=require(p.journal);const i=require(p.intent);
    process.stdout.write(JSON.stringify({status:o.status(),coreKeys:Object.keys(core),journal:typeof j.createNativeExecutorJournal,intent:typeof i.createNativeIntentJournal}));`;
  const r = spawnSync(process.execPath,['-e',script],{cwd:path.parse(f.root).root,
    env:{...process.env,NEXUS_WORKSPACE:'relative-hostile',NEXUS_CONTEXT_ROOT:'relative-hostile',NODE_OPTIONS:'',NODE_PATH:''},
    input:JSON.stringify({module:path.join(f.sdk,'owned-zip-relay-client.mjs'),core:path.join(f.sdk,'paths-core.cjs'),
      journal:path.join(f.sdk,'native-executor-journal.mjs'),intent:path.join(f.sdk,'native-intent-journal.mjs'),root:normalize(f.root),request:request(f.root)}),
    encoding:'utf8',windowsHide:true,timeout:10000});
  assert.equal(r.status,0,r.stderr);
  const result=JSON.parse(r.stdout);
  assert.equal(result.status.mode,'staging');assert.equal(result.status.relayPid,null);
  assert.equal(result.status.startAttempted,false);assert.equal(result.status.phase,'not_started');
  assert.deepEqual(result.coreKeys,['absolute','resolvePaths']);assert.equal(result.journal,'function');
  const facade=spawnSync(process.execPath,['-e','require('+JSON.stringify(path.join(f.sdk,'paths.cjs'))+')'],{
    env:{...process.env,NEXUS_WORKSPACE:'relative-hostile'},encoding:'utf8',windowsHide:true});
  assert.notEqual(facade.status,0);assert.match(facade.stderr,/NEXUS_WORKSPACE_ABSOLUTE_PATH_REQUIRED/);
});

test('captured binding remains authority after factory creation and refuses source drift before child spawn',async()=>{
  const f=copiedSDK(),m=await import(pathToFileURL(path.join(f.sdk,'owned-zip-relay-client.mjs')));
  const binding=tuple(f.root,m.readRelaySourceClosure());
  const owner=m.createBoundOwnedZipRelay(json(request(f.root)),Buffer.from('{}'),json(binding));
  fs.appendFileSync(path.join(f.sdk,'paths-core.cjs'),'\n// own source drift\n');
  await assert.rejects(owner.prepare(json({schema:'native-executor-anchor/1',rootId:'1:2',inventorySHA256:'6'.repeat(64)})),/SOURCE_CHANGED/);
  assert.equal(owner.status().relayPid,null);
});


test('readiness cannot substitute a mutually matching changed child and disk closure for captured binding',async()=>{
  const cp=await import('node:child_process'), {syncBuiltinESMExports}=await import('node:module');
  const {Socket}=await import('node:net');
  const f=copiedSDK(),m=await import(pathToFileURL(path.join(f.sdk,'owned-zip-relay-client.mjs')));
  const binding=tuple(f.root,m.readRelaySourceClosure());
  const owner=m.createBoundOwnedZipRelay(json(request(f.root)),Buffer.from('{}'),json(binding));
  const original=cp.default.spawn;let child,invocation;
  cp.default.spawn=(exe,args,options)=>{
    invocation={exe,args,options};
    child=new cp.ChildProcess();child.pid=123456;
    child.stdin=new Socket();child.stdout=new Socket();child.stderr=new Socket();
    child.stdio=[child.stdin,child.stdout,child.stderr];
    queueMicrotask(()=>{
      child.emit('spawn');
      fs.appendFileSync(path.join(f.sdk,'paths-core.cjs'),'\n// changed after spawn\n');
      child.stdout.emit('data',Buffer.from(JSON.stringify({schema:'owned-zip-relay-ready/1',relayLifetime:'relay_'+'a'.repeat(32),
        pid:child.pid,nodeVersion:'24.20.0',nodeSHA256:m.RELAY_NODE_SHA256,sourceSHA256:m.readRelaySourceClosure(),workspace:path.resolve(f.root)})+'\n'));
    });
    return child;
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(owner.prepare(json({schema:'native-executor-anchor/1',rootId:'1:2',inventorySHA256:'6'.repeat(64)})),/READY_MISMATCH/);
    assert.equal(owner.status().startSent,false);
    assert.equal(invocation.exe,m.RELAY_NODE);
    assert.deepEqual(invocation.args,[path.join(f.sdk,'owned-zip-relay-runner.mjs')]);
    assert.deepEqual(Object.keys(invocation.options.env).sort(),['NEXUS_WORKSPACE','SystemRoot']);
    assert.equal(invocation.options.env.NEXUS_WORKSPACE,path.resolve(f.root));
    assert.equal(invocation.options.cwd,f.sdk);
    assert.equal(invocation.options.windowsHide,true);
  } finally {
    cp.default.spawn=original;syncBuiltinESMExports();
    if(child){for(const s of child.stdio)s.destroy();child.emit('exit',1,null);child.emit('close',1,null);}
  }
});


// Reuse the already reviewed test-only fixture and exact child retirement code.
// These are never part of the runtime closure or a production recovery route.
const relayTests=fs.readFileSync(path.join(HERE,'owned-zip-relay.test.mjs'),'utf8');
const pythonFixture=new Function('return '+relayTests.slice(relayTests.indexOf('const FIXTURE = ')+16,relayTests.indexOf('\nfunction fixture()')).trim().replace(/;$/,''))();
const helperStart=relayTests.indexOf('const PROCESS_HELPER = ')+23;
const processHelper=new Function('return '+relayTests.slice(helperStart,relayTests.indexOf('\nconst children = new Map();',helperStart)).trim().replace(/;$/,''))();
assert.equal(sha(processHelper),'b07784ced0b745d646c00e48220931286c257428af902b75c79540e6455bc34d');
const nativeEnabled=process.platform==='win32' && process.env.VORTEX_BOUND_RELAY_TEST==='1';
test('actual copied bound SDK prepares without START under hostile environment and joins inert cancellation',{
  skip:!nativeEnabled,timeout:45000,
},async()=>{
  const cp=await import('node:child_process'),{syncBuiltinESMExports}=await import('node:module');
  fs.mkdirSync(PREP,{recursive:true});
  const root=path.join(PREP,'run-'+crypto.randomBytes(16).toString('hex'));
  const generated=spawnSync('C:/Python314/python.exe',['-I','-S','-B','-c',pythonFixture,root],{
    encoding:'utf8',windowsHide:true,timeout:10000,maxBuffer:32768});
  assert.equal(generated.status,0,generated.stderr);
  const fixture=JSON.parse(generated.stdout),sdk=path.join(root,'tools/modding/vortex-agent');
  fs.mkdirSync(sdk,{recursive:true});
  for(const name of RELAY_SOURCE_NAMES)fs.copyFileSync(path.join(HERE,name),path.join(sdk,name));
  const m=await import(pathToFileURL(path.join(sdk,'owned-zip-relay-client.mjs')));
  const j=await import(pathToFileURL(path.join(sdk,'native-executor-journal.mjs')));
  const r=request(root);r.plan.package={...r.plan.package,bytes:fixture.archive.bytes,sha256:fixture.archive.sha256,
    md5:fixture.md5,expectedUncompressedBytes:fixture.total,payload:fixture.payload};
  for(const key of ['gamePath','stagingPath','downloadPath']){
    const s=fs.statSync(r.plan.context[key],{bigint:true});r.plan.context.filesystemIds[key]=`${s.dev}:${s.ino}`;
  }
  r.planId=job.installPlanId(r.plan);
  const journalRoot=path.join(root,'local-state/vortex-agent-build/native-install-executor');
  fs.mkdirSync(path.dirname(journalRoot),{recursive:true});fs.mkdirSync(journalRoot);
  const journal=j.createNativeExecutorJournal({root:journalRoot}),before=journal.inventory();
  assert.equal(before.complete,true);assert.equal(before.records.length,0);
  const anchor=json({schema:'native-executor-anchor/1',rootId:before.observedRootId,inventorySHA256:before.observedInventorySHA256});
  const binding=tuple(root,m.readRelaySourceClosure()),sourceBefore=m.readRelaySourceClosure();
  const envKeys=['NEXUS_WORKSPACE','NEXUS_CONTEXT_ROOT','NODE_OPTIONS','NODE_PATH'];
  const oldEnv=Object.fromEntries(envKeys.map(k=>[k,process.env[k]]));
  const original=cp.default.spawn;let child,identity,relay;
  cp.default.spawn=(file,args,options)=>{
    const c=original(file,args,options);
    if(file===m.RELAY_NODE){
      child=c;
      const p=spawnSync('C:/Python314/python.exe',['-I','-S','-B','-c',processHelper,'capture',String(c.pid)],{
        encoding:'utf8',windowsHide:true,timeout:5000,maxBuffer:8192});
      assert.equal(p.status,0,p.stderr);identity=JSON.parse(p.stdout);
      fs.writeFileSync(path.join(root,'EXACT-CHILD.json'),JSON.stringify({identity,args,helperSHA256:sha(processHelper)}),{flag:'wx'});
    }
    return c;
  };
  syncBuiltinESMExports();
  let prepared;
  try{
    process.env.NEXUS_WORKSPACE='relative-hostile';process.env.NEXUS_CONTEXT_ROOT='relative-hostile';
    process.env.NODE_OPTIONS='--invalid-hostile-fixture-option';process.env.NODE_PATH='relative-hostile';
    relay=m.createBoundOwnedZipRelay(json(r),json(fixture.archive),json(binding));
    await assert.rejects(relay.start(),/STAGING_PREPARE_REQUIRED/);
    prepared=await relay.prepare(anchor);
    await relay.waitFor('ready',5000);
    assert.equal(prepared.schema,'owned-zip-worker-prepared/1');
    const observed=journal.read(r.operationId,prepared.binding.requestSHA256,r.nativeJobId,prepared.packetSHA256);
    assert.equal(observed.dispatchState,'unknown');assert.equal(observed.canReplay,false);
    assert.equal(relay.status().sdk.startSent,false);
    assert.equal(fs.existsSync(path.join(root,'local-state/owned-zip-worker-work',r.operationId)),false);
    assert.equal(fs.existsSync(path.join(root,'model-stage','own')),false);
    await relay.cancel();await relay.release();await relay.waitFor('closed',5000);
    const final=relay.status();
    assert.equal(final.relayTerminal.childResourcesClosed,true);assert.equal(final.relayTerminal.exitSucceeded,true);
    assert.equal(final.sdk.workerTerminal.childResourcesClosed,true);assert.equal(final.sdk.startSent,false);
    assert.equal(journal.read(r.operationId,prepared.binding.requestSHA256,r.nativeJobId,prepared.packetSHA256).canReplay,false);
    assert.deepEqual(m.readRelaySourceClosure(),sourceBefore);
    fs.writeFileSync(path.join(root,'RESULT.json'),JSON.stringify({schema:'bound-relay-fixture/1',prepared,final,identity,
      sourceBefore,sourceAfter:m.readRelaySourceClosure(),helperSHA256:sha(processHelper),nativeHostEffects:false})+'\n',{flag:'wx'});
  }finally{
    for(const k of envKeys){if(oldEnv[k]===undefined)delete process.env[k];else process.env[k]=oldEnv[k];}
    cp.default.spawn=original;syncBuiltinESMExports();
    if(relay&&!relay.status().relayTerminal?.childResourcesClosed){
      try{
        const bounded=p=>Promise.race([p,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('CLEANUP_TIMEOUT')),3000);timer.unref();})]);
        if(!relay.status().cancelAttempted&&!relay.status().releaseAttempted)await bounded(relay.cancel());
        if(!relay.status().releaseAttempted)await bounded(relay.release());
        await relay.waitFor('closed',5000);
      }catch(error){
        assert.ok(child&&identity,'Exact fixture identity unavailable; preserve and report');
        const retired=spawnSync('C:/Python314/python.exe',['-I','-S','-B','-c',processHelper,'retire',String(child.pid),identity.creationTime,root,PREP],{
          encoding:'utf8',windowsHide:true,timeout:15000,maxBuffer:32768});
        assert.equal(retired.status,0,retired.stderr);
        await relay.waitFor('closed',5000);
        fs.writeFileSync(path.join(root,'FAILED-RETIREMENT.json'),JSON.stringify({error:String(error),retired:JSON.parse(retired.stdout),status:relay.status()})+'\n',{flag:'wx'});
        throw error;
      }
    }
  }
});
