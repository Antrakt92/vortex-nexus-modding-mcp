import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import terminal from './child-terminal-observer.cjs';
import {buildPythonSDKCapsule} from './native-sdk-python-capsule.mjs';
import capsuleLoader from './native-sdk-capsule-load.cjs';
import {buildNativeSDKCapsule} from './native-sdk-capsule-build.mjs';
import {captureNativeSDKSources,NATIVE_SDK_SOURCE_NAMES,readCapturedNativeSDKSource} from './native-sdk-capture.mjs';
import job from './install-job-contract.cjs';
import dispatch from './native-dispatch-contract.cjs';
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const source=process.env.VORTEX_CAPSULE_BUILD_SOURCE;
const sdk=process.env.VORTEX_CAPSULE_BUILD_SDK;
const bindingFile=process.env.VORTEX_CAPSULE_BUILD_BINDING;
const integration=(name,fn)=>test(name,{skip:source&&sdk&&bindingFile?false:'Set reviewed capsule build inputs'},fn);
let inputs;
async function ready() {
  if(inputs)return inputs;
  const binding=JSON.parse(fs.readFileSync(bindingFile));
  const capture=captureNativeSDKSources(sdk,binding.sourceSHA256);
  const require=createRequire(path.join(source,'src/main/package.json'));
  const compiler=await import(pathToFileURL(require.resolve('rolldown')).href);
  inputs={binding,capture,compiler:compiler.rolldown};return inputs;
}

integration('captured Main observes an own file through Python while its installer stays relay-only',async()=>{
  const {binding,capture,compiler}=await ready();
  const root=path.join(binding.workspaceRoot,'observer-'+crypto.randomBytes(16).toString('hex'));
  for(let node=path.dirname(root);;node=path.dirname(node)){
    const st=fs.lstatSync(node);assert(st.isDirectory()&&!st.isSymbolicLink());
    if(node===path.dirname(node))break;
  }
  fs.mkdirSync(root);
  const roots=Object.fromEntries(['gamePath','stagingPath','downloadPath'].map(k=>[k,path.join(root,k)]));
  for(const directory of Object.values(roots))fs.mkdirSync(directory);
  // Opaque own metadata fixture; observation does not claim ZIP format validity.
  const bytes=Buffer.from('Own read-only capsule observation fixture\n');
  fs.writeFileSync(path.join(roots.downloadPath,'own.zip'),bytes,{flag:'wx'});
  const filesystemIds=Object.fromEntries(Object.entries(roots).map(([k,p])=>{const st=fs.statSync(p,{bigint:true});return[k,`${st.dev}:${st.ino}`];}));
  const evidence=sha(Buffer.from('Synthetic read-only metadata; no installation admission'));
  const plan={schema:'install-job-plan/1',family:'tracked-new-disabled',contractId:job.CONTRACT_ID,
    context:{gameId:'cyberpunk2077',profileId:'observer-fixture',...roots,filesystemIds},
    package:{downloadId:'own',fileName:'own.zip',expectedModId:'own',expectedType:'',bytes:bytes.length,
      sha256:sha(bytes),md5:crypto.createHash('md5').update(bytes).digest('hex'),expectedUncompressedBytes:1,payload:{'own.bin':evidence}},
    evidence:{buildSHA256:evidence,sourceSHA256:evidence,nativeAdmissionSHA256:evidence},options:{enabled:false,deploy:false}};
  const request={schema:'native-dispatch-request/1',contractId:dispatch.CONTRACT_ID,operationId:'op_'+crypto.randomBytes(16).toString('hex'),
    nativeJobId:'exec_'+crypto.randomBytes(16).toString('hex'),managerScope:'manager-observer-fixture-1',rendererGeneration:'renderer_'+crypto.randomBytes(16).toString('hex'),
    admissionSHA256:evidence,planId:job.installPlanId(plan),plan};
  const bound={...binding,workspaceRoot:root.replaceAll('\\','/')};
  const built=await buildNativeSDKCapsule(capture,Buffer.from(JSON.stringify(bound)),compiler);
  const loaded=capsuleLoader.loadNativeSDKCapsule(Buffer.from(built.artifact),built.sha256,Buffer.from(JSON.stringify(bound)));
  const sdk=loaded.modules['owned-zip-worker-client.mjs'],raw=Buffer.from(JSON.stringify(request));
  const owner=sdk.createOwnedArchiveObserver(raw);
  let primarySet=false,primary;
  try{
    const observed=await owner.observe();
    assert.deepEqual(Object.keys(observed),['parent','parentIdentity','leaf','identity','bytes','sha256']);
    assert.equal(observed.bytes,bytes.length);assert.equal(observed.sha256,sha(bytes));
    assert.equal(observed.identity.schema,'win-file-id128/1');
    const terminal=owner.status().workerTerminal;
    assert(terminal.childResourcesClosed&&terminal.exitSucceeded&&!terminal.held);
    for(const pipe of Object.values(terminal.pipes))assert(pipe.closeObserved&&!pipe.errorObserved);
    assert.equal(owner.status().errorCode,null);
    const installer=sdk.createOwnedStagingZipWorker(raw,Buffer.from(JSON.stringify(observed)));
    await assert.rejects(installer.start(),/CAPSULE_ROLE/);
    assert.equal(installer.status().workerPid,null,'Main installer cannot spawn Python');
    assert.deepEqual(fs.readFileSync(path.join(roots.downloadPath,'own.zip')),bytes);
    assert.deepEqual(fs.readdirSync(root).sort(),['downloadPath','gamePath','stagingPath']);
    assert.deepEqual(fs.readdirSync(roots.downloadPath),['own.zip']);
    assert.deepEqual(fs.readdirSync(roots.stagingPath),[]);
  }catch(error){primarySet=true;primary=error;}
  finally{
    try{
      const state=owner.status();if(!state.childClosed||!state.workerTerminal?.childResourcesClosed)await owner.release();
    }catch(error){if(!primarySet){primarySet=true;primary=error;}}
  }
  if(primarySet)throw primary;
});

integration('compiled Main role/version matrix refuses unsupported observers and installer before I/O',async()=>{
  const {binding,capture,compiler}=await ready();
  const built=await buildNativeSDKCapsule(capture,Buffer.from(JSON.stringify(binding)),compiler);
  const artifact=JSON.parse(built.artifact),code=Buffer.from(artifact.main.code,'base64').toString('utf8');
  // Synthetic plan bytes describe only this VM test. No paths are created and
  // no native admission, genuine frame, tracked association or install is claimed.
  const roots=Object.fromEntries(['gamePath','stagingPath','downloadPath'].map(key=>
    [key,path.join(binding.workspaceRoot,'role-matrix-not-created',key)]));
  const evidence=sha(Buffer.from('VM role gate model; no installation admission'));
  const plan={schema:'install-job-plan/1',family:'tracked-new-disabled',contractId:job.CONTRACT_ID,
    context:{gameId:'cyberpunk2077',profileId:'role-matrix',...roots,
      filesystemIds:{gamePath:'1:101',stagingPath:'1:102',downloadPath:'1:103'}},
    package:{downloadId:'own',fileName:'own.zip',expectedModId:'own',expectedType:'',bytes:1,
      sha256:evidence,md5:'b'.repeat(32),expectedUncompressedBytes:1,payload:{'own.txt':evidence}},
    evidence:{buildSHA256:evidence,sourceSHA256:evidence,nativeAdmissionSHA256:evidence},
    options:{enabled:false,deploy:false}};
  const request={schema:'native-dispatch-request/1',contractId:dispatch.CONTRACT_ID,
    operationId:'op_'+'1'.repeat(32),nativeJobId:'exec_'+'2'.repeat(32),managerScope:'manager-role-matrix-1',
    rendererGeneration:'renderer_'+'3'.repeat(32),admissionSHA256:evidence,planId:job.installPlanId(plan),plan};
  const raw=Buffer.from(JSON.stringify(request));
  dispatch.parseDispatchRequest(raw);
  const identity={schema:'win-file-id128/1',volumeSerialNumber:'1',fileId:'201'};
  const archive=Buffer.from(JSON.stringify({parent:roots.downloadPath,parentIdentity:identity,leaf:'own.zip',
    identity:{...identity,fileId:'202'},bytes:1,sha256:evidence}));
  const require=createRequire(import.meta.url);
  for(const row of [
    {role:'observer',electron:'44.1.0',node:'24.20.0',io:false},
    {role:'observer',electron:'44.2.0',node:'24.19.0',io:false},
    {role:'observer',electron:'44.2.0',node:'24.20.0',io:true},
    {role:'installer',electron:'44.2.0',node:'24.20.0',io:false},
  ]){
    const effects=[],spawns=[];
    const denyFS={...fs};
    for(const [key,value] of Object.entries(denyFS))if(typeof value==='function')denyFS[key]=(...args)=>{
      effects.push({name:key,path:String(args[0])});throw Error('MATRIX_FS_DENIED');
    };
    const module={exports:{}};
    const context={module,exports:module.exports,Buffer,Uint8Array,ArrayBuffer,TextDecoder,
      process:{platform:'win32',arch:'x64',versions:{electron:row.electron,node:row.node},env:{}},
      require:id=>{
        assert(id.startsWith('node:')||id==='url');
        if(id==='node:fs')return denyFS;
        if(id==='node:child_process')return {...require(id),spawn(...args){spawns.push(args);throw Error('MATRIX_SPAWN_DENIED');}};
        return require(id);
      }};
    new vm.Script(code).runInNewContext(context,{timeout:2000});
    assert.deepEqual(effects,[],`${row.role}: module evaluation is inert`);
    const sdk=module.exports.modules['owned-zip-worker-client.mjs'];
    // The scratch installer isolates the shared runtime gate. The staging
    // constructor intentionally reads context metadata before start(), whereas
    // its physical Main refusal remains covered by the preceding actual case.
    const owner=row.role==='observer'?sdk.createOwnedArchiveObserver(raw):sdk.createOwnedZipWorker(raw,archive);
    assert.deepEqual(effects,[],`${row.role}: constructor is inert`);
    await assert.rejects(row.role==='observer'?owner.observe():owner.start(),
      row.io?/OBSERVATION_FAILED/:/UNSUPPORTED_RUNTIME/);
    assert.deepEqual(spawns,[],`${row.role}: no actual spawn in any VM case`);
    if(row.io){
      assert.equal(effects.length,1,'supported observer reaches the required Python executable hash check first');
      assert.equal(effects[0].name,'lstatSync');
      assert(effects[0].path.replaceAll('\\','/').toLowerCase().endsWith('/python314/python.exe'));
    }else assert.deepEqual(effects,[],`${row.role}: unsupported runtime refused before filesystem access`);
  }
  // This matrix evaluates the actual compiled Main in VM process/FS facades.
  // It adds no physical acceptance beyond the separate Node/Python case above.
});

integration('actual compiler builds source-owned capsules entirely from captured bytes',async()=>{
  const {binding,capture,compiler}=await ready();
  const original=fs.readFileSync;
  fs.readFileSync=(file,...args)=>{
    if(typeof file==='string'&&file.replaceAll('\\','/').startsWith(sdk.replaceAll('\\','/')))assert.fail('SDK source reopened');
    return original(file,...args);
  };
  let result;
  try {result=await buildNativeSDKCapsule(capture,Buffer.from(JSON.stringify(binding)),compiler);}
  finally{fs.readFileSync=original;}
  assert(Object.isFrozen(result));assert.equal(result.nativeAdmission,false);
  assert.equal(sha(Buffer.from(result.artifact)),result.sha256);
  const rebuilt=await buildNativeSDKCapsule(capture,Buffer.from(JSON.stringify(binding)),compiler);
  assert.equal(rebuilt.artifact,result.artifact);
  const artifact=JSON.parse(result.artifact);
  assert.equal(artifact.schema,'native-sdk-capsule/1');assert.deepEqual(artifact.binding,binding);
  assert.equal(sha(Buffer.from(artifact.main.code,'base64')),artifact.main.sha256);
  const loaded=capsuleLoader.loadNativeSDKCapsule(Buffer.from(result.artifact),result.sha256,Buffer.from(JSON.stringify(binding)));
  const loadedJournal=loaded.modules['native-executor-journal.mjs'];
  const branded=loadedJournal.createNativeExecutorJournal();
  assert.throws(()=>loadedJournal.appendNativeExecutorTerminalAnchored(branded,{},Buffer.from('{'),Buffer.from('{')),/INVALID_BINDING/);
  assert.equal(loadedJournal.INVENTORY_LIMITS.records,1024);
  assert.equal(Object.keys(artifact.transformedJavaScriptSHA256).length,12);
  const seen=new Set([...result.mainInputs,...result.relayInputs]);
  for(const name of NATIVE_SDK_SOURCE_NAMES.filter(n=>!n.endsWith('.py')))assert([...seen].some(id=>id.endsWith('/'+name)),name);
  const effects=[],require=createRequire(import.meta.url),realFS={...fs};
  const denyFS={...fs};for(const [key,value] of Object.entries(denyFS))if(typeof value==='function')denyFS[key]=(...args)=>{
    effects.push({name:key,path:String(args[0])});throw Error('DATA_IO_DENIED');
  };
  const module={exports:{}};
  const context={module,exports:module.exports,Buffer,Uint8Array,ArrayBuffer,TextDecoder,
    process:{platform:process.platform,arch:process.arch,versions:process.versions,
      env:{NEXUS_WORKSPACE:'Z:/Hostile',NEXUS_CONTEXT_ROOT:'Z:/Hostile'}},
    require:id=>{assert(id.startsWith('node:')||id==='url');return id==='node:fs'?denyFS:id==='node:child_process'?{...require(id),spawn(){assert.fail('spawn');}}:require(id);}};
  new vm.Script(Buffer.from(artifact.main.code,'base64').toString('utf8')).runInNewContext(context,{timeout:2000});
  assert.deepEqual(effects,[]);
  const modules=module.exports.modules;assert(Object.isFrozen(modules));
  const ns=modules['native-executor-journal.mjs'];
  assert.equal(typeof Object.getOwnPropertyDescriptor(ns,'createNativeExecutorJournal').value,'function');
  const journal=ns.createNativeExecutorJournal();
  assert.throws(()=>ns.appendNativeExecutorTerminalAnchored({}, {},Buffer.from('{'),Buffer.from('{')),/INVALID_JOURNAL/);
  assert.throws(()=>ns.appendNativeExecutorTerminalAnchored(journal,{},Buffer.from('{'),Buffer.from('{')),/INVALID_BINDING/);
  assert.deepEqual(effects,[]);
  const status=journal.inventory();assert.equal(status.complete,false);
  assert(effects.length>0);assert(effects.every(e=>!e.path.startsWith('Z:')));
  // Actual DATA IO is still attempted and refused; only CODE lookup was removed.
  assert.equal(realFS.existsSync(path.join(binding.workspaceRoot,'local-state/vortex-agent-build/native-install-executor')),false);
});

integration('wrong source pins fail before any compiler callback',async()=>{
  const {binding,capture}=await ready();let calls=0;
  const wrong=structuredClone(binding);wrong.sourceSHA256['paths.cjs']='0'.repeat(64);
  await assert.rejects(buildNativeSDKCapsule(capture,Buffer.from(JSON.stringify(wrong)),()=>{calls++;}),/SOURCE_PIN/);
  await assert.rejects(buildNativeSDKCapsule({},Buffer.from(JSON.stringify(binding)),()=>{calls++;}),/CAPTURE/);
  assert.equal(calls,0);
});

integration('validly pinned but unsupported adapted source is refused before compiler execution',async t=>{
  const {binding,capture}=await ready(),root=fs.mkdtempSync(path.join(os.tmpdir(),'capsule-build-source-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const pins={...binding.sourceSHA256};
  for(const name of NATIVE_SDK_SOURCE_NAMES){let b=readCapturedNativeSDKSource(capture,name);
    if(name==='paths.cjs')b=Buffer.concat([b,Buffer.from('\n// unsupported upstream edit\n')]);
    fs.writeFileSync(path.join(root,name),b);pins[name]=sha(b);
  }
  const changed=captureNativeSDKSources(root,pins);let calls=0;
  const next={...binding,sourceSHA256:pins};
  await assert.rejects(buildNativeSDKCapsule(changed,Buffer.from(JSON.stringify(next)),()=>{calls++;}),/ADAPTER_SOURCE_PIN/);
  assert.equal(calls,0);
});

integration('actual capsule relay reaches READY and aborts without SDK files, START or a Python worker',async t=>{
  const {binding,capture,compiler}=await ready(),root=fs.mkdtempSync(path.join(os.tmpdir(),'capsule-relay-ready-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const bound={...binding,workspaceRoot:root.replaceAll('\\','/')};
  const result=await buildNativeSDKCapsule(capture,Buffer.from(JSON.stringify(bound)),compiler);
  const artifact=JSON.parse(result.artifact);
  assert.equal(sha(Buffer.from(result.relayEnvelope)),artifact.relay.envelopeSHA256);
  assert.equal(sha(Buffer.from(JSON.parse(result.relayEnvelope).code,'base64')),artifact.relay.codeSHA256);
  assert.equal(fs.existsSync(path.join(root,'tools')),false);
  const child=spawn(process.execPath,['-e',result.relayBootstrap],{cwd:root,
    env:{SystemRoot:process.env.SystemRoot},windowsHide:true,stdio:['pipe','pipe','pipe']});
  const ownBinding={operationId:'op_'+'1'.repeat(32),nativeJobId:'exec_'+'2'.repeat(32),
    requestSHA256:'3'.repeat(64),rendererGeneration:'renderer_'+'4'.repeat(32)};
  const observed=terminal.observeChildTerminal(child,ownBinding);
  const frames=[];let pending='',stderr='',readySeen=false;
  const done=new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>{child.kill();reject(Error('Own relay READY fixture timed out'));},10000);
    child.once('error',error=>{clearTimeout(timeout);reject(error);});
    child.stderr.on('data',b=>{stderr+=b;});
    child.stdout.on('data',b=>{
      pending+=b;let at;
      while((at=pending.indexOf('\n'))!==-1){
        let frame;try{frame=JSON.parse(pending.slice(0,at));}catch(error){reject(error);return;}
        pending=pending.slice(at+1);frames.push(frame);
        if(frame.schema==='owned-zip-relay-ready/1'){
          readySeen=true;
          child.stdin.write(JSON.stringify({schema:'owned-zip-relay-control/1',relayLifetime:frame.relayLifetime,
            binding:ownBinding,command:'abort'})+'\n');
        }else if(frame.schema==='owned-zip-relay-status/1'&&frame.phase==='released')child.stdin.end();
      }
    });
    child.once('close',(code,signal)=>{clearTimeout(timeout);resolve({code,signal});});
  });
  child.stdin.write(result.relayEnvelope+'\n');
  const closed=await done;
  assert.deepEqual(closed,{code:0,signal:null},stderr);assert.equal(stderr,'');assert(readySeen);
  const readyFrame=frames.find(v=>v.schema==='owned-zip-relay-ready/1');
  assert.equal(readyFrame.workspace,path.resolve(bound.workspaceRoot));assert.deepEqual(readyFrame.sourceSHA256,bound.sourceSHA256);
  const statuses=frames.filter(v=>v.schema==='owned-zip-relay-status/1');assert(statuses.length>0);
  assert(statuses.every(v=>v.sdk===null&&v.accepted===false));
  assert.equal(observed.read().childResourcesClosed,true,JSON.stringify(observed.read()));
  assert.equal(fs.existsSync(path.join(root,'local-state')),false);
});

integration('actual Python capsule reaches READY and closes runtime custody on pre-START abort',async t=>{
  const {capture}=await ready(),root=fs.mkdtempSync(path.join(os.tmpdir(),'capsule-python-ready-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const python='C:/Python314/python.exe';
  const expected={pythonExe:'434b361fe0c5960d404974feed493db47f2603a1ace2574312104fbed0182c6f',
    pythonCore:'854fe7549eb4b2ac478935a38ae2ca1b774c6fdc3d87f0263fbd697ff86d7149'};
  assert.equal(sha(fs.readFileSync(python)),expected.pythonExe);
  assert.equal(sha(fs.readFileSync('C:/Python314/python314.dll')),expected.pythonCore);
  const built=buildPythonSDKCapsule(capture,root.replaceAll('\\','/'));
  const child=spawn(python,['-I','-S','-B','-c',built.bootstrap],{cwd:root,
    env:{SystemRoot:process.env.SystemRoot},windowsHide:true,stdio:['pipe','pipe','pipe']});
  const ownBinding={operationId:'op_'+'5'.repeat(32),nativeJobId:'exec_'+'6'.repeat(32),
    requestSHA256:'7'.repeat(64),rendererGeneration:'renderer_'+'8'.repeat(32)};
  const observed=terminal.observeChildTerminal(child,ownBinding);
  const pipesClosed=Promise.all([child.stdin,child.stdout,child.stderr].map(stream=>
    new Promise(resolve=>stream.once('close',resolve))));
  let out='',err='',readyFrame;
  const done=new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>{child.kill();reject(Error('Own Python READY fixture timed out'));},10000);
    child.once('error',e=>{clearTimeout(timeout);reject(e);});
    child.stderr.on('data',b=>{err+=b;});
    child.stdout.on('data',b=>{
      out+=b;const at=out.indexOf('\n');if(at<0||readyFrame)return;
      try{readyFrame=JSON.parse(out.slice(0,at));}catch(e){reject(e);return;}
      child.stdin.write(JSON.stringify({schema:'owned-zip-worker-abort/1',workerLifetime:readyFrame.workerLifetime})+'\n');
    });
    child.once('close',(code,signal)=>{clearTimeout(timeout);resolve({code,signal});});
  });
  child.stdin.write(built.envelope+'\n');
  const closed=await done;assert.deepEqual(closed,{code:0,signal:null},err);
  let pipeTimer;
  try {await Promise.race([pipesClosed,new Promise((_,reject)=>{
    pipeTimer=setTimeout(()=>reject(Error('Python fixture pipes did not close: '+JSON.stringify(observed.read()))),1000);
  })]);}finally{clearTimeout(pipeTimer);}
  assert.equal(err,'');assert.equal(readyFrame.schema,'owned-zip-worker-ready/1');
  assert.deepEqual(readyFrame.sourceSHA256,built.executionSHA256);
  assert.deepEqual(readyFrame.runtimeSHA256,expected);
  assert.deepEqual(readyFrame.pythonVersion,[3,14,8]);
  assert.equal(observed.read().childResourcesClosed,true,JSON.stringify(observed.read()));
  assert.deepEqual(fs.readdirSync(root),[]);
});
