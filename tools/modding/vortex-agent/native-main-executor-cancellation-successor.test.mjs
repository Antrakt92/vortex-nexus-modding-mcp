// Actual-source successor actors; run serially.
// Actual classes/capsule/journal/CAS; SQL/frame/physical relay+observer are explicit facades.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createMainCancellationFixture} from './native-cancellation-main-fixture.mjs';
const ready=process.env.VORTEX_EXTENSION_ADMISSION_REPO&&process.env.VORTEX_EXTENSION_ADMISSION_DEPS&&process.env.VORTEX_CAPSULE_BUILD_SOURCE;
const actor=(name,body)=>test(name,{timeout:30000,skip:ready?false:'Set reviewed source/deps/capsule compiler workspace'},body);
const hash=b=>createHash('sha256').update(b).digest('hex'),K='nativeExecutorAnchorV1';
async function released(t,options={}){
 const f=await createMainCancellationFixture(t,options),ticket=await f.prepare(),closed=await f.cancel(ticket);
 await f.cancelSeal(ticket);const ack=f.cancelRelease(ticket);return{f,ticket,closed,ack};
}
function noInstall(f){assert(![...f.committed.keys()].some(k=>k.startsWith('persistent###mods###')||k.includes('###installed')));assert.equal(f.relayCalls.includes('start'),false);}
const successor=(f,ticket)=>f.wiring.prepareNativeExecutorCancellationSuccessor(ticket);

actor('cancelled release retires into compact history, then distinct job2 prepares and cancels in SAME Main/store/backend/capsule lifetime',async t=>{
 const{f,ticket,closed,ack}=await released(t),firstTerminal=path.join(f.root,'terminals',closed.operationId,'terminal.json');
 const firstBytes=fs.readFileSync(firstTerminal),firstHash=hash(firstBytes),anchor=f.committed.get(K),beforeMap=new Map(f.committed);
 const finalize=successor(f,ticket);assert.equal(typeof finalize,'function');assert(Object.isFrozen(finalize));finalize();
 assert.equal(f.cancellationRelease(ticket),ack);assert.equal(f.knownRelease(ticket),null);assert.throws(finalize);assert.equal(f.committed.get(K),anchor);
 const next=f.nextInputs();assert.notEqual(next.request.operationId,closed.operationId);assert.notEqual(next.request.nativeJobId,closed.nativeJobId);
 assert.notEqual(next.requestSHA256,closed.requestSHA256);assert.notEqual(next.request.plan.package.sha256,f.request.plan.package.sha256);
 assert.notEqual(next.request.plan.package.expectedModId,f.request.plan.package.expectedModId);assert.notEqual(next.request.plan.package.downloadId,f.request.plan.package.downloadId);
 const second=f.preflight(next.requestBytes,next.archiveBytes);assert.notEqual(second,ticket);await f.wiring.reserveNativeExecutorTransport(second);
 const pending=await f.wiring.prepareNativeExecutorTransportPending(second,f.frameOwner);assert.equal(pending.operationId,next.request.operationId);
 let inv=f.census();assert.equal(inv.closedCount,1);assert.equal(inv.unresolvedCount,1);assert.equal(inv.startupHoldRequired,true);
 assert.equal(hash(fs.readFileSync(firstTerminal)),firstHash);assert.deepEqual(fs.readFileSync(firstTerminal),firstBytes);
 assert(fs.existsSync(path.join(f.root,'jobs',closed.nativeJobId,'binding.json')));assert(fs.existsSync(path.join(f.root,'operations',closed.operationId,'intent.json')));
 for(const[k,v]of beforeMap)if(k!==K)assert.equal(f.committed.get(k),v,k);
 const secondClosed=await f.cancel(second);assert.equal(secondClosed.requestSHA256,next.requestSHA256);assert.equal(secondClosed.operationId,next.request.operationId);
 await f.cancelSeal(second);const secondAck=f.cancelRelease(second);assert.notEqual(secondAck,ack);successor(f,second)();
 inv=f.census();assert.equal(inv.closedCount,2);assert.equal(inv.unresolvedCount,0);assert.equal(inv.historySealVerified,true);
 assert.equal(f.cancellationRelease(ticket),ack);assert.equal(f.cancellationRelease(second),secondAck);assert.equal(f.knownRelease(ticket),null);assert.equal(f.knownRelease(second),null);
 assert.equal(hash(fs.readFileSync(firstTerminal)),firstHash);assert.equal(f.capsule.loads(),1);f.assertSameLifetime();noInstall(f);
});

actor('historical cancellation getter is kind-separated and never becomes an installed ACK after job2 begins',async t=>{
 const{f,ticket,ack}=await released(t);assert.equal(f.knownRelease(ticket),null);successor(f,ticket)();
 assert.equal(f.cancellationRelease(ticket),ack);assert.equal(f.knownRelease(ticket),null);assert(Object.isFrozen(ack));
 const n=f.nextInputs(),second=f.preflight(n.requestBytes,n.archiveBytes);await f.wiring.reserveNativeExecutorTransport(second);await f.wiring.prepareNativeExecutorTransportPending(second,f.frameOwner);
 const phase=f.main.getNativeModPersistenceReservation().phase;
 for(const action of [()=>f.cancelRelease(ticket),()=>successor(f,ticket),()=>f.wiring.prepareNativeExecutorSuccessor(ticket)])assert.throws(action);
 await assert.rejects(f.cancel(ticket));await assert.rejects(f.cancelSeal(ticket));
 assert.equal(f.cancellationRelease(ticket),ack);assert.equal(f.knownRelease(ticket),null);assert.equal(f.cancellationRelease(second),null);assert.equal(f.knownRelease(second),null);
 assert.equal(f.main.getNativeModPersistenceReservation().phase,phase);f.wiring.checkNativeExecutorTransport(second);noInstall(f);
});

actor('used cancellation finalizer stays inert after fresh preflight and reservation, and cannot poison job2 pending ownership',async t=>{
 const{f,ticket,ack}=await released(t),finalize=successor(f,ticket);finalize();const n=f.nextInputs(),second=f.preflight(n.requestBytes,n.archiveBytes);
 assert.throws(finalize);f.wiring.checkNativeExecutorTransport(second);await f.wiring.reserveNativeExecutorTransport(second);
 assert.throws(finalize);f.wiring.checkNativeExecutorTransport(second);await f.wiring.prepareNativeExecutorTransportPending(second,f.frameOwner);
 const calls=f.calls.length,controls=f.relayCalls.length,anchor=f.committed.get(K);assert.throws(finalize);f.wiring.checkNativeExecutorTransport(second);
 assert.equal(f.calls.length,calls);assert.equal(f.relayCalls.length,controls);assert.equal(f.committed.get(K),anchor);assert.equal(f.cancellationRelease(ticket),ack);
 assert.equal(f.census().closedCount,1);assert.equal(f.census().unresolvedCount,1);noInstall(f);
});

actor('premature cancellation successor at prepared/cancelled/sealed stages holds and cannot retire the operation',async t=>{
 for(const stage of ['prepared','cancelled','sealed']){
  const f=await createMainCancellationFixture(t),ticket=await f.prepare();if(stage!=='prepared')await f.cancel(ticket);if(stage==='sealed')await f.cancelSeal(ticket);
  const anchor=f.committed.get(K),calls=f.calls.length;assert.throws(()=>successor(f,ticket));assert.equal(f.main.getNativeModPersistenceReservation().phase,'held');
  assert.equal(f.committed.get(K),anchor);assert.equal(f.calls.length,calls);assert.equal(f.cancellationRelease(ticket),null);assert.equal(f.knownRelease(ticket),null);
  assert.throws(()=>f.preflight());assert.equal(f.census().closedCount,stage==='sealed'?1:0);noInstall(f);
 }
});

actor('wrong installed-success lane holds a genuine completed cancellation without fabricating registration or retracting known lower release',async t=>{
 const{f,ticket,ack}=await released(t),anchor=f.committed.get(K);assert.throws(()=>f.wiring.prepareNativeExecutorSuccessor(ticket));
 assert.throws(()=>successor(f,ticket));assert.throws(()=>f.preflight());assert.equal(f.cancellationRelease(ticket),ack);assert.equal(f.knownRelease(ticket),null);
 assert.equal(f.main.getNativeModPersistenceReservation().phase,'not_reserved');assert.equal(f.committed.get(K),anchor);assert.equal(f.census().closedCount,1);noInstall(f);
});

actor('reentry in final frame check holds before any cancellation retirement and retains truthful historical release',async t=>{
 let f,ticket,armed=false,checks=0,nested=0;
 const frameAPI={checkNativeExecutorFrame(owner){f.frame.check(owner);if(armed&&++checks===2){nested++;assert.throws(()=>successor(f,ticket));}},holdNativeExecutorFrame(owner){f.frame.hold(owner);}};
 f=await createMainCancellationFixture(t,{frameAPI});ticket=await f.prepare();await f.cancel(ticket);await f.cancelSeal(ticket);
 const ack=f.cancelRelease(ticket),anchor=f.committed.get(K),finalize=successor(f,ticket);armed=true;
 assert.throws(finalize);assert.equal(nested,1);assert.throws(()=>f.preflight());assert.equal(f.cancellationRelease(ticket),ack);assert.equal(f.knownRelease(ticket),null);
 assert.equal(f.committed.get(K),anchor);assert.equal(f.census().closedCount,1);assert.equal(f.main.getNativeModPersistenceReservation().phase,'not_reserved');noInstall(f);
});

actor('foreign and proxy successor tickets cannot consume or poison genuine completed cancellation',async t=>{
 const{f,ticket,ack}=await released(t);let traps=0;
 for(const fake of [{},null,Object.freeze({}),new Proxy(ticket,{get(){traps++;throw Error('trap');}})])assert.throws(()=>successor(f,fake));
 assert.equal(traps,0);const finalize=successor(f,ticket);finalize();assert.equal(f.cancellationRelease(ticket),ack);
 const n=f.nextInputs(),second=f.preflight(n.requestBytes,n.archiveBytes);f.wiring.checkNativeExecutorTransport(second);noInstall(f);
});
