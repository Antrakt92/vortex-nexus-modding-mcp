import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {types} from 'node:util';
import {stripTypeScriptTypes} from 'node:module';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {applyExact} from './native-patch-test-fixture.mjs';

const HERE=path.dirname(fileURLToPath(import.meta.url)),packet=path.join(HERE,'native-patches/vortex-persistence-2.9.1');
const repo=process.env.VORTEX_EXTENSION_ADMISSION_REPO,sha=x=>createHash('sha256').update(x).digest('hex');
const stages=['native-executor-transport-shared-ipc','native-executor-transport-shared-preload','native-executor-transport-preload'];
const stage=name=>({m:JSON.parse(fs.readFileSync(path.join(packet,name+'.json'))),patch:fs.readFileSync(path.join(packet,name+'.patch'),'utf8')});
function composed(name){
  const {m,patch}=stage(name),graph=JSON.parse(fs.readFileSync(path.join(HERE,'native-source-series.json')));
  let text=execFileSync('git',['-C',repo,'show',graph.upstreamCommit+':'+m.upstreamPath],{maxBuffer:2e6}).toString('utf8');
  for(const row of graph.patches.filter(row=>row.path===m.upstreamPath)){
    if(sha(text)===m.inputSHA256)break;
    const folder=path.join(HERE,'native-patches',row.packet==='lifecycle'?'vortex-2.9.1':'vortex-persistence-2.9.1');
    text=applyExact(text,fs.readFileSync(path.join(folder,row.name+'.patch'),'utf8'),m.upstreamPath);
    assert.equal(sha(text),row.outputSHA256);
  }
  assert.equal(sha(text),m.inputSHA256);assert.equal(sha(patch),m.patchSHA256);
  text=applyExact(text,patch,m.upstreamPath);assert.equal(sha(text),m.outputSHA256);return text;
}
const integration=(name,fn)=>test(name,{skip:repo?false:'Set VORTEX_EXTENSION_ADMISSION_REPO',timeout:10000},fn);
const tick=()=>new Promise(resolve=>setImmediate(resolve));
export const transportChallenge=(overrides={})=>({schema:'native-executor-challenge/1',transportId:'transport_'+'1'.repeat(32),
  challengeId:'challenge_'+'2'.repeat(32),round:1,stage:'acquire',requestSHA256:'3'.repeat(64),requestBytesSHA256:'4'.repeat(64),
  archiveBytesSHA256:'5'.repeat(64),operationId:'op_'+'6'.repeat(32),nativeJobId:'exec_'+'7'.repeat(32),gameId:'cyberpunk2077',
  modId:'Own',profileId:'fixture',managerScope:'manager-fixture-1',rendererGeneration:'renderer_'+'8'.repeat(32),...overrides});
export const transportResponse=(c=transportChallenge(),overrides={})=>({schema:'native-executor-response/1',transportId:c.transportId,
  challengeId:c.challengeId,round:c.round,stage:c.stage,requestSHA256:c.requestSHA256,requestBytesSHA256:c.requestBytesSHA256,
  archiveBytesSHA256:c.archiveBytesSHA256,state:c.stage==='acquire'?'acquired':c.stage==='hold'?'held':'checked',
  observation:c.stage==='hold'?null:{schema:'native-renderer-executor-admission/1',gameId:c.gameId,modId:c.modId,profileId:c.profileId,
    managerScopeId:c.managerScope,rendererGeneration:c.rendererGeneration,effectsAllowed:false,installationPermit:false},errorCode:null,...overrides});

/** Real patched preload persist object and listener; Electron transport is a facade. */
export function createPreloadTransportFixture(options={}){
  const text=stripTypeScriptTypes(composed('native-executor-transport-preload'),{mode:'transform'});
  const start=text.indexOf('let nativeExecutorReceiverBound'),end=text.indexOf('try {\n    expose(',start);
  const p=text.indexOf('persist: {'),q=text.indexOf('extensions: {',p);
  assert(start>=0&&end>start&&p>=0&&q>p);
  let listener;const sent=[],invoked=[],registered=[],removed=[];
  const persist=vm.runInNewContext(text.slice(start,end)+'\n({'+text.slice(p,q)+'}).persist;',{
    nativeExecutorPreloadTypes:types,betterIpcRenderer:{
      invoke:(...args)=>{invoked.push(args);return options.invoke?.(...args)??Promise.resolve({fixture:true});},
      on:(channel,callback)=>{registered.push(channel);listener=callback;options.on?.(channel,callback);},
      off:(channel,callback)=>{removed.push(channel);if(listener===callback)listener=undefined;},
      send:(channel,response)=>{sent.push({channel,response});options.send?.(channel,response);},
    },
  });
  return{persist,sent,invoked,registered,removed,deliver:value=>listener?.(undefined,value)};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
test('transport preload/types artifacts pin their exact predecessor and companions without installation authority',()=>{
  for(let i=0;i<stages.length;i++){
    const {m,patch}=stage(stages[i]);assert.equal(sha(patch),m.patchSHA256);
    const parent=stage(m.prerequisitePatch.slice(0,-6)).m;assert.equal(m.inputSHA256,parent.outputSHA256);
    for(const key of ['installed','effectsAllowed','installationPermit','nativeAdmission','nativeAcceptanceVerified'])assert.equal(m[key],false);
    if(i){const previous=stage(stages[i-1]).m;assert.equal(m.requiredCompanionPatchSHA256,previous.patchSHA256);assert.equal(m.requiredCompanionOutputSHA256,previous.outputSHA256);}
  }
});
integration('fixed invoke forwards only its two byte arguments to the reviewed channel',async()=>{
  const f=createPreloadTransportFixture(),a=new Uint8Array([1]),b=new Uint8Array([2]);
  await f.persist.prepareNativeExecutor(a,b,'ignored');assert.equal(f.invoked.length,1);
  assert.deepEqual(f.invoked[0],['persist:native-executor-prepare',a,b]);
});
integration('one receiver forwards a detached frozen challenge and a closed response on its fixed channel',async()=>{
  const f=createPreloadTransportFixture();let observed;f.persist.onExecutorChallenge(async c=>{observed=c;return transportResponse(c);});
  const c=transportChallenge();f.deliver(c);c.modId='changed';await tick();
  assert(Object.isFrozen(observed));assert.equal(observed.modId,'Own');assert.deepEqual(f.registered,['persist:native-executor-challenge']);
  assert.equal(f.sent.length,1);assert.equal(f.sent[0].channel,'persist:native-executor-response');
  assert.equal(f.sent[0].response.state,'acquired');assert.equal(f.sent[0].response.observation.modId,'Own');
  assert.equal(Object.keys(f.sent[0].response).length,11);
});
integration('wrong response correlation, projection, fields and state become a fixed failed reply',async()=>{
  for(const change of [r=>r.challengeId='challenge_'+'f'.repeat(32),r=>r.observation.profileId='wrong',r=>r.observation.effectsAllowed=true,
    r=>r.extra='private',r=>r.state='checked']){
    const f=createPreloadTransportFixture();f.persist.onExecutorChallenge(async c=>{const r=transportResponse(c);change(r);return r;});f.deliver(transportChallenge());await tick();
    assert.equal(f.sent.length,1);assert.equal(f.sent[0].response.state,'failed');assert.equal(f.sent[0].response.observation,null);
    assert.equal(f.sent[0].response.errorCode,'NATIVE_EXECUTOR_RENDERER_FAILED');
  }
});
integration('malformed and proxy challenges cannot execute getters or invoke the source receiver',async()=>{
  const f=createPreloadTransportFixture();let calls=0,getters=0;f.persist.onExecutorChallenge(async c=>{calls++;return transportResponse(c);});
  const accessor=transportChallenge();Object.defineProperty(accessor,'gameId',{get(){getters++;throw Error('own getter');}});
  for(const c of [accessor,new Proxy(transportChallenge(),{ownKeys(){getters++;throw Error('own proxy');}}),transportChallenge({round:4,stage:'acquire'}),{...transportChallenge(),extra:true}])f.deliver(c);
  await tick();assert.equal(calls,0);assert.equal(getters,0);assert.equal(f.sent.length,0);
  f.deliver(transportChallenge());await tick();assert.equal(calls,1);assert.equal(f.sent[0].response.state,'acquired');
});
integration('reply field accessors are not executed and cannot leak into IPC serialization',async()=>{
  const f=createPreloadTransportFixture();let getters=0;f.persist.onExecutorChallenge(async c=>{
    const r=transportResponse(c);Object.defineProperty(r,'state',{get(){getters++;throw Error('secret value');}});return r;
  });f.deliver(transportChallenge());await tick();assert.equal(getters,0);assert.equal(f.sent[0].response.state,'failed');
});
integration('source throw and rejected promise return a bounded failure without serializing primary values',async()=>{
  for(const handler of [()=>{throw null;},()=>{throw undefined;},async()=>{throw Error('private fixture secret');}]){
    const f=createPreloadTransportFixture();f.persist.onExecutorChallenge(handler);f.deliver(transportChallenge());await tick();
    assert.equal(f.sent.length,1);assert.equal(f.sent[0].response.state,'failed');assert(!JSON.stringify(f.sent).includes('private fixture secret'));
  }
});
integration('unexpected thenable or proxy flight is refused without invoking its then getter',async()=>{
  for(const proxy of [false,true]){
    const f=createPreloadTransportFixture();let getters=0;const value={get then(){getters++;throw Error('own then getter');}};
    f.persist.onExecutorChallenge(()=>proxy?new Proxy(Promise.resolve(),{get(){getters++;throw Error('own promise proxy');}}):value);
    f.deliver(transportChallenge());await tick();assert.equal(getters,0);assert.equal(f.sent[0].response.state,'failed');
  }
});
integration('hold replies have no observation and disposal cannot rearm a second receiver',async()=>{
  const f=createPreloadTransportFixture(),off=f.persist.onExecutorChallenge(async c=>transportResponse(c));
  f.deliver(transportChallenge({stage:'hold',round:4}));await tick();assert.equal(f.sent[0].response.state,'held');assert.equal(f.sent[0].response.observation,null);
  assert.throws(()=>f.persist.onExecutorChallenge(async c=>transportResponse(c)));off();
  assert.throws(()=>f.persist.onExecutorChallenge(async c=>transportResponse(c)));assert.deepEqual(f.removed,['persist:native-executor-challenge']);
});
integration('partial listener registration failure cannot be replaced by another source callback',()=>{
  const f=createPreloadTransportFixture({on:()=>{throw Error('own registration failure');}});
  assert.throws(()=>f.persist.onExecutorChallenge(async c=>transportResponse(c)));assert.throws(()=>f.persist.onExecutorChallenge(async c=>transportResponse(c)));
  assert.equal(f.registered.length,1);
});
}
