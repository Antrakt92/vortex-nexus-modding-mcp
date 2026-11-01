// Actual Main source, fixed journal/capsule and explicit SQL/frame/process facades.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createTwoOperationMainFixture} from './native-successor-main-fixture.mjs';
const ready=process.env.VORTEX_EXTENSION_ADMISSION_REPO&&process.env.VORTEX_EXTENSION_ADMISSION_DEPS&&process.env.VORTEX_CAPSULE_BUILD_SOURCE;
const integration=(name,body)=>test(name,{timeout:30000,skip:ready?false:'Set reviewed source/dependency and capsule compiler inputs'},body);
integration('actual Main retires only completed state and retains immutable known release after retirement',async t=>{
  const f=await createTwoOperationMainFixture(t);
  const ticket=await f.registered();await f.close(ticket);await f.seal(ticket);const release=f.release(ticket);
  const anchor=f.committed.get('nativeExecutorAnchorV1');
  const finalize=f.wiring.prepareNativeExecutorSuccessor(ticket);
  assert.equal(typeof finalize,'function');assert(Object.isFrozen(finalize));finalize();
  assert.deepEqual(f.knownRelease(ticket),release);assert(Object.isFrozen(f.knownRelease(ticket)));
  assert.throws(finalize);assert.deepEqual(f.knownRelease(ticket),release);
  assert.equal(f.committed.get('nativeExecutorAnchorV1'),anchor);
  assert.equal(f.census().closedCount,1);assert.equal(f.capsule.loads(),1);
  assert.equal(f.main.getNativeModPersistenceReservation().phase,'not_reserved');
  assert.throws(()=>f.wiring.checkNativeExecutorTransport(ticket));
  const next=f.nextInputs();
  const second=f.preflight(next.requestBytes,next.archiveBytes);
  assert.notEqual(second,ticket);
  assert.equal(f.wiring.getNativeExecutorTransportBinding(second).operationId,next.request.operationId);
  assert.throws(finalize);
  assert.throws(()=>f.wiring.prepareNativeExecutorSuccessor(ticket));
  f.wiring.checkNativeExecutorTransport(second);
  assert.deepEqual(f.knownRelease(ticket),release);
  assert.equal(f.committed.get('nativeExecutorAnchorV1'),anchor);
  assert.equal(f.capsule.loads(),1);
  await f.wiring.reserveNativeExecutorTransport(second);
  const pending=await f.wiring.prepareNativeExecutorTransportPending(second,f.frameOwner);
  assert.equal(pending.operationId,next.request.operationId);
  assert.equal(f.census().closedCount,1);assert.equal(f.census().unresolvedCount,1);
  assert.notEqual(f.committed.get('nativeExecutorAnchorV1'),anchor);
  assert(f.committed.has('persistent###mods###cyberpunk2077###own###id'));
  assert.equal(f.capsule.loads(),1);
});
integration('actual Main refuses successor before worker closure, terminal seal and confirmed release',async t=>{
  for(const stage of ['registered','closed','sealed']){
    const f=await createTwoOperationMainFixture(t),ticket=await f.registered();
    if(stage!=='registered')await f.close(ticket);if(stage==='sealed')await f.seal(ticket);
    assert.throws(()=>f.wiring.prepareNativeExecutorSuccessor(ticket));
    assert.equal(f.census().unresolvedCount,stage==='sealed'?0:1);assert.equal(f.census().closedCount,stage==='sealed'?1:0);
    assert.equal(f.main.getNativeModPersistenceReservation().phase,'held');
    assert.equal(f.knownRelease(ticket),null);assert.equal(f.relayCalls.includes('release'),stage!=='registered');
  }
});
integration('reentry during final frame validation holds old operation before any successor retirement',async t=>{
  let f,armed=false,checks=0,nested=0,ticket;
  const frameAPI={
    checkNativeExecutorFrame(owner){
      f.frame.check(owner);
      if(armed&&++checks===2){nested++;assert.throws(()=>f.wiring.prepareNativeExecutorSuccessor(ticket));}
    },holdNativeExecutorFrame(owner){f.frame.hold(owner);}
  };
  f=await createTwoOperationMainFixture(t,{frameAPI});
  ticket=await f.registered();await f.close(ticket);await f.seal(ticket);const release=f.release(ticket);
  const anchor=f.committed.get('nativeExecutorAnchorV1');
  const finalize=f.wiring.prepareNativeExecutorSuccessor(ticket);armed=true;
  assert.throws(finalize);assert.equal(nested,1);
  const next=f.nextInputs();
  assert.throws(()=>f.preflight(next.requestBytes,next.archiveBytes));
  assert.equal(f.committed.get('nativeExecutorAnchorV1'),anchor);
  assert.deepEqual(f.knownRelease(ticket),release);
  assert.equal(f.census().closedCount,1);assert.equal(f.census().unresolvedCount,0);
  assert.equal(f.main.getNativeModPersistenceReservation().phase,'not_reserved');
});
