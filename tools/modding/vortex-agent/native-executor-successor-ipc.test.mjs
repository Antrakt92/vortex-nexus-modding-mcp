import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {EventEmitter} from 'node:events';
import {types} from 'node:util';
import {repo,execute,stage,sha,tick} from './native-query-source-admission.test.mjs';
import {transportBinding} from './native-executor-transport-ipc.test.mjs';
import {completionSource,executionResponse} from './native-executor-completion-preload.test.mjs';
const integration=(name,fn)=>test(name,{skip:repo?false:'Set VORTEX_EXTENSION_ADMISSION_REPO',timeout:10000},fn);
const channel='persist:native-executor-successor';
const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function boundFixture(options={}){
 return successorIPCFixture({...options,binding:{...transportBinding(),requestBytesSHA256:digest(Uint8Array.of(1)),archiveBytesSHA256:digest(Uint8Array.of(2))}});
}
/** Actual complete persistenceIPC source; Electron/Main work are explicit facades. */
export function successorIPCFixture(options={}){
 const handlers=new Map(),listeners=new Map(),timers=new Map(),calls=[],messages=[],binding=options.binding??transportBinding(),mainOwner=options.readyOwner??Object.freeze({}),ticket=Object.freeze({});let nonce=0,timerId=0;
 const owner=new EventEmitter();Object.assign(owner,{id:91,mainFrame:{processId:17,routingId:22},rendererPID:8123,dead:false,isDestroyed(){return this.dead;},getOSProcessId(){return this.rendererPID;}});
 const event={sender:owner,senderFrame:owner.mainFrame},persistor=options.persistor??{async flushPersistenceAcknowledged(){}},state={now:0,current:persistor,held:false,released:false};
 const observed={schema:'native-tracked-mod-registration-observed/2',operationId:binding.operationId,nativeJobId:binding.nativeJobId,requestSHA256:binding.requestSHA256,recordSHA256:'a'.repeat(64),recordJSON:'{}',fullRecordSHA256:'b'.repeat(64),commitObserved:true,readbackVerified:true,trackedAssociationVerified:true,trackedInstallComplete:false,effectsAllowed:false,installationPermit:false,powerLossPersistenceVerified:false};
 const release={schema:'native-registration-release-observed/1',operationId:binding.operationId,nativeJobId:binding.nativeJobId,requestSHA256:binding.requestSHA256,recordSHA256:observed.recordSHA256,fullRecordSHA256:observed.fullRecordSHA256,released:true,consumedIDsRetained:true,durableConsumedIDsVerified:false,effectsAllowed:false,installationPermit:false,trackedInstallComplete:false};
 const main={preflightNativeExecutorTransport(){return ticket;},getNativeExecutorTransportBinding(){return binding;},checkNativeExecutorTransport(t){assert.equal(t,ticket);if(state.held&&!state.released)throw Error('MAIN_HELD');options.check?.(f);},holdNativeExecutorTransport(){state.held=true;calls.push('hold-main');options.hold?.(f);},async reserveNativeExecutorTransport(){calls.push('reserve');},async prepareNativeExecutorTransportPending(){calls.push('pending');return{schema:'native-executor-pending-preparation/1',operationId:binding.operationId,nativeJobId:binding.nativeJobId,requestSHA256:binding.requestSHA256,rootId:'1:2',inventorySHA256:'7'.repeat(64),effectsAllowed:false,installationPermit:false,nativeAdmission:false,powerLossPersistenceVerified:false};},
  async copyNativeExecutorTransport(t){assert.equal(t,ticket);calls.push('copy');await options.copy?.(f);return{};},
  async registerNativeExecutorTransportCopied(t){assert.equal(t,ticket);calls.push('register');await options.register?.(f);return options.observed?.(observed)??observed;},
  async closeNativeExecutorTransportWorker(t,bytes){assert.equal(t,ticket);calls.push('close');const adoption=JSON.parse(Buffer.from(bytes).toString());assert.equal(adoption.schema,'native-executor-renderer-adoption/1');assert.equal(adoption.fullRecordSHA256,observed.fullRecordSHA256);await options.close?.(f);return{};},
  async sealNativeExecutorTransportTerminal(t,bytes){assert.equal(t,ticket);calls.push('seal');assert.equal(JSON.parse(Buffer.from(bytes).toString()).fullRecordSHA256,observed.fullRecordSHA256);await options.seal?.(f);return{};},
  releaseNativeExecutorTransport(t){assert.equal(t,ticket);calls.push('release');const value=options.release?.(f);state.released=true;return value??release;},
  getNativeExecutorTransportMainRelease(t){assert.equal(t,ticket);return options.getRelease?options.getRelease(f):state.released?release:null;},
 };
 const context={nativeSuccessorHash:crypto.createHash,nativeTransportTypes:types,nativeTransportRandom(n){assert.equal(n,16);const bytes=Buffer.alloc(16);bytes.writeUInt32BE(++nonce,12);return bytes;},performance:{now:()=>state.now},process:{pid:4321},
  betterIpcMain:{handle:(n,fn)=>handlers.set(n,fn),on(){},send(target,channel,value){assert.equal(target,owner);messages.push({channel,value});if(channel==='persist:native-executor-challenge'){if(options.onPrepareChallenge)options.onPrepareChallenge(value,f);else if(value.stage!=='hold')queueMicrotask(()=>f.respondPrepare(value));return;}
   assert.equal(channel,'persist:native-executor-execution-challenge');calls.push('challenge'+value.sequence);options.onChallenge?.(value,f);if(options.auto!==false&&value.sequence!==8)queueMicrotask(()=>f.respond(value));}},
  ipcMain:{on(n,fn){if(n.startsWith('persist:native-executor-'))assert(!listeners.has(n));listeners.set(n,fn);}},log(){},registerAllPersistedHives:async()=>({}),getMainPersistor(){return state.current;},waitForNativeMainPersistenceReady:()=>Promise.resolve(mainOwner),checkNativeMainPersistenceReady(o){assert.equal(o,mainOwner);},
  setTimeout(fn,ms){const id=++timerId;timers.set(id,{fn,ms});return id;},clearTimeout:id=>timers.delete(id),...main,...options.context};
 const api=execute(completionSource('native-executor-successor-ipc'),'({setupPersistenceIPC,bindPersistenceAcknowledgementSender,checkNativeExecutorFrame,holdNativeExecutorFrame,reserveNativeExecutorFrame})',context);
 const f={api,handlers,listeners,timers,calls,messages,binding,event,owner,persistor,state,observed,release,
  prepare:(request=new Uint8Array([1]),archive=new Uint8Array([2]))=>handlers.get('persist:native-executor-prepare')(event,request,archive),
  execute:(id,e=event,...extra)=>handlers.get('persist:native-executor-execute')(e,id,...extra),
  respondPrepare:c=>listeners.get('persist:native-executor-response')(event,{schema:'native-executor-response/1',transportId:c.transportId,challengeId:c.challengeId,round:c.round,stage:c.stage,requestSHA256:c.requestSHA256,requestBytesSHA256:c.requestBytesSHA256,archiveBytesSHA256:c.archiveBytesSHA256,state:c.round===1?'acquired':'checked',observation:{schema:'native-renderer-executor-admission/1',gameId:binding.gameId,modId:binding.modId,profileId:binding.profileId,managerScopeId:binding.managerScope,rendererGeneration:binding.rendererGeneration,effectsAllowed:false,installationPermit:false},errorCode:null}),
  respond(c,extra={},e=event){listeners.get('persist:native-executor-execution-response')(e,executionResponse(c,extra));},
  invalidate(c,e=event,extra={}){listeners.get('persist:native-executor-execution-invalidated')(e,{schema:'native-executor-execution-invalidated/1',transportId:c.transportId,executionId:c.executionId,operationId:c.operationId,nativeJobId:c.nativeJobId,requestSHA256:c.requestSHA256,requestBytesSHA256:c.requestBytesSHA256,archiveBytesSHA256:c.archiveBytesSHA256,reasonCode:'NATIVE_EXECUTOR_RENDERER_FAILED',...extra});},
  executionChallenges:()=>messages.filter(x=>x.channel==='persist:native-executor-execution-challenge').map(x=>x.value),
  timeout(){state.now=120001;for(const {fn}of [...timers.values()])fn();},
 };
 api.setupPersistenceIPC(persistor);api.bindPersistenceAcknowledgementSender(owner);return f;
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 test('successor IPC pins completion parent and actual Main/shared companion outputs',()=>{
 const {m,patch}=stage('native-executor-successor-ipc'),parent=stage('native-executor-completion-ipc').m;
 assert.equal(sha(patch),m.patchSHA256);assert.equal(m.inputSHA256,parent.outputSHA256);assert.equal(m.prerequisitePatchSHA256,parent.patchSHA256);
 for(const c of m.additionalCompanions){const actual=stage(c.name).m;assert.equal(c.patchSHA256,actual.patchSHA256);assert.equal(c.outputSHA256,actual.outputSHA256);}
 assert.equal(m.installed,false);assert.equal(m.nativeAdmission,false);assert(!patch.includes('betterIpcMain.callback('));
 });
integration('actual IPC successor returns exact historical ACK and admits another preparation without reusing old IDs',async()=>{
  let retired=0;
  const f=boundFixture({context:{prepareNativeExecutorSuccessor:()=>()=>{retired++;}}});
  const prepared=await f.prepare(),result=await f.execute(prepared.transportId);
  const handoff=(event=f.event)=>f.handlers.get(channel)(event,prepared.transportId,result.executionId);
  const ack=handoff();assert.equal(ack.ready,true);assert.equal(Object.keys(ack).length,10);assert(Object.isFrozen(ack));assert.equal(retired,1);
  assert.equal(handoff(),ack);assert.equal(retired,1);
  const second=await f.prepare(Uint8Array.of(3),Uint8Array.of(4));assert.notEqual(second.transportId,prepared.transportId);
  assert.equal(handoff(),ack);assert.equal(retired,1);
  const next=await f.execute(second.transportId);assert.notEqual(next.executionId,result.executionId);
  assert.throws(()=>handoff({sender:f.owner,senderFrame:{...f.owner.mainFrame}}));
  assert.equal(retired,1);assert.equal(f.state.held,false);
});
for(const stale of ['execute','prepare'])integration('delayed retired '+stale+' cannot hold a newer running execution',async()=>{
  let block=false,enter,finish;
  const entered=new Promise(resolve=>{enter=resolve;}),gate=new Promise(resolve=>{finish=resolve;});
  const f=boundFixture({context:{prepareNativeExecutorSuccessor:()=>()=>{}},copy:()=>{if(block){enter();return gate;}}});
  const first=await f.prepare(),old=await f.execute(first.transportId);
  f.handlers.get(channel)(f.event,first.transportId,old.executionId);
  const second=await f.prepare(Uint8Array.of(3),Uint8Array.of(4));block=true;
  const pending=f.execute(second.transportId);void pending.catch(()=>{});await entered;
  try{
    await assert.rejects(stale==='execute'?f.execute(first.transportId):f.prepare());
    assert.equal(f.state.held,false);
  }finally{finish();}
  assert.equal((await pending).rendererReleased,true);
});
integration('actual IPC refuses unfinished and foreign-frame successor without calling Main finalizer',async()=>{
  let retired=0;
  const f=successorIPCFixture({context:{prepareNativeExecutorSuccessor:()=>()=>{retired++;}}});
  const p=await f.prepare();
  assert.throws(()=>f.handlers.get(channel)(f.event,p.transportId,'execution_'+'a'.repeat(32)));
  assert.equal(retired,0);assert.equal(f.state.held,false);
  const result=await f.execute(p.transportId);
  assert.throws(()=>f.handlers.get(channel)({sender:{...f.owner},senderFrame:f.owner.mainFrame},p.transportId,result.executionId));
  assert.equal(retired,0);assert.equal(f.state.held,false);
  assert.equal(f.handlers.get(channel)(f.event,p.transportId,result.executionId).ready,true);
  assert.equal(retired,1);
});
integration('initial genuine event getter reentry holds before Main retirement',async()=>{
 let retired=0,nestedHeld=false,armed=true;
 const f=boundFixture({context:{prepareNativeExecutorSuccessor:()=>()=>{retired++;}}});
 const p=await f.prepare(),r=await f.execute(p.transportId);
 const handoff=()=>f.handlers.get(channel)(f.event,p.transportId,r.executionId);
 Object.defineProperty(f.event,'sender',{get(){if(armed){armed=false;assert.throws(handoff);nestedHeld=true;}return f.owner;}});
 assert.throws(handoff);assert.equal(nestedHeld,true);assert.equal(retired,0);assert.throws(handoff);
});
integration('foreign initial getter reentry is inert and genuine completion can still hand off',async()=>{
 let retired=0,armed=true,nestedHeld=false;
 const f=boundFixture({context:{prepareNativeExecutorSuccessor:()=>()=>{retired++;}}});
 const p=await f.prepare(),r=await f.execute(p.transportId),foreign={senderFrame:f.owner.mainFrame};
 const bad=()=>f.handlers.get(channel)(foreign,p.transportId,r.executionId);
 Object.defineProperty(foreign,'sender',{get(){if(armed){armed=false;assert.throws(bad);nestedHeld=true;}return {id:f.owner.id};}});
 assert.throws(bad);assert.equal(nestedHeld,true);assert.equal(retired,0);assert.equal(f.state.held,false);
 assert.equal(f.handlers.get(channel)(f.event,p.transportId,r.executionId).ready,true);assert.equal(retired,1);
});

integration('retired historical handoff during a later handoff callback cannot hold the current operation',async()=>{
 let f,old,retired=0,preparations=0;
 f=boundFixture({context:{prepareNativeExecutorSuccessor:()=>{
   if(++preparations===2){const ack=f.handlers.get(channel)(f.event,old.transportId,old.executionId);assert.equal(ack.ready,true);}
   return()=>{retired++;};
 }}});
 const first=await f.prepare();old=await f.execute(first.transportId);
 f.handlers.get(channel)(f.event,old.transportId,old.executionId);assert.equal(retired,1);
 const second=await f.prepare(Uint8Array.of(3),Uint8Array.of(4)),result=await f.execute(second.transportId);
 const ack=f.handlers.get(channel)(f.event,result.transportId,result.executionId);
 assert.equal(ack.ready,true);assert.equal(retired,2);
 assert.equal(f.handlers.get(channel)(f.event,old.transportId,old.executionId).transportId,old.transportId);
});

test('completed history reaches its real 4096-entry bound without eviction or partial retirement',
 {skip:repo?false:'Set VORTEX_EXTENSION_ADMISSION_REPO',timeout:60000},async()=>{
 let retired=0,first;
 const f=successorIPCFixture({context:{prepareNativeExecutorSuccessor:()=>()=>{retired++;}}}),ids=new Set();
 for(let index=0;index<4096;index++){
   const prepared=await f.prepare(Uint8Array.of(3),Uint8Array.of(4)),result=await f.execute(prepared.transportId);
   assert(!ids.has(prepared.transportId));ids.add(prepared.transportId);
   const ack=f.handlers.get(channel)(f.event,prepared.transportId,result.executionId);
   first??=ack;assert.equal(retired,index+1);
 }
 const prepared=await f.prepare(Uint8Array.of(3),Uint8Array.of(4)),result=await f.execute(prepared.transportId);
 assert(!ids.has(prepared.transportId));assert.equal(result.rendererReleased,true);
 assert.throws(()=>f.handlers.get(channel)(f.event,prepared.transportId,result.executionId));
 assert.equal(retired,4096);
 assert.equal(f.handlers.get(channel)(f.event,first.transportId,first.executionId),first);
 assert.equal(retired,4096);
});

}
