// Source actors only. No installed Vortex, real LevelDB or worker process.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createCancellationComposition as fixture,deferred,tick} from './native-cancellation-integration-fixture.mjs';
const ready=process.env.VORTEX_EXTENSION_ADMISSION_REPO&&process.env.VORTEX_EXTENSION_ADMISSION_DEPS&&process.env.VORTEX_CAPSULE_BUILD_SOURCE;
const actor=(name,fn)=>test(name,{skip:ready?false:'Set reviewed source/dependency/capsule compiler inputs',timeout:60000},fn);
const K='nativeExecutorAnchorV1';
const released=f=>{assert.equal(f.main.main.getNativeModPersistenceReservation().phase,'not_reserved');assert.equal(f.main.level.getNativeBackendWriteStatus().phase,'not_reserved');assert.equal(f.renderer.manager.getNativeInstallExclusion().exclusiveHeld,false);assert.equal(f.renderer.rootApi.getNativeRendererTargetStatus().phase,'not_reserved');};
actor('two distinct actual four-actor cancellations retain same lifetime C history and admit a fresh operation',async t=>{
 const f=await fixture(t),p=f.prepared,B=f.main.committed.get(K),first=await f.cancel();released(f);f.assertNoInstall();
 assert.equal(first.mainReleased,true);assert.equal(first.rendererReleased,true);assert.equal(first.outcome,'prepared_no_start_cancelled_worker_closed');
 const C=f.main.committed.get(K);assert.notEqual(C,B);assert.equal(f.main.census().closedCount,1);assert.equal(f.main.census().unresolvedCount,0);
 const terminal=path.join(f.main.root,'terminals',first.operationId,'terminal.json'),bytes=fs.readFileSync(terminal);
 assert.equal(JSON.parse(bytes).schema,'native-executor-terminal/3');
 const handoff=await f.handoff();assert.equal(handoff.cancellationId,first.cancellationId);
 f.renderer.store.dispatch({type:'SETTING',payload:{key:'betweenCancellations',value:7}});f.renderer.fire();
 for(const batch of f.renderer.sent)await f.main.main.applyDiffOperationsAcknowledged(batch.hive,batch.operations);
 assert.equal(f.main.committed.get('settings###betweenCancellations'),'7');
 const second=await f.prepareNext();assert.notEqual(second.operationId,p.operationId);assert.notEqual(second.nativeJobId,p.nativeJobId);assert.notEqual(second.transportId,p.transportId);
 assert.equal(f.main.census().closedCount,1);assert.equal(f.main.census().unresolvedCount,1);
 const next=await f.cancel();released(f);assert.notEqual(next.cancellationId,first.cancellationId);assert.notEqual(f.main.committed.get(K),C);await f.handoff();
 assert.equal(f.main.census().closedCount,2);assert.equal(f.main.census().unresolvedCount,0);assert.equal(f.main.census().historySealVerified,true);
 assert.deepEqual(fs.readFileSync(terminal),bytes);assert.equal(f.main.relayCalls.filter(x=>x==='cancel').length,2);assert.equal(f.main.relayCalls.filter(x=>x==='release').length,2);
 assert.equal(f.preload.listeners.size,3);assert.deepEqual(Object.values(f.registrations()),[1,1,1]);f.main.assertSameLifetime();f.assertNoInstall();
});
actor('lost actual cancellation HANDOFF acknowledgement reconciles only historical IDs without replay',async t=>{
 let replies=0;const f=await fixture(t,{invoke:(channel,args,result)=>{if(channel==='persist:native-executor-cancellation-successor'&&++replies===1)throw undefined;return result;}});
 const result=await f.cancel(),C=f.main.committed.get(K),controls=f.main.relayCalls.filter(x=>x!=='observer'),committed=new Map(f.main.committed);
 const terminal=path.join(f.main.root,'terminals',result.operationId,'terminal.json'),bytes=fs.readFileSync(terminal);
 await f.handoff().then(()=>assert.fail('unexpected ACK'),e=>assert.equal(e,undefined));released(f);
 const ack=await f.handoff();assert.equal(ack.cancellationId,result.cancellationId);assert.equal(replies,2);
 assert.deepEqual(f.main.relayCalls.filter(x=>x!=='observer'),controls);assert.equal(f.main.committed.get(K),C);
 assert.deepEqual(f.main.committed,committed);assert.deepEqual(fs.readFileSync(terminal),bytes);f.main.assertSameLifetime();
 await f.prepareNext();await f.cancel();await f.handoff();assert.equal(f.main.census().closedCount,2);f.assertNoInstall();
});
actor('actual profile ABA wakes cancellation while Main physical facade waits and late work cannot release',async t=>{
 const entered=deferred(),gate=deferred();const f=await fixture(t,{main:{inertCancel:async()=>{entered.resolve();await gate.promise;}}});
 const p=f.cancel();void p.catch(()=>{});await entered.promise;
 f.renderer.store.dispatch({type:'SETTING',payload:{key:'profiles',value:{activeProfileId:'q'}}});f.renderer.store.dispatch({type:'SETTING',payload:{key:'profiles',value:{activeProfileId:'p'}}});
 await assert.rejects(p);assert.equal(f.main.main.getNativeModPersistenceReservation().phase,'held');assert(f.renderer.manager.getNativeInstallExclusion().exclusiveHeld);
 gate.resolve();await tick();await tick();assert.equal(f.main.census().unresolvedCount,1);assert.notEqual(f.renderer.rootApi.getNativeRendererTargetStatus().phase,'not_reserved');
 await assert.rejects(f.handoff());f.assertNoInstall();
});
actor('actual terminal anchor COMMIT lost acknowledgement retains C but cannot release or retry',async t=>{
 let armed=false;const primary=null,handlerRejected=deferred();
 const f=await fixture(t,{main:{inertRelease:()=>{armed=true;},afterRun:sql=>{if(armed&&sql==='COMMIT')throw primary;}},
  invokeFailure:(channel,error)=>{if(channel==='persist:native-executor-cancel')handlerRejected.resolve({channel,primary:error});}});
 const B=f.main.committed.get(K);
 // Cancellation races its prompt local HOLD observer against the remote call.
 // Unlike legacy execute's invoke-only wait, its first rejection may be fixed
 // local HOLD; the actual Main/IPC handler must independently retain raw null.
 await assert.rejects(f.cancel(),/NATIVE_EXECUTOR_RENDERER_FAILED/);
 assert.equal((await handlerRejected.promise).primary,primary);
 assert.equal(f.invokeFailures.find(x=>x.channel==='persist:native-executor-cancel').primary,primary);
 assert.notEqual(f.main.committed.get(K),B);assert.equal(f.main.census().closedCount,1);assert.equal(f.main.main.getNativeModPersistenceReservation().phase,'held');
 assert(f.renderer.manager.getNativeInstallExclusion().exclusiveHeld);const calls=[...f.main.relayCalls];await assert.rejects(f.cancel());await assert.rejects(f.handoff());assert.deepEqual(f.main.relayCalls,calls);f.assertNoInstall();
});
actor('original Renderer unsubscribe failure leaves actual Main released and local writers held',async t=>{
 let armed=false,offCalls=0;
 const f=await fixture(t,{rendererSetup:r=>{const subscribe=r.store.subscribe;r.store.subscribe=function(listener){const off=subscribe.call(this,listener);return()=>{off();offCalls++;if(armed)throw Error('owned unsubscribe refusal');};};}});
 armed=true;await assert.rejects(f.cancel());assert.equal(offCalls,1);
 assert.equal(f.main.main.getNativeModPersistenceReservation().phase,'not_reserved');assert.equal(f.main.level.getNativeBackendWriteStatus().phase,'not_reserved');
 assert.equal(f.ipc.api.testOnlyCancellation().mainReleased,true);assert(f.renderer.manager.getNativeInstallExclusion().exclusiveHeld);
 assert.notEqual(f.renderer.rootApi.getNativeRendererTargetStatus().phase,'not_reserved');assert.equal(f.main.census().closedCount,1);
 const calls=[...f.main.relayCalls];await assert.rejects(f.cancel());await assert.rejects(f.handoff());assert.deepEqual(f.main.relayCalls,calls);f.assertNoInstall();
});
actor('retired prepare execute response hold and historical ACK cannot poison active cancellation2',async t=>{
 const entered=deferred(),gate=deferred();let second=false;
 const f=await fixture(t,{main:{inertCancel:async()=>{if(second){entered.resolve();await gate.promise;}}}});
 const old=await f.cancel(),oldChallenge=f.ipc.cancelChallenges()[0],oldHold={...oldChallenge,sequence:5,stage:'hold',payloadJSON:null};await f.handoff();
 const next=await f.prepareNext();second=true;const pending=f.cancel();void pending.catch(()=>{});await entered.promise;
 try{
  await assert.rejects(f.ipc.execute(old.transportId));await assert.rejects(f.ipc.prepare(f.main.requestBytes,f.main.archiveBytes));
  f.preload.deliver(oldHold);f.ipc.invalidateCancel(oldChallenge);
  assert.equal(f.ipc.cancelHandoff(old.transportId,old.cancellationId).cancellationId,old.cancellationId);
  assert.equal(f.main.main.getNativeModPersistenceReservation().phase,'reserved');assert(f.renderer.manager.getNativeInstallExclusion().exclusiveHeld);
 }finally{gate.resolve();}
 const result=await pending;assert.equal(result.transportId,next.transportId);assert.equal(result.rendererReleased,true);await f.handoff();f.assertNoInstall();
});
