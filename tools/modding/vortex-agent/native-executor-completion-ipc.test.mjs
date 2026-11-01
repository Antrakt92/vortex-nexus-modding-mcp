import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {EventEmitter} from 'node:events';
import {types} from 'node:util';
import {repo,execute,stage,sha,deferred,tick} from './native-query-source-admission.test.mjs';
import {transportBinding} from './native-executor-transport-ipc.test.mjs';
import {completionSource,executionResponse} from './native-executor-completion-preload.test.mjs';
const integration=(name,fn)=>test(name,{skip:repo?false:'Set VORTEX_EXTENSION_ADMISSION_REPO',timeout:10000},fn);
/** Actual complete persistenceIPC source; Electron/Main work are explicit facades. */
export function completionIPCFixture(options={}){
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
 const context={nativeTransportTypes:types,nativeTransportRandom(n){assert.equal(n,16);return Buffer.alloc(16,++nonce);},performance:{now:()=>state.now},process:{pid:4321},
  betterIpcMain:{handle:(n,fn)=>handlers.set(n,fn),on(){},send(target,channel,value){assert.equal(target,owner);messages.push({channel,value});if(channel==='persist:native-executor-challenge'){if(options.onPrepareChallenge)options.onPrepareChallenge(value,f);else if(value.stage!=='hold')queueMicrotask(()=>f.respondPrepare(value));return;}
   assert.equal(channel,'persist:native-executor-execution-challenge');calls.push('challenge'+value.sequence);options.onChallenge?.(value,f);if(options.auto!==false&&value.sequence!==8)queueMicrotask(()=>f.respond(value));}},
  ipcMain:{on(n,fn){if(n.startsWith('persist:native-executor-'))assert(!listeners.has(n));listeners.set(n,fn);}},log(){},registerAllPersistedHives:async()=>({}),getMainPersistor(){return state.current;},waitForNativeMainPersistenceReady:()=>Promise.resolve(mainOwner),checkNativeMainPersistenceReady(o){assert.equal(o,mainOwner);},
  setTimeout(fn,ms){const id=++timerId;timers.set(id,{fn,ms});return id;},clearTimeout:id=>timers.delete(id),...main,...options.context};
 const api=execute(completionSource('native-executor-completion-ipc'),'({setupPersistenceIPC,bindPersistenceAcknowledgementSender,checkNativeExecutorFrame,holdNativeExecutorFrame,reserveNativeExecutorFrame})',context);
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
 test('completion IPC packet pins exact preparation parent and complete Main/shared companions',()=>{
  const {m,patch}=stage('native-executor-completion-ipc'),p=stage('native-executor-transport-ipc').m,main=stage('native-main-executor-completion').m,shared=stage('native-executor-completion-shared-ipc').m;
  assert.equal(m.inputSHA256,p.outputSHA256);assert.equal(m.prerequisitePatchSHA256,p.patchSHA256);assert.equal(sha(patch),m.patchSHA256);
  assert.equal(m.requiredCompanionPatch,'native-main-executor-completion.patch');assert.equal(m.requiredCompanionPatchSHA256,main.patchSHA256);assert.equal(m.requiredCompanionOutputSHA256,main.outputSHA256);
  assert.deepEqual(m.additionalCompanions,[{packet:'persistence',name:'native-executor-completion-shared-ipc',patchSHA256:shared.patchSHA256,outputSHA256:shared.outputSHA256}]);
  assert(!patch.includes('betterIpcMain.callback('));assert.equal(m.installed,false);
 });
 integration('prepare is inert; actual execution follows every fixed stage and returns exact immutable result',async()=>{
  const f=completionIPCFixture(),p=await f.prepare();assert(!f.calls.includes('copy'));f.calls.length=0;
  const r=await f.execute(p.transportId);assert.deepEqual(f.calls,['challenge1','copy','challenge2','register','challenge3','challenge4','close','challenge5','seal','challenge6','release','challenge7']);
  assert.equal(Object.keys(r).length,17);assert.equal(r.mainReleased,true);assert.equal(r.rendererReleased,true);assert.equal(r.trackedInstallComplete,false);assert(Object.isFrozen(r));assert.equal(f.timers.size,0);
  const adopt=f.executionChallenges()[2],finalize=f.executionChallenges()[6];assert.equal(adopt.payloadJSON,JSON.stringify(f.observed));assert.equal(finalize.payloadJSON,JSON.stringify(f.release));
  f.owner.emit('destroyed');f.invalidate(finalize);assert.equal(r.rendererReleased,true);assert.equal(f.calls.filter(x=>x==='hold-main').length,0);await assert.rejects(f.execute(p.transportId));
 });
 integration('unprepared, wrong ID/extra arguments and foreign frame cannot execute or consume another owner',async()=>{
  const empty=completionIPCFixture();await assert.rejects(empty.execute('transport_'+'1'.repeat(32)));assert(!empty.calls.includes('copy'));
  for(const mode of ['foreign','sibling','missing']){const f=completionIPCFixture(),p=await f.prepare(),e=mode==='foreign'?{sender:{...f.owner},senderFrame:f.owner.mainFrame}:mode==='sibling'?{sender:f.owner,senderFrame:{...f.owner.mainFrame}}:{};await assert.rejects(f.execute(p.transportId,e));assert.equal(f.state.held,false);await f.execute(p.transportId);}
  for(const args of [['transport_'+'f'.repeat(32)],['extra',true]]){const f=completionIPCFixture(),p=await f.prepare();await assert.rejects(f.execute(args[0],f.event,...args.slice(1)));assert(!f.calls.includes('copy'));assert(f.state.held);}
 });
 integration('foreign duplicates and responses/invalidation cannot poison genuine active execution',async()=>{
  const f=completionIPCFixture({auto:false}),p=await f.prepare(),w=f.execute(p.transportId);await tick();const c=f.executionChallenges()[0],e={sender:f.owner,senderFrame:{...f.owner.mainFrame}};
  await assert.rejects(f.execute(p.transportId,e));f.respond(c,{},e);f.invalidate(c,e);assert.equal(f.state.held,false);assert(!f.calls.includes('copy'));
  for(let i=0;i<7;i++){f.respond(f.executionChallenges()[i]);await tick();}await w;
 });
 integration('genuine duplicate and nonce replay hold with no second COPY or owner refund',async()=>{
  for(const mode of ['duplicate','replay']){const gate=deferred(),f=completionIPCFixture({auto:false,copy:()=>gate.promise}),p=await f.prepare(),w=f.execute(p.transportId);void w.catch(()=>{});await tick();const c=f.executionChallenges()[0];if(mode==='duplicate')await assert.rejects(f.execute(p.transportId,{sender:f.owner,senderFrame:f.owner.mainFrame}));else{f.respond(c);await tick();f.respond(c);}await assert.rejects(w);gate.resolve();await tick();assert(f.state.held);assert.equal(f.calls.filter(x=>x==='copy').length,mode==='duplicate'?0:1);assert.equal(f.executionChallenges().filter(x=>x.sequence===8).length,1);}
 });
 integration('profile invalidation during COPY/SQL/close/seal wakes observer and observes late rejection without progression',async()=>{
  for(const stage of ['copy','register','close','seal']){const gate=deferred(),f=completionIPCFixture({[stage]:()=>gate.promise}),p=await f.prepare(),w=f.execute(p.transportId);void w.catch(()=>{});await tick();assert(f.calls.includes(stage));f.invalidate(f.executionChallenges()[0]);await assert.rejects(w);gate.reject(Error('late secret'));await tick();assert(f.state.held);assert(!f.calls.includes('release'));assert.equal(f.calls.filter(x=>x===stage).length,1);}
 });
 integration('first native failure including null/undefined is preserved without replay or release',async()=>{
  for(const primary of [null,undefined,Error('own primary')]){const f=completionIPCFixture({copy(){throw primary;}}),p=await f.prepare();await f.execute(p.transportId).then(()=>assert.fail('unexpected success'),error=>assert.equal(error,primary));assert(f.state.held);assert(!f.calls.includes('register'));await assert.rejects(f.execute(p.transportId));}
 });
 integration('observer deadline and delayed timer reply both hold without cancelling real COPY',async()=>{
  const gate=deferred(),f=completionIPCFixture({copy:()=>gate.promise}),p=await f.prepare(),w=f.execute(p.transportId);void w.catch(()=>{});await tick();f.timeout();await assert.rejects(w);gate.resolve();await tick();assert(!f.calls.includes('register'));assert(f.state.held);
  const g=completionIPCFixture({auto:false}),q=await g.prepare(),v=g.execute(q.transportId);void v.catch(()=>{});await tick();g.state.now=120000;g.respond(g.executionChallenges()[0]);await assert.rejects(v);assert(!g.calls.includes('copy'));
 });
 integration('navigation/crash and selected backend replacement hold active execution',async()=>{
  for(const mode of ['nav','crash','backend']){const f=completionIPCFixture({auto:false}),p=await f.prepare(),w=f.execute(p.transportId);void w.catch(()=>{});await tick();if(mode==='nav')f.owner.emit('did-start-navigation',{isMainFrame:true});if(mode==='crash')f.owner.emit('render-process-gone');if(mode==='backend')f.api.setupPersistenceIPC({});await assert.rejects(w);assert(f.state.held);assert(!f.calls.includes('copy'));}
 });
 integration('wrong current response fields/observations refuse before the next effect without getters',async()=>{
  for(const mutate of [r=>r.sequence=7,r=>r.observation.profileId='wrong',r=>r.state='failed',r=>Object.defineProperty(r,'observation',{get(){throw Error('must not invoke');}})]){const f=completionIPCFixture({auto:false}),p=await f.prepare(),w=f.execute(p.transportId);void w.catch(()=>{});await tick();const c=f.executionChallenges()[0],r=executionResponse(c);mutate(r);f.listeners.get('persist:native-executor-execution-response')(f.event,r);await assert.rejects(w);assert(!f.calls.includes('copy'));}
 });
 integration('adoption or repeated check hash drift cannot close worker or seal terminal',async()=>{
  for(const seq of [3,4,5,6]){const f=completionIPCFixture({onChallenge(c,f){if(c.sequence===seq)queueMicrotask(()=>f.respond(c,{observation:{...executionResponse(c).observation,fullRecordSHA256:'f'.repeat(64)}}));},auto:false}),p=await f.prepare(),w=f.execute(p.transportId);void w.catch(()=>{});for(let i=0;i<seq-1;i++){await tick();f.respond(f.executionChallenges()[i]);}await assert.rejects(w);assert(!f.calls.includes('release'));if(seq<=4)assert(!f.calls.includes('close'));}
 });
 integration('renderer failure after known Main release remains Main-released and cannot fabricate re-lock',async()=>{
  const f=completionIPCFixture({onChallenge(c,f){if(c.sequence===7)queueMicrotask(()=>f.respond(c,{state:'failed',observation:null,errorCode:'NATIVE_EXECUTOR_RENDERER_FAILED'}));}}),p=await f.prepare();await assert.rejects(f.execute(p.transportId));assert.equal(f.state.released,true);assert.equal(f.calls.filter(x=>x==='release').length,1);assert.equal(f.calls.filter(x=>x==='hold-main').length,0);await assert.rejects(f.execute(p.transportId));
 });
 integration('actual historical release ACK survives thrown/invalidated release without finalizing and getter failure preserves primary',async()=>{
  for(const getterThrows of [false,true]){const primary=Error('unknown after release'),f=completionIPCFixture({release(f){f.state.released=true;throw primary;},getRelease(f){if(getterThrows)throw Error('diagnostic only');return f.state.released?f.release:null;}}),p=await f.prepare();
   await f.execute(p.transportId).then(()=>assert.fail('unexpected success'),error=>assert.equal(error,primary));
   assert.equal(f.state.released,true);assert.equal(f.executionChallenges().some(c=>c.sequence===7),false);assert.equal(f.calls.filter(c=>c==='release').length,1);assert.equal(f.calls.filter(c=>c==='hold-main').length,getterThrows?1:0);
  }
 });
 integration('later native stage failures retain their exact null/undefined primary without finalization',async()=>{
  for(const phase of ['register','close','seal','release'])for(const primary of [null,undefined]){const f=completionIPCFixture({[phase](){throw primary;}}),p=await f.prepare();await f.execute(p.transportId).then(()=>assert.fail('unexpected success'),error=>assert.equal(error,primary));assert.equal(f.executionChallenges().some(c=>c.sequence===7),false);assert.equal(f.calls.filter(x=>x===phase).length,1);assert(f.state.held);}
 });
 integration('reentry from actual source check poisons the outer flight before COPY',async()=>{
  let armed=false,nested,id;const f=completionIPCFixture({check(f){if(armed){armed=false;nested=f.execute(id);void nested.catch(()=>{});}}}),p=await f.prepare();id=p.transportId;armed=true;
  await assert.rejects(f.execute(id));await assert.rejects(nested);assert(!f.calls.includes('copy'));assert(f.state.held);
 });
 integration('timeout waiting for renderer finalization preserves known Main release without replay',async()=>{
  const f=completionIPCFixture({auto:false}),p=await f.prepare(),w=f.execute(p.transportId);void w.catch(()=>{});
  for(let i=0;i<6;i++){await tick();f.respond(f.executionChallenges()[i]);}await tick();assert.equal(f.executionChallenges().at(-1).sequence,7);assert(f.state.released);f.timeout();await assert.rejects(w);assert.equal(f.calls.filter(x=>x==='hold-main').length,0);assert.equal(f.calls.filter(x=>x==='release').length,1);
 });
 integration('a malformed release return without a genuine historical ACK never establishes known release',async()=>{
  const f=completionIPCFixture({release(){return{};},getRelease(){return null;}}),p=await f.prepare();await assert.rejects(f.execute(p.transportId));assert.equal(f.calls.filter(x=>x==='hold-main').length,1);assert.equal(f.executionChallenges().some(c=>c.sequence===7),false);
 });
}
