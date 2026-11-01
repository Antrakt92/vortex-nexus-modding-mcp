import test from 'node:test';
import assert from 'node:assert/strict';
import {createCancellationFixture as fixture,deferred,tick} from './native-cancellation-renderer-fixture.mjs';
const enabled=process.env.VORTEX_EXTENSION_ADMISSION_REPO&&process.env.VORTEX_EXTENSION_ADMISSION_DEPS;
const sourceTest=(name,fn)=>test(name,{skip:enabled?false:'Set reviewed source/dependency inputs',timeout:20000},fn);
sourceTest('four cancellation stages open only genuine inert owners and handoff reuses boot route',async()=>{
 const f=await fixture();await f.prepared();f.store.dispatch({type:'SETTING',payload:{key:'pending',value:1}});
 const r=await f.complete();assert.equal(r.outcome,'prepared_no_start_cancelled_worker_closed');assert(Object.isFrozen(r));
 assert.equal(f.manager.getNativeInstallExclusion().exclusiveHeld,false);assert.equal(f.rootApi.getNativeRendererTargetStatus().phase,'not_reserved');
 assert.equal(f.store.getState().persistent.mods.game.new,undefined);assert.equal(f.store.getState().persistent.downloads.files.archive.installed,undefined);
 f.fire();assert.match(JSON.stringify(f.sent),/pending/);assert.doesNotMatch(JSON.stringify(f.sent),/__nmtNativeRegistration|"installed"/);
 const h=f.ext.handoffNativeExecutorCancellationSuccessor();f.handoffGate.resolve(f.successor());const ack=await h;assert(Object.isFrozen(ack));assert.equal(ack.ready,true);
 assert.equal(await f.ext.handoffNativeExecutorCancellationSuccessor(),ack);assert.deepEqual(f.registrations,{prepare:1,execution:1,cancellation:1});
 assert.equal(f.calls.filter(x=>x[0]==='execute').length,0);assert.equal(f.calls.filter(x=>x[0]==='cancel').length,1);
});
sourceTest('execute and cancellation cannot race or synthesize adopted state',async()=>{
 const f=await fixture();await f.prepared();const flight=f.ext.cancelNativeExecutorPrepared();void flight.catch(()=>{});
 await assert.rejects(f.ext.executeNativeExecutor());await assert.rejects(flight);assert.equal(f.calls.filter(x=>x[0]==='execute').length,0);
 assert.equal(f.store.getState().persistent.mods.game.new,undefined);assert(f.manager.getNativeInstallExclusion().exclusiveHeld);
});
sourceTest('profile ABA invalidates pending cancellation promptly and late success cannot open owners',async()=>{
 const f=await fixture();await f.prepared();const p=f.ext.cancelNativeExecutorPrepared();void p.catch(()=>{});await f.receive(f.challenge(1));
 f.store.dispatch({type:'SETTING',payload:{key:'profiles',value:{activeProfileId:'q'}}});f.store.dispatch({type:'SETTING',payload:{key:'profiles',value:{activeProfileId:'p'}}});
 await assert.rejects(p);assert.equal(f.invalidations.length,1);assert.equal(f.invalidations[0].cancellationId,f.cancellationId);
 f.cancelGate.resolve(f.result());await tick();assert(f.manager.getNativeInstallExclusion().exclusiveHeld);assert.equal(f.rootApi.getNativeRendererTargetStatus().phase,'reserved');
});
sourceTest('late or substituted inert method descriptors are refused before local release',async()=>{
 for(const method of ['prepareNativeInertRelease','checkNativeInertRelease','finalizeNativeInertRelease']){
  const f=await fixture();await f.prepared();let calls=0;
  f.Manager.prototype[method]=()=>{calls++;return Object.freeze({});};
  await assert.rejects(f.ext.cancelNativeExecutorPrepared());assert.equal(calls,0);assert(f.manager.getNativeInstallExclusion().exclusiveHeld);
 }
});
sourceTest('bad final receipt and original unsubscribe failure never open local gates',async()=>{
 for(const mode of ['receipt','unsubscribe']){
  let armed=false;const f=await fixture();
  if(mode==='unsubscribe'){const subscribe=f.store.subscribe;f.store.subscribe=function(listener){const off=subscribe.call(this,listener);return()=>{off();if(armed)throw Error('own unsubscribe');};};}
  await f.prepared();const p=f.ext.cancelNativeExecutorPrepared();void p.catch(()=>{});
  for(const n of[1,2,3])assert.notEqual((await f.receive(f.challenge(n))).state,'failed');armed=true;
  const c=f.challenge(4,mode==='receipt'?{payloadJSON:JSON.stringify({...f.release(),inventorySHA256:'BAD'})}:{});
  assert.equal((await f.receive(c)).state,'failed');await assert.rejects(p);assert(f.manager.getNativeInstallExclusion().exclusiveHeld);
  assert.notEqual(f.rootApi.getNativeRendererTargetStatus().phase,'not_reserved');
 }
});
sourceTest('unknown final result preserves actual local release while forbidding cancel/release replay or successor',async()=>{
 const f=await fixture();await f.prepared();const p=f.ext.cancelNativeExecutorPrepared();void p.catch(()=>{});
 for(const n of[1,2,3,4])assert.notEqual((await f.receive(f.challenge(n))).state,'failed');
 assert.equal(f.manager.getNativeInstallExclusion().exclusiveHeld,false);assert.equal(f.rootApi.getNativeRendererTargetStatus().phase,'not_reserved');
 f.cancelGate.reject(null);await p.then(()=>assert.fail('unexpected result'),error=>assert.equal(error,null));
 await assert.rejects(f.ext.cancelNativeExecutorPrepared());await assert.rejects(f.ext.executeNativeExecutor());await assert.rejects(f.ext.handoffNativeExecutorCancellationSuccessor());
 assert.equal(f.calls.filter(x=>x[0]==='cancel').length,1);assert.equal(f.calls.filter(x=>x[0]==='execute').length,0);assert.equal(f.calls.filter(x=>x[0]==='cancel-handoff').length,0);
 assert.equal(f.manager.getNativeInstallExclusion().exclusiveHeld,false);
});
sourceTest('lost cancellation handoff ACK retries exact IDs without cancelling or finalizing again',async()=>{
 const a=deferred(),b=deferred();let handoffs=0;
 const f=await fixture({handoffInvoke:()=>++handoffs===1?a.promise:b.promise});await f.prepared();const result=await f.complete();
 const first=f.ext.handoffNativeExecutorCancellationSuccessor();a.reject(undefined);await first.then(()=>assert.fail('unexpected ACK'),e=>assert.equal(e,undefined));
 const second=f.ext.handoffNativeExecutorCancellationSuccessor();b.resolve(f.successor());assert.equal((await second).ready,true);
 assert.equal(result.rendererReleased,true);assert.equal(f.calls.filter(x=>x[0]==='cancel').length,1);
 const rows=f.calls.filter(x=>x[0]==='cancel-handoff');assert.deepEqual(rows[0],rows[1]);
});
