import test from 'node:test';import assert from 'node:assert/strict';import {EventEmitter}from'node:events';
import path from'node:path';import{fileURLToPath}from'node:url';
import{repo,prepared,execute,stage,sha,deferred,tick}from'./native-query-source-admission.test.mjs';
const stages=['ack-main-ipc','native-main-readiness-ipc','native-executor-frame-owner'];
const own=(name,fn)=>test(name,{timeout:10000,skip:repo?false:'Set VORTEX_EXTENSION_ADMISSION_REPO'},fn);
export function frameFixture({watchFailure=false,bound=true,setup=true}={}){
 const handlers=new Map(),timers=new Map(),ready=deferred(),mainReadyOwner=Object.freeze({});let timerId=0;
 const persistor={async flushPersistenceAcknowledged(){}},state={current:persistor,onMain:null,now:0,mainPID:4321};
 const owner=new EventEmitter();Object.assign(owner,{id:91,mainFrame:{processId:17,routingId:22},dead:false,rendererPID:8123,
   isDestroyed(){return this.dead;},getOSProcessId(){return this.rendererPID;}});
 if(watchFailure)owner.on=()=>{throw Error('own watcher failure');};
 const context={betterIpcMain:{handle(n,fn){handlers.set(n,fn);},on(){},send(){}},ipcMain:{on(){}},log(){},
  registerAllPersistedHives:async()=>({}),getMainPersistor(){state.onMain?.();return state.current;},waitForNativeMainPersistenceReady:()=>ready.promise,
  checkNativeMainPersistenceReady(o){assert.equal(o,mainReadyOwner);},process:{get pid(){return state.mainPID;}},performance:{now:()=>state.now},
  setTimeout(fn,ms){const id=++timerId;timers.set(id,{fn,ms});return id;},clearTimeout(id){timers.delete(id);}};
 const api=execute(prepared(stages),'({setupPersistenceIPC,bindPersistenceAcknowledgementSender,reserveNativeExecutorFrame,checkNativeExecutorFrame,holdNativeExecutorFrame})',context);
 if(setup)api.setupPersistenceIPC(persistor);if(bound)api.bindPersistenceAcknowledgementSender(owner);
 const event={sender:owner,senderFrame:owner.mainFrame};
 return{api,owner,state,event,persistor,timers,handlers,ready:()=>ready.resolve(mainReadyOwner),
  reserve:e=>api.reserveNativeExecutorFrame(e??event),check:t=>api.checkNativeExecutorFrame(t),hold:t=>api.holdNativeExecutorFrame(t),
  read:()=>handlers.get('persist:native-main-readiness')(event,'request_001'),ack:()=>handlers.get('persist:diffs-acknowledged')(event,[])};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
test('frame producer pins the exact qualified readiness source without adding authority',()=>{
 const{m,patch}=stage('native-executor-frame-owner'),parent=stage('native-main-readiness-ipc').m;
 assert.equal(m.inputSHA256,parent.outputSHA256);assert.equal(m.prerequisitePatchSHA256,parent.patchSHA256);assert.equal(sha(patch),m.patchSHA256);
 for(const k of ['installed','nativeAcceptanceVerified','installationPermit','nativeAdmission','effectsAllowed','powerLossPersistenceVerified'])assert.equal(m[k],false);
});
own('actual source returns one opaque frozen owner and adds no IPC handler or timer',()=>{
 const f=frameFixture(),token=f.reserve();assert.equal(Object.isFrozen(token),true);assert.deepEqual(Reflect.ownKeys(token),[]);
 f.check(token);assert.equal(f.timers.size,0);assert.deepEqual([...f.handlers.keys()],['persist:native-main-readiness','persist:diffs-acknowledged','persist:get-hydration']);
 assert.throws(()=>f.reserve(),/FRAME_BUSY/);f.check(token);
 for(const fake of [{},Object.freeze({}),structuredClone(token),null]){assert.throws(()=>f.check(fake),/FRAME_OWNER/);assert.throws(()=>f.hold(fake),/FRAME_OWNER/);}
 f.check(token);
});
own('wrong window, missing or subframe, wrong persistor and unbound source refuse without a token',()=>{
 for(const kind of ['window','missing','subframe','persistor','unbound','watch','setup']){
  const f=frameFixture({bound:kind!=='unbound',watchFailure:kind==='watch',setup:kind!=='setup'});
  if(kind==='window')f.event.sender={...f.owner};if(kind==='missing')f.event.senderFrame=null;
  if(kind==='subframe')f.event.senderFrame={...f.owner.mainFrame};if(kind==='persistor')f.state.current={};
  assert.throws(()=>f.reserve(),/FRAME_HOLD/);assert.throws(()=>f.reserve(),/FRAME_BUSY/);
 }
});
own('navigation, crash, destruction and malformed main navigation metadata latch the independent owner',()=>{
 for(const kind of ['navigation','crash','destroy','malformed']){
  const f=frameFixture(),token=f.reserve();
  if(kind==='navigation')f.owner.emit('did-start-navigation',{isMainFrame:true});
  if(kind==='crash')f.owner.emit('render-process-gone',{},{});
  if(kind==='destroy'){f.owner.dead=true;f.owner.emit('destroyed');}
  if(kind==='malformed')assert.doesNotThrow(()=>f.owner.emit('did-start-navigation',Object.defineProperty({},'isMainFrame',{get(){throw Error('own');}})));
  assert.throws(()=>f.check(token),/FRAME_HOLD/);f.owner.dead=false;assert.throws(()=>f.check(token),/FRAME_HOLD/);
 }
 const f=frameFixture(),token=f.reserve();f.owner.emit('did-start-navigation',{isMainFrame:false});f.check(token);
});
own('frame replacement with identical IDs and source pointer changes cannot pass a later check',()=>{
 for(const kind of ['frame','event','main','pid','frameid','windowid']){
  const f=frameFixture(),token=f.reserve();
  if(kind==='frame'){f.owner.mainFrame={...f.owner.mainFrame};f.event.senderFrame=f.owner.mainFrame;}
  if(kind==='event')f.event.senderFrame={...f.owner.mainFrame};if(kind==='main')f.state.current={};
  if(kind==='pid')f.owner.rendererPID++;if(kind==='frameid')f.owner.mainFrame.routingId++;if(kind==='windowid')f.owner.id++;
  assert.throws(()=>f.check(token),/FRAME_HOLD/);
 }
});
own('source drift while a caller awaits remains held when the caller resumes',async()=>{
 const f=frameFixture(),token=f.reserve(),gate=deferred();
 const work=(async()=>{f.check(token);await gate.promise;f.check(token);})();const result=work.then(()=>false,()=>true);
 f.owner.emit('did-start-navigation',{isMainFrame:true});gate.resolve();assert.equal(await result,true);assert.equal(f.timers.size,0);
});
own('reserve claims before native getters and caught nested reservation cannot revive its outer claim',()=>{
 const f=frameFixture();let nested=0;
 f.owner.getOSProcessId=()=>{if(!nested++){assert.throws(()=>f.reserve(),/FRAME_BUSY/);}return 8123;};
 assert.throws(()=>f.reserve(),/FRAME_HOLD/);assert.equal(nested,1);assert.throws(()=>f.reserve(),/FRAME_BUSY/);
});
own('genuine check or hold reentry poisons the outer check even when callbacks catch and restore state',()=>{
 for(const kind of ['check','hold']){
  const f=frameFixture(),token=f.reserve();let once=true;
  f.owner.getOSProcessId=()=>{if(once){once=false;if(kind==='check')assert.throws(()=>f.check(token),/FRAME_HOLD/);else f.hold(token);}return 8123;};
  assert.throws(()=>f.check(token),/FRAME_HOLD/);f.owner.getOSProcessId=()=>8123;assert.throws(()=>f.check(token),/FRAME_HOLD/);
 }
});
own('event senderFrame getter reentry is observed before a first token can escape',()=>{
 const f=frameFixture();let once=true;
 Object.defineProperty(f.event,'senderFrame',{get(){if(once){once=false;assert.throws(()=>f.reserve(),/FRAME_BUSY/);}return f.owner.mainFrame;}});
 assert.throws(()=>f.reserve(),/FRAME_HOLD/);
});
own('synchronous source-only hold is idempotent and performs no native callbacks',()=>{
 const f=frameFixture(),token=f.reserve();f.owner.isDestroyed=()=>{assert.fail('held owner must not sample callbacks');};
 assert.doesNotThrow(()=>f.hold(token));assert.doesNotThrow(()=>f.hold(token));assert.throws(()=>f.check(token),/FRAME_HOLD/);assert.equal(f.timers.size,0);
});
own('readiness observation settlement never removes the executor invalidation hook or changes the twelve-field DTO',async()=>{
 const f=frameFixture(),read=f.read(),token=f.reserve();f.ready();const dto=await read;
 assert.equal(Object.keys(dto).length,12);assert.equal(dto.installationPermit,false);assert.equal(f.timers.size,0);f.check(token);
 f.owner.emit('did-start-navigation',{isMainFrame:true});assert.throws(()=>f.check(token),/FRAME_HOLD/);await f.ack();
});
own('getter errors are normalized without inspecting an unknown error message',()=>{
 const f=frameFixture();let calls=0;const error=Object.defineProperty({},'message',{get(){calls++;throw Error('private');}});
 f.owner.getOSProcessId=()=>{throw error;};assert.throws(()=>f.reserve(),/FRAME_HOLD/);assert.equal(calls,0);
});
own('invalid native integer samples refuse and an independent main PID change invalidates a token',()=>{
 for(const kind of ['main','window','renderer','process','routing']){
  const f=frameFixture();if(kind==='main')f.state.mainPID=0;if(kind==='window')f.owner.id=NaN;
  if(kind==='renderer')f.owner.rendererPID=0;if(kind==='process')f.owner.mainFrame.processId=-1;if(kind==='routing')f.owner.mainFrame.routingId=1.5;
  assert.throws(()=>f.reserve(),/FRAME_HOLD/);
 }
 const f=frameFixture(),token=f.reserve();f.state.mainPID++;assert.throws(()=>f.check(token),/FRAME_HOLD/);
});
own('final scalar sample drift and caught source setup replacement cannot produce a successful check',()=>{
 const f=frameFixture();let n=0;f.owner.getOSProcessId=()=>++n>1?9000:8123;assert.throws(()=>f.reserve(),/FRAME_HOLD/);
 const g=frameFixture(),token=g.reserve();let once=true;g.state.onMain=()=>{if(once){once=false;g.api.setupPersistenceIPC({});}};
 assert.throws(()=>g.check(token),/FRAME_HOLD/);g.state.onMain=null;assert.throws(()=>g.check(token),/FRAME_HOLD/);
});
}
