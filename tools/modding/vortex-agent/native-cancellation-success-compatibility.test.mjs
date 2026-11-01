// Source-only installed-success compatibility; run actors serially.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createSuccessCompatibilityFixture} from './native-cancellation-main-fixture.mjs';
const ready=process.env.VORTEX_EXTENSION_ADMISSION_REPO&&process.env.VORTEX_EXTENSION_ADMISSION_DEPS&&process.env.VORTEX_CAPSULE_BUILD_SOURCE;
const integration=(name,fn)=>test(name,{timeout:30000,skip:!ready},fn);
const K='nativeExecutorAnchorV1';
function adoption(observed){return Buffer.from(JSON.stringify({schema:'native-executor-renderer-adoption/1',transportId:'transport_'+'1'.repeat(32),operationId:observed.operationId,nativeJobId:observed.nativeJobId,requestSHA256:observed.requestSHA256,recordSHA256:observed.recordSHA256,fullRecordSHA256:observed.fullRecordSHA256,effectsAllowed:false,installationPermit:false}));}

integration('existing installed path completes twice on same Main/capsule and retains separate historical installed ACKs',async t=>{
 const f=await createSuccessCompatibilityFixture(t),first=await f.registered();await f.close(first);await f.seal(first);const release1=f.release(first),anchor1=f.committed.get(K);
 assert.equal(f.wiring.getNativeExecutorTransportCancellationRelease(first),null);
 const finish1=f.wiring.prepareNativeExecutorSuccessor(first);assert(Object.isFrozen(finish1));finish1();
 assert.deepEqual(f.knownRelease(first),release1);assert(Object.isFrozen(f.knownRelease(first)));assert.equal(f.wiring.getNativeExecutorTransportCancellationRelease(first),null);
 assert.throws(finish1);assert.equal(f.committed.get(K),anchor1);assert.equal(f.census().closedCount,1);assert.equal(f.census().unresolvedCount,0);assert.equal(f.capsule.loads(),1);
 const next=f.nextInputs(),second=f.preflight(next.requestBytes,next.archiveBytes);
 assert.throws(finish1);assert.throws(()=>f.wiring.prepareNativeExecutorSuccessor(first));assert.throws(()=>f.wiring.prepareNativeExecutorCancellationSuccessor(first));
 f.wiring.checkNativeExecutorTransport(second);assert.deepEqual(f.knownRelease(first),release1);assert.equal(f.wiring.getNativeExecutorTransportCancellationRelease(first),null);
 await f.wiring.reserveNativeExecutorTransport(second);const pending=await f.wiring.prepareNativeExecutorTransportPending(second,f.frameOwner);
 assert.equal(pending.operationId,next.request.operationId);assert.equal(f.census().closedCount,1);assert.equal(f.census().unresolvedCount,1);assert.notEqual(f.committed.get(K),anchor1);
 await f.copy(second);const observed2=await f.register(second);assert.equal(observed2.operationId,next.request.operationId);assert.equal(observed2.trackedAssociationVerified,true);
 const bytes2=adoption(observed2);await f.close(second,bytes2);await f.seal(second,bytes2);const release2=f.release(second),anchor2=f.committed.get(K);
 assert.notEqual(anchor2,anchor1);assert.equal(f.wiring.getNativeExecutorTransportCancellationRelease(second),null);
 const finish2=f.wiring.prepareNativeExecutorSuccessor(second);finish2();
 assert.throws(finish1);assert.throws(finish2);assert.deepEqual(f.knownRelease(first),release1);assert.deepEqual(f.knownRelease(second),release2);
 assert.equal(f.wiring.getNativeExecutorTransportCancellationRelease(first),null);assert.equal(f.wiring.getNativeExecutorTransportCancellationRelease(second),null);
 assert.equal(f.census().closedCount,2);assert.equal(f.census().unresolvedCount,0);assert.equal(f.committed.get(K),anchor2);
 for(const mod of ['own','second-own'])assert(f.committed.has('persistent###mods###cyberpunk2077###'+mod+'###id'));
 assert.equal(f.main.getNativeModPersistenceReservation().phase,'not_reserved');assert.equal(f.level.getNativeBackendWriteStatus().phase,'not_reserved');f.assertSameLifetime();assert.equal(f.capsule.loads(),1);
 assert.equal(f.relayCalls.includes('cancel'),false);
});
integration('separate cancelled successor refuses installed current ticket without synthesizing cancellation ACK',async t=>{
 const f=await createSuccessCompatibilityFixture(t),ticket=await f.registered();await f.close(ticket);await f.seal(ticket);const release=f.release(ticket),anchor=f.committed.get(K);
 assert.throws(()=>f.wiring.prepareNativeExecutorCancellationSuccessor(ticket));
 assert.equal(f.wiring.getNativeExecutorTransportCancellationRelease(ticket),null);assert.deepEqual(f.knownRelease(ticket),release);assert.equal(f.committed.get(K),anchor);
 assert.equal(f.census().closedCount,1);assert.equal(f.census().unresolvedCount,0);assert.equal(f.capsule.loads(),1);assert.equal(f.relayCalls.includes('cancel'),false);
 const next=f.nextInputs();assert.throws(()=>f.preflight(next.requestBytes,next.archiveBytes));
});
integration('original successful successor still refuses registered/closed/sealed states before known release',async t=>{
 for(const stage of ['registered','closed','sealed']){
  const f=await createSuccessCompatibilityFixture(t),ticket=await f.registered();if(stage!=='registered')await f.close(ticket);if(stage==='sealed')await f.seal(ticket);
  assert.throws(()=>f.wiring.prepareNativeExecutorSuccessor(ticket));assert.equal(f.knownRelease(ticket),null);assert.equal(f.wiring.getNativeExecutorTransportCancellationRelease(ticket),null);
  assert.equal(f.census().unresolvedCount,stage==='sealed'?0:1);assert.equal(f.census().closedCount,stage==='sealed'?1:0);assert.equal(f.main.getNativeModPersistenceReservation().phase,'held');assert.equal(f.capsule.loads(),1);
 }
});
integration('original final-frame reentry blocks installed retirement and preserves historical release',async t=>{
 let f,armed=false,checks=0,nested=0,ticket;
 const frameAPI={checkNativeExecutorFrame(owner){f.frame.check(owner);if(armed&&++checks===2){nested++;assert.throws(()=>f.wiring.prepareNativeExecutorSuccessor(ticket));}},holdNativeExecutorFrame(owner){f.frame.hold(owner);}};
 f=await createSuccessCompatibilityFixture(t,{frameAPI});ticket=await f.registered();await f.close(ticket);await f.seal(ticket);const release=f.release(ticket),anchor=f.committed.get(K);
 const finalize=f.wiring.prepareNativeExecutorSuccessor(ticket);armed=true;assert.throws(finalize);assert.equal(nested,1);
 const next=f.nextInputs();assert.throws(()=>f.preflight(next.requestBytes,next.archiveBytes));assert.deepEqual(f.knownRelease(ticket),release);assert.equal(f.wiring.getNativeExecutorTransportCancellationRelease(ticket),null);
 assert.equal(f.committed.get(K),anchor);assert.equal(f.census().closedCount,1);assert.equal(f.census().unresolvedCount,0);assert.equal(f.main.getNativeModPersistenceReservation().phase,'not_reserved');
});
