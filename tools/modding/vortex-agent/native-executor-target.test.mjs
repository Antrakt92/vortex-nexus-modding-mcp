import test from 'node:test';
import assert from 'node:assert/strict';
import {repo,stage,sha} from './native-query-source-admission.test.mjs';
import {createMainAnchorFixture} from './native-main-executor-anchor.test.mjs';
const own=(name,run)=>test(name,{skip:repo?false:'Set VORTEX_EXTENSION_ADMISSION_REPO'},run);
const fixture=t=>createMainAnchorFixture(t,{extraMainStages:['native-main-executor-hold','native-main-executor-target']});

test('target binding patch follows the actual main hold source',()=>{
  const {m,patch}=stage('native-main-executor-target'),parent=stage('native-main-executor-hold').m;
  assert.equal(sha(patch),m.patchSHA256);assert.equal(m.inputSHA256,parent.outputSHA256);
  assert.equal(m.prerequisitePatchSHA256,parent.patchSHA256);assert.equal(m.installationPermit,false);
});

own('genuine owner binds only its exact game and mod without SQL or consuming mismatches',async t=>{
  const f=await fixture(t),owner=await f.reserve(),before=f.calls.length;
  f.main.checkNativeModPersistenceTarget(owner,'game','new');
  for(const [game,mod]of [['other','new'],['game','other'],['GAME','new'],['game','NEW']]){
    assert.throws(()=>f.main.checkNativeModPersistenceTarget(owner,game,mod),/TARGET_REFUSED/);
    f.main.checkNativeModPersistenceTarget(owner,'game','new');
  }
  assert.equal(f.calls.length,before);assert.equal(f.main.getNativeModPersistenceReservation().phase,'reserved');
});

own('wrong owners, forged receivers and caller coercions cannot become target authority',async t=>{
  const f=await fixture(t),owner=await f.reserve(),method=f.Main.prototype.checkNativeModPersistenceTarget;
  assert.throws(()=>f.main.checkNativeModPersistenceTarget({},'game','new'),/TARGET_REFUSED/);
  for(const fake of [null,{},Object.create(f.Main.prototype),new Proxy(f.main,{})]){
    assert.throws(()=>method.call(fake,owner,'game','new'),/TARGET_REFUSED/);
  }
  let calls=0;const foreign={toString(){calls++;return'game';},[Symbol.toPrimitive](){calls++;return'game';}};
  assert.throws(()=>f.main.checkNativeModPersistenceTarget(owner,foreign,'new'),/TARGET_REFUSED/);
  assert.throws(()=>f.main.checkNativeModPersistenceTarget(owner,'game',foreign),/TARGET_REFUSED/);
  assert.equal(calls,0);f.main.checkNativeModPersistenceTarget(owner,'game','new');
});

own('reservation lost during callback-capable backend checking cannot pass the final target check',async t=>{
  const f=await fixture(t),owner=await f.reserve(),original=f.level.checkNativeBackendWriteOwner;
  let entered=false;
  f.level.checkNativeBackendWriteOwner=function(value){
    const result=original.call(this,value);
    if(!entered){entered=true;f.main.holdNativeModPersistenceReservation(owner);}
    return result;
  };
  assert.throws(()=>f.main.checkNativeModPersistenceTarget(owner,'game','new'));
  assert.equal(entered,true);assert.equal(f.main.getNativeModPersistenceReservation().phase,'held');
  assert.throws(()=>f.main.checkNativeModPersistenceTarget(owner,'game','new'));
});
