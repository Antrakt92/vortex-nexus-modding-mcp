// Run these source actors serially. No Vortex/native DB/process is started.
// Actual Main/Level/Registry/journal/CAS/lower release; explicit SQL/frame/relay/observer facades.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createMainCancellationFixture} from './native-cancellation-main-fixture.mjs';
const K='nativeExecutorAnchorV1',sha=b=>createHash('sha256').update(b).digest('hex');
const available=process.env.VORTEX_EXTENSION_ADMISSION_REPO&&process.env.VORTEX_EXTENSION_ADMISSION_DEPS&&process.env.VORTEX_CAPSULE_BUILD_SOURCE;
const actor=(name,body)=>test(name,{timeout:30000,skip:available?false:'Set reviewed source/deps/capsule compiler workspace'},body);
function deferred(){let resolve;const promise=new Promise(r=>{resolve=r;});return{promise,resolve};}
const tick=()=>new Promise(r=>setImmediate(r));
function held(f){assert.equal(f.main.getNativeModPersistenceReservation().phase,'held');assert.notEqual(f.level.getNativeBackendWriteStatus().phase,'not_reserved');assert.notEqual(f.pool.getNativeSQLConnectionStatus().phase,'not_reserved');}
function noInstall(f){assert.equal(f.relayCalls.filter(x=>x==='start').length,0);assert(![...f.committed.keys()].some(k=>k.startsWith('persistent###mods###')));assert(![...f.committed.keys()].some(k=>k.includes('###installed')));}
function pending(f){const inv=f.census();assert.equal(inv.closedCount,0);assert.equal(inv.unresolvedCount,1);assert.equal(inv.startupHoldRequired,true);return inv;}
async function closed(t,options={}){const f=await createMainCancellationFixture(t,options),ticket=await f.prepare(),result=await f.cancel(ticket);return{f,ticket,result};}

actor('prepared cancel joins model physical closure, writes genuine v3 C, owned CAS/readback then actual unregistered release and ordinary writes',async t=>{
 const f=await createMainCancellationFixture(t),ticket=await f.prepare(),B=Buffer.from(f.committed.get(K));pending(f);
 const result=await f.cancel(ticket);assert.equal(result.schema,'native-executor-inert-cancel-closed/1');assert.equal(Object.keys(result).length,10);assert.equal(result.installationPermit,false);
 assert.deepEqual(f.relayCalls.filter(x=>x!=='observer'),['cancel','release']);pending(f);assert.equal(f.main.getNativeModPersistenceReservation().phase,'reserved');
 const transition=await f.cancelSeal(ticket),C=Buffer.from(f.committed.get(K));assert.notDeepEqual(C,B);assert.equal(transition.previousInventorySHA256,JSON.parse(B).inventorySHA256);
 assert.equal(transition.inventorySHA256,JSON.parse(C).inventorySHA256);assert.deepEqual(await f.level.readNativeExecutorAnchor(),C);
 const inv=f.census();assert.equal(inv.historySealVerified,true);assert.equal(inv.closedCount,1);assert.equal(inv.unresolvedCount,0);assert.equal(inv.startupHoldRequired,false);
 const record=JSON.parse(fs.readFileSync(path.join(f.root,'terminals',result.operationId,'terminal.json')));
 assert.equal(record.schema,'native-executor-terminal/3');assert.equal(record.outcome,'prepared_no_start_cancelled_worker_closed');
 for(const name of ['fullRecordSHA256','registrationObservationSHA256','adoptionObservationSHA256','releaseObservationSHA256'])assert.equal(Object.hasOwn(record,name),false);
 assert.equal(record.inertCancelObservationSHA256,result.inertCancelObservationSHA256);
 const before=new Map(f.committed),ack=f.cancelRelease(ticket);assert.equal(ack.schema,'native-executor-cancellation-release/1');assert.equal(Object.keys(ack).length,10);assert.equal(ack.released,true);
 assert.equal(f.cancellationRelease(ticket),ack);assert.deepEqual(f.committed,before);assert.equal(f.main.getNativeModPersistenceReservation().phase,'not_reserved');
 assert.equal(f.level.getNativeBackendWriteStatus().phase,'not_reserved');assert.equal(f.pool.getNativeSQLConnectionStatus().phase,'not_reserved');
 await f.level.setItem(['settings','afterInertCancel'],'ordinary');assert.equal(await f.level.getItem(['settings','afterInertCancel']),'ordinary');
 assert(fs.existsSync(path.join(f.root,'jobs',result.nativeJobId,'binding.json')));assert(fs.existsSync(path.join(f.root,'operations',result.operationId,'intent.json')));
 noInstall(f);f.assertSameLifetime();
});

actor('foreign and proxy tickets reject without touching or poisoning the genuine prepared operation',async t=>{
 const f=await createMainCancellationFixture(t),ticket=await f.prepare();let traps=0;
 for(const fake of [{},null,Object.freeze({}),new Proxy(ticket,{get(){traps++;throw Error('trap');}})]){
  await assert.rejects(f.cancel(fake));await assert.rejects(f.cancelSeal(fake));assert.throws(()=>f.cancelRelease(fake));assert.throws(()=>f.cancellationRelease(fake));
 }
 assert.equal(traps,0);assert.equal(f.main.getNativeModPersistenceReservation().phase,'reserved');await f.cancel(ticket);await f.cancelSeal(ticket);f.cancelRelease(ticket);noInstall(f);
});

actor('seal and release before joined cancel refuse without SDK control or fabricated terminal',async t=>{
 for(const action of ['seal','release']){const f=await createMainCancellationFixture(t),ticket=await f.prepare();
  if(action==='seal')await assert.rejects(f.cancelSeal(ticket));else assert.throws(()=>f.cancelRelease(ticket));
  held(f);noInstall(f);assert.deepEqual(f.relayCalls,[]);assert.equal(fs.existsSync(path.join(f.root,'terminals')),false);
 }
});

actor('unknown cancel/release preserve primary null and undefined, retain pending B and all lower owners',async t=>{
 for(const stage of ['inertCancel','inertRelease'])for(const primary of [null,undefined]){
  const f=await createMainCancellationFixture(t,{[stage]:()=>{throw primary;}}),ticket=await f.prepare(),B=f.committed.get(K);let rejected=false;
  await f.cancel(ticket).then(()=>assert.fail('unexpected cancel grant'),e=>{rejected=true;assert.equal(e,primary);});assert(rejected);held(f);assert.equal(f.committed.get(K),B);
  pending(f);noInstall(f);await assert.rejects(f.cancel(ticket));await assert.rejects(f.cancelSeal(ticket));assert.throws(()=>f.cancelRelease(ticket));assert.equal(f.cancellationRelease(ticket),null);
 }
});

actor('mismatched observer binding/packet or unclosed pipe refuses even after model processes close',async t=>{
 for(const mutate of [v=>{v.binding.operationId='op_'+'f'.repeat(32);},v=>{v.packetSHA256='f'.repeat(64);},v=>{v.workerTerminal.pipes.stdout.closeObserved=false;}]){
  const f=await createMainCancellationFixture(t,{inertObservation:v=>{mutate(v);return v;}}),ticket=await f.prepare();await assert.rejects(f.cancel(ticket));held(f);pending(f);noInstall(f);
  assert.equal(fs.existsSync(path.join(f.root,'terminals')),false);
 }
});

actor('observer accessor cannot execute or synthesize authority',async t=>{
 let getters=0;const f=await createMainCancellationFixture(t,{inertObservation:v=>{Object.defineProperty(v,'packetSHA256',{enumerable:true,get(){getters++;return'f'.repeat(64);}});return v;}}),ticket=await f.prepare();
 await assert.rejects(f.cancel(ticket));assert.equal(getters,0);held(f);pending(f);noInstall(f);
});

actor('COPY racing a pending cancel irreversibly holds both branches; late close cannot grant',async t=>{
 const gate=deferred(),entered=deferred(),f=await createMainCancellationFixture(t,{inertCancel:()=>{entered.resolve();return gate.promise;}}),ticket=await f.prepare();
 const first=f.cancel(ticket);void first.catch(()=>{});await entered.promise;
 try{await assert.rejects(f.copy(ticket));held(f);}finally{gate.resolve();}
 await assert.rejects(first);assert.deepEqual(f.relayCalls,['cancel']);pending(f);noInstall(f);assert.equal(f.cancellationRelease(ticket),null);
});

actor('cancel after COPY claimed is refused without sending cancel or writing terminal',async t=>{
 const gate=deferred(),entered=deferred(),f=await createMainCancellationFixture(t,{inertStart:()=>{entered.resolve();return gate.promise;}}),ticket=await f.prepare();
 const first=f.copy(ticket);void first.catch(()=>{});await entered.promise;
 try{await assert.rejects(f.cancel(ticket));held(f);}finally{gate.resolve();}
 await assert.rejects(first);assert.deepEqual(f.relayCalls,['start']);assert.equal(fs.existsSync(path.join(f.root,'terminals')),false);assert(![...f.committed.keys()].some(k=>k.startsWith('persistent###mods###')));
});

actor('cancel callback duplicate reentry poisons outer before release and before terminal publication',async t=>{
 let f,ticket,inner;f=await createMainCancellationFixture(t,{inertCancel:()=>{inner=f.cancel(ticket);void inner.catch(()=>{});}});ticket=await f.prepare();
 await assert.rejects(f.cancel(ticket));await assert.rejects(inner);held(f);assert.deepEqual(f.relayCalls,['cancel']);pending(f);noInstall(f);
});

actor('frame drift during joined closure retains B and refuses publication',async t=>{
 let f;f=await createMainCancellationFixture(t,{inertRelease:()=>{f.frame.hold(f.frameOwner);}});const ticket=await f.prepare(),B=f.committed.get(K);
 await assert.rejects(f.cancel(ticket));assert.equal(f.committed.get(K),B);held(f);pending(f);noInstall(f);
});

actor('terminal COMMIT lost acknowledgement retains real committed C but never releases and preserves raw primary',async t=>{
 for(const primary of [null,undefined]){let armed=false;
  const f=await createMainCancellationFixture(t,{afterRun:sql=>{if(armed&&sql==='COMMIT')throw primary;}}),ticket=await f.prepare();await f.cancel(ticket);
  const B=f.committed.get(K);armed=true;let rejected=false;
  await f.cancelSeal(ticket).then(()=>assert.fail('unexpected seal'),e=>{rejected=true;assert.equal(e,primary);});assert(rejected);assert.notEqual(f.committed.get(K),B);
  held(f);assert.throws(()=>f.cancelRelease(ticket));assert.equal(f.cancellationRelease(ticket),null);noInstall(f);assert.equal(f.census().closedCount,1);
  const n=f.calls.length;await assert.rejects(f.cancelSeal(ticket));assert.equal(f.calls.length,n);
 }
});

actor('known release survives later frame hold and duplicate controls; cancelled slot cannot automatically start another job',async t=>{
 const{f,ticket}=await closed(t);await f.cancelSeal(ticket);const ack=f.cancelRelease(ticket),calls=f.calls.length;
 f.frame.hold(f.frameOwner);assert.equal(f.cancellationRelease(ticket),ack);assert.throws(()=>f.cancelRelease(ticket));assert.equal(f.cancellationRelease(ticket),ack);
 await assert.rejects(f.cancel(ticket));assert.equal(f.cancellationRelease(ticket),ack);assert.throws(()=>f.preflight());assert.equal(f.cancellationRelease(ticket),ack);
 assert.equal(f.calls.length,calls);assert.equal(f.main.getNativeModPersistenceReservation().phase,'not_reserved');noInstall(f);
});

actor('journal alteration after sealed C refuses release before lower preparation or any writer opening',async t=>{
 let lowerPreparations=0;
 const{f,ticket,result}=await closed(t,{beforeMainClass(types){const original=types.LevelPersist.prototype.prepareNativeUnregisteredRelease;
  types.LevelPersist.prototype.prepareNativeUnregisteredRelease=function(...args){lowerPreparations++;return original.apply(this,args);};
 }});
 await f.cancelSeal(ticket);const C=f.committed.get(K);
 // This immutable own-fixture terminal was valid at seal; a later byte change must invalidate C.
 fs.appendFileSync(path.join(f.root,'terminals',result.operationId,'terminal.json'),'\n');
 assert.throws(()=>f.cancelRelease(ticket));assert.equal(lowerPreparations,0);held(f);assert.equal(f.cancellationRelease(ticket),null);
 assert.equal(f.committed.get(K),C);noInstall(f);
});
