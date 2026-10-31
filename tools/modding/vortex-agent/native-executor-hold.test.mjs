import test from 'node:test';
import assert from 'node:assert/strict';
import {repo,stage,sha,deferred,tick} from './native-query-source-admission.test.mjs';
import {createMainAnchorFixture} from './native-main-executor-anchor.test.mjs';

const own=(name,run)=>test(name,{skip:repo?false:'Set VORTEX_EXTENSION_ADMISSION_REPO'},run);
const fixture=(t,options={})=>createMainAnchorFixture(t,{...options,extraMainStages:['native-main-executor-hold']});
const anchor=()=>Buffer.from(JSON.stringify({schema:'native-executor-anchor/1',rootId:'1:2',inventorySHA256:'a'.repeat(64)}));

test('main hold patch is bound to the exact anchor writer predecessor',()=>{
  const {m,patch}=stage('native-main-executor-hold'),parent=stage('native-main-executor-anchor').m;
  assert.equal(sha(patch),m.patchSHA256);assert.equal(m.inputSHA256,parent.outputSHA256);
  assert.equal(m.prerequisitePatchSHA256,parent.patchSHA256);
  assert.equal(m.installed,false);assert.equal(m.installationPermit,false);
});

own('genuine reservation hold is synchronous, idempotent and performs no SQL or refund',async t=>{
  const f=await fixture(t),owner=await f.reserve(),before=f.calls.length;
  f.main.holdNativeModPersistenceReservation(owner);
  assert.equal(f.calls.length,before);
  assert.equal(f.main.getNativeModPersistenceReservation().phase,'held');
  assert.equal(f.main.getNativeModPersistenceReservation().writeFailureObserved,true);
  f.main.holdNativeModPersistenceReservation(owner);
  assert.equal(f.calls.length,before);
  assert.throws(()=>f.main.checkNativeModPersistenceReservation(owner));
  await assert.rejects(f.main.reserveNativeModPersistence('game','another'));
  await assert.rejects(f.write(owner,null,anchor()));
  assert.equal(f.committed.has('nativeExecutorAnchorV1'),false);
  assert.equal(f.calls.length,before);
});

own('wrong owner and forged receiver cannot consume the actual reservation',async t=>{
  const f=await fixture(t),owner=await f.reserve(),hold=f.Main.prototype.holdNativeModPersistenceReservation;
  const before=f.calls.length;
  assert.throws(()=>f.main.holdNativeModPersistenceReservation({}),/HOLD_OWNER/);
  for(const fake of [null,{},Object.create(f.Main.prototype),new Proxy(f.main,{})]){
    assert.throws(()=>hold.call(fake,owner),/HOLD_OWNER/);
  }
  assert.equal(f.calls.length,before);
  f.main.checkNativeModPersistenceReservation(owner);
  assert.equal(f.main.getNativeModPersistenceReservation().phase,'reserved');
  assert.equal(f.main.getNativeModPersistenceReservation().writeFailureObserved,false);
});

own('hold during an anchor queue wait prevents later SQL even after the queue settles',async t=>{
  const f=await fixture(t),owner=await f.reserve(),gate=deferred();
  f.main.mUpdateQueue=gate.promise;
  const writing=f.write(owner,null,anchor());const result=writing.then(value=>({value}),error=>({error}));
  await tick();const before=f.calls.length;
  f.main.holdNativeModPersistenceReservation(owner);gate.resolve();
  assert((await result).error);
  assert.equal(f.calls.length,before);assert.equal(f.committed.has('nativeExecutorAnchorV1'),false);
  assert.equal(f.main.getNativeModPersistenceReservation().phase,'held');
});

own('hold after COMMIT preserves committed evidence but rejects a late successful acknowledgement',async t=>{
  const gate=deferred(),committed=deferred();
  const f=await fixture(t,{afterRun:async sql=>{if(sql==='COMMIT'){committed.resolve();await gate.promise;}}});
  const owner=await f.reserve(),writing=f.write(owner,null,anchor());
  const result=writing.then(value=>({value}),error=>({error}));
  await committed.promise;f.main.holdNativeModPersistenceReservation(owner);gate.resolve();
  assert((await result).error);
  assert.equal(f.committed.get('nativeExecutorAnchorV1'),anchor().toString());
  assert.equal(f.calls.filter(row=>row.sql==='COMMIT').length,1);
  assert.equal(f.calls.filter(row=>row.sql==='ROLLBACK').length,0);
  assert.equal(f.main.getNativeModPersistenceReservation().phase,'held');
  await assert.rejects(f.write(owner,anchor(),anchor()));
});
