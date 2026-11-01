import test from'node:test';import assert from'node:assert/strict';
import{createRendererSuccessorFixture}from'./native-renderer-successor-fixture.mjs';
const tick=()=>new Promise(r=>setImmediate(r));
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
const available=process.env.VORTEX_EXTENSION_ADMISSION_REPO&&process.env.VORTEX_EXTENSION_ADMISSION_DEPS;
const sourceTest=(name,fn)=>test(name,{skip:available?false:'Set reviewed source/dependency inputs',timeout:15000},fn);
sourceTest('known completion hands off exact two IDs and retires only operation fields',async()=>{
 const f=await createRendererSuccessorFixture();const result=await f.complete();const request=f.request;
 const handoff=f.ext.handoffNativeExecutorSuccessor();await tick();assert.deepEqual(f.successorCalls,[{transportId:f.transportId,executionId:f.executionId}]);
 f.successorGate.resolve(f.successorACK());const ack=await handoff;assert(Object.isFrozen(ack));assert.equal(Object.keys(ack).length,10);assert.equal(result.rendererReleased,true);
 assert.deepEqual(f.registrations(),{prepare:1,execution:1});assert.equal(f.rootApi.getNativeRendererTargetStatus().phase,'not_reserved');assert.equal(f.manager.getNativeInstallExclusion().exclusiveHeld,false);
 assert.equal(await f.ext.handoffNativeExecutorSuccessor(),ack);assert.equal(f.successorCalls.length,1);assert.equal(f.request,request);
 // This ends at a NEW genuine prepare flight, not a second forged completion.
 const next=f.ext.prepareNativeExecutor(f.request,f.archive);void next.catch(()=>{});await tick();assert.equal(f.prepareCalls.length,2);
 await assert.rejects(f.ext.handoffNativeExecutorSuccessor());
});
sourceTest('no completion or only prepared/running operation cannot invoke handoff',async()=>{
 const a=await createRendererSuccessorFixture();await a.ready();await assert.rejects(a.ext.handoffNativeExecutorSuccessor());assert.equal(a.successorCalls.length,0);
 const b=await createRendererSuccessorFixture();await b.prepared();await assert.rejects(b.ext.handoffNativeExecutorSuccessor());assert.equal(b.successorCalls.length,0);
});
sourceTest('lost ACK preserves known result and exact retry correlation without installation replay',async()=>{
 const first=deferred(),second=deferred();let calls=0;const f=await createRendererSuccessorFixture({handoffInvoke:()=>++calls===1?first.promise:second.promise});
 const result=await f.complete();const p=f.ext.handoffNativeExecutorSuccessor();first.reject(undefined);await assert.rejects(p,e=>e===undefined);
 assert.equal(result.rendererReleased,true);assert.equal(f.executed.length,1);const retry=f.ext.handoffNativeExecutorSuccessor();second.resolve(f.successorACK());await retry;
 assert.equal(calls,2);assert.deepEqual(f.successorCalls[0],f.successorCalls[1]);assert.equal(f.executed.length,1);
});
sourceTest('foreign, malformed, getter and proxy ACKs never rearm completed operation',async()=>{
 for(const change of[v=>({...v,transportId:'transport_'+'f'.repeat(32)}),v=>({...v,ready:false}),v=>({...v,extra:true}),
   v=>Object.defineProperty({...v},'ready',{enumerable:true,get(){assert.fail('getter');}}),v=>new Proxy(v,{get(){assert.fail('proxy');}})]){
  const f=await createRendererSuccessorFixture();const result=await f.complete();const p=f.ext.handoffNativeExecutorSuccessor();f.successorGate.resolve(change(f.successorACK()));await assert.rejects(p);
  await assert.rejects(f.ext.prepareNativeExecutor(f.request,f.archive));assert.equal(f.executed.length,1);assert.equal(result.rendererReleased,true);
 }
});
sourceTest('profile ABA while ACK is pending rejects promptly and late ACK cannot rearm',async()=>{
 const f=await createRendererSuccessorFixture();const result=await f.complete();const p=f.ext.handoffNativeExecutorSuccessor();let settled=false;p.catch(()=>{settled=true;});await tick();
 f.store.dispatch({type:'SETTING',payload:{key:'profiles',value:{activeProfileId:'q'}}});f.store.dispatch({type:'SETTING',payload:{key:'profiles',value:{activeProfileId:'p'}}});
 await tick();assert.equal(settled,true);await assert.rejects(p);f.successorGate.resolve(f.successorACK());await tick();
 await assert.rejects(f.ext.handoffNativeExecutorSuccessor());assert.equal(result.rendererReleased,true);assert.equal(f.executed.length,1);
});
sourceTest('concurrent genuine handoff holds both observers and never clears on late ACK',async()=>{
 const f=await createRendererSuccessorFixture();await f.complete();const first=f.ext.handoffNativeExecutorSuccessor();void first.catch(()=>{});await tick();
 await assert.rejects(f.ext.handoffNativeExecutorSuccessor());await assert.rejects(first);f.successorGate.resolve(f.successorACK());await tick();
 await assert.rejects(f.ext.prepareNativeExecutor(f.request,f.archive));assert.equal(f.successorCalls.length,1);
});
sourceTest('preload method drift and unsubscribe reentry refuse without changing success result',async()=>{
 for(const mode of['method','unsubscribe']){
  const f=await createRendererSuccessorFixture();let nested,armed=false;
  if(mode==='unsubscribe'){const subscribe=f.store.subscribe;f.store.subscribe=function(listener){const off=subscribe.call(this,listener);return()=>{off();if(armed){nested=f.ext.handoffNativeExecutorSuccessor();void nested.catch(()=>{});}};};}
  const result=await f.complete();armed=true;
  if(mode==='method')f.persist.handoffNativeExecutorSuccessor=()=>{assert.fail('substituted method');};
  const p=f.ext.handoffNativeExecutorSuccessor();void p.catch(()=>{});if(mode==='unsubscribe')f.successorGate.resolve(f.successorACK());await assert.rejects(p);if(mode==='unsubscribe'){assert(nested,'actual handoff unsubscriber must reach reentry');await assert.rejects(nested);}
  assert.equal(result.rendererReleased,true);await assert.rejects(f.ext.prepareNativeExecutor(f.request,f.archive));
 }
});
