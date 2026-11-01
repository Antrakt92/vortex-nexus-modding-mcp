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
