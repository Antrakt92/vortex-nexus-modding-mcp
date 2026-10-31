import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {repo, prepared, execute, original, stage, sha, deferred, tick} from './native-query-source-admission.test.mjs';
import {createAnchorFixture} from './native-executor-anchor-storage.test.mjs';
import {registrationBytes} from './native-owned-mod-registration.test.mjs';

const mainStages=['batch-acknowledgement','target-reservation','acknowledged-packet','backend-reservation-admission','legacy-rollback-primary','native-main-sql-admission','native-main-mod-registration','native-main-tracked-mod-registration','native-main-registration-release','native-main-executor-anchor'];
const bindingStages=['native-query-owner-binding','native-main-readiness','native-main-anchor-binding'];
const K='nativeExecutorAnchorV1';
const anchor=(n='a')=>Buffer.from(JSON.stringify({schema:'native-executor-anchor/1',rootId:'1:2',inventorySHA256:n.repeat(64)}));
const diff=[{type:'set',path:['ordinary'],value:1}];

export async function createMainAnchorFixture(t,options={}) {
  const f=await createAnchorFixture(t,{...options,unreserved:true});
  const Main=execute(prepared(mainStages),'ReduxPersistorIPC',{
    LevelPersist:f.types.LevelPersist,
    snapshotNativeNewModRegistration:f.types.snapshotNativeNewModRegistration,
    snapshotNativeTrackedModRegistration:f.types.snapshotNativeTrackedModRegistration,
    snapshotNativeExecutorAnchor:f.types.snapshotNativeExecutorAnchor,
    isNativeExecutorAnchorKey:f.types.isNativeExecutorAnchorKey,
    structuredClone,unknownToError:e=>e,terminate:e=>{throw e;}
  });
  const SubPersistor=execute(original('src/main/src/store/SubPersistor.ts').toString(),'SubPersistor');
  const main=new Main(),invalidator={notifyDirtyTables(){}};
  main.mPersistors.persistent=new SubPersistor(f.level,'persistent');
  main.mPersistors.settings=new SubPersistor(f.level,'settings');
  main.setQueryInvalidator(f.level,invalidator,f.registry);
  return {...f,Main,SubPersistor,main,invalidator,
    reserve:()=>main.reserveNativeModPersistence('game','new'),
    write:(owner,expected,next)=>main.writeNativeExecutorAnchor(owner,expected,next)};
}

// Initialization collaborators are transparent readiness facades here. The main
// binding, Redux class, SubPersistor, selected Level reader and SQL model are real
// composed source. SQL/query ownership admission has its separate source suite.
async function createBindingFixture(t,options={}) {
  const f=await createMainAnchorFixture(t,options);
  const wiring=execute(prepared(bindingStages),`({initMainPersistence,waitForNativeMainPersistenceReady,
    readNativeExecutorHistoryAnchor,checkNativeMainPersistenceReady,closeMainPersistence,
    registerHive,readHiveData,getPersistedHives,registerAllPersistedHives,
    readPersistedValue,writePersistedValue})`,{
    LevelPersist:f.types.LevelPersist,snapshotNativeExecutorAnchor:f.types.snapshotNativeExecutorAnchor,
    isNativeExecutorAnchorKey:f.types.isNativeExecutorAnchorKey,ReduxPersistorIPC:f.Main,SubPersistor:f.SubPersistor,
    DuckDBSingleton:{getInstance:()=>({isInitialized:true,createConnection:async()=>({})})},
    QueryRegistry:class{async initialize(){}getQueryNames(){return['own readiness facade'];}},
    QueryInvalidator:class{notifyDirtyTables(){}setWatcher(){}},Database:class{},QueryWatcher:class{},
    parseAllQueries:()=>[{}],getVortexPath:()=>f.root,setupPersistenceIPC(){},getErrorMessageOrDefault:()=>''
  });
  const boundMain=wiring.initMainPersistence(f.level),mainReadyOwner=await wiring.waitForNativeMainPersistenceReady();
  return {...f,wiring,boundMain,mainReadyOwner};
}

const integration=(name,fn)=>test(name,{timeout:15000,skip:repo?false:'Set VORTEX_EXTENSION_ADMISSION_REPO'},fn);
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
test('main anchor patches bind exact predecessors and genuine lower companion without admission',()=>{
  for(const [name,parent,companion] of [
    ['native-main-executor-anchor','native-main-registration-release','native-executor-anchor-storage'],
    ['native-main-anchor-binding','native-main-readiness','native-main-executor-anchor']]) {
    const {m,patch}=stage(name),previous=stage(parent).m,lower=stage(companion).m;
    assert.equal(sha(patch),m.patchSHA256);assert.equal(m.inputSHA256,previous.outputSHA256);
    assert.equal(m.prerequisitePatchSHA256,previous.patchSHA256);
    assert.equal(m.requiredCompanionPatchSHA256,lower.patchSHA256);
    assert.equal(m.requiredCompanionOutputSHA256,lower.outputSHA256);
    for(const flag of ['installed','nativeAcceptanceVerified','installationPermit','powerLossPersistenceVerified','startupGateSupported']) assert.equal(m[flag],false);
  }
});

integration('actual main joins its queue, detaches input bytes, and retains all three owners after exact anchor ACK',async t=>{
  const f=await createMainAnchorFixture(t),owner=await f.reserve(),gate=deferred();
  f.main.mUpdateQueue=gate.promise;
  const next=anchor(),originalNext=Buffer.from(next),writing=f.write(owner,null,next);
  next.fill(0);await tick();assert.equal(f.committed.has(K),false);
  assert.throws(()=>f.main.checkNativeModPersistenceReservation(owner),/ANCHOR_BUSY/);
  await assert.rejects(f.main.reserveNativeModPersistence('game','second'),/ANCHOR_BUSY/);
  await assert.rejects(f.main.registerNativeNewMod(owner,Buffer.from('{}')),/ANCHOR_BUSY/);
  assert.throws(()=>f.main.releaseNativeTrackedMod(owner),/ANCHOR_BUSY/);
  gate.resolve();const ack=await writing;
  assert.equal(ack.schema,'native-executor-anchor-write/1');assert.equal(ack.anchorSHA256,sha(originalNext));
  assert.equal(f.committed.get(K),originalNext.toString());
  f.main.checkNativeModPersistenceReservation(owner);
  assert.equal(f.main.getNativeModPersistenceReservation().phase,'reserved');
  const changed=anchor('b'),expectedHash=sha(originalNext),secondGate=deferred();f.main.mUpdateQueue=secondGate.promise;
  const updating=f.write(owner,originalNext,changed);originalNext.fill(0);secondGate.resolve();const second=await updating;
  assert.equal(second.previousSHA256,expectedHash);assert.equal(f.committed.get(K),changed.toString());
});

integration('wrong owner has no effects and cannot consume genuine main reservation',async t=>{
  const f=await createMainAnchorFixture(t),owner=await f.reserve(),before=f.calls.length;
  await assert.rejects(f.write({},null,anchor()),/ANCHOR_REFUSED/);
  assert.equal(f.calls.length,before);f.main.checkNativeModPersistenceReservation(owner);
  await f.write(owner,null,anchor());
});

integration('acknowledged anchor preserves the same actual reservation for one new disabled registration',async t=>{
  const f=await createMainAnchorFixture(t),owner=await f.reserve();await f.write(owner,null,anchor());
  const registration=await f.main.registerNativeNewMod(owner,registrationBytes());
  assert.equal(registration.schema,'native-new-mod-registration-observed/1');assert.equal(f.committed.get(K),anchor().toString());
  assert.equal([...f.committed.keys()].filter(k=>k.startsWith('persistent###mods###game###new###')).length,5);
  await assert.rejects(f.write(owner,anchor(),anchor('b')),/ANCHOR_REFUSED/);
});

integration('main invokes the captured lower prototype writer despite later instance and prototype shadows',async t=>{
  const f=await createMainAnchorFixture(t),owner=await f.reserve();
  f.level.writeNativeExecutorAnchor=()=>{throw Error('instance replacement must not execute');};
  f.types.LevelPersist.prototype.writeNativeExecutorAnchor=()=>{throw Error('prototype replacement must not execute');};
  const ack=await f.write(owner,null,anchor());assert.equal(ack.readbackVerified,true);
  assert.equal(f.committed.get(K),anchor().toString());
});

integration('invalid bytes claim once and leave main held with its backend owner retained without lower writes',async t=>{
  const f=await createMainAnchorFixture(t),owner=await f.reserve(),before=f.calls.length;
  await assert.rejects(f.write(owner,null,Buffer.from('{}')));
  assert.equal(f.calls.length,before);assert.equal(f.main.getNativeModPersistenceReservation().phase,'held');
  await assert.rejects(f.write(owner,null,anchor()),/ANCHOR_REFUSED/);
  assert.throws(()=>f.main.releaseNativeTrackedMod(owner),/ANCHOR_HELD/);
});

integration('ordinary intake during a queued anchor poisons completion before any anchor SQL',async t=>{
  for(const kind of ['legacy','ack','packet']) {
    const f=await createMainAnchorFixture(t),owner=await f.reserve(),gate=deferred();f.main.mUpdateQueue=gate.promise;
    const writing=f.write(owner,null,anchor());const observed=writing.catch(e=>e);
    if(kind==='legacy')assert.throws(()=>f.main.applyDiffOperations('settings',diff),/ANCHOR_HELD/);
    else if(kind==='ack')await assert.rejects(f.main.applyDiffOperationsAcknowledged('settings',diff),/ANCHOR_HELD/);
    else await assert.rejects(f.main.flushPersistenceAcknowledged([{hive:'settings',operations:diff}]),/ANCHOR_HELD/);
    gate.resolve();assert.match(String(await observed),/ANCHOR_HELD/);assert.equal(f.committed.has(K),false);
    assert.equal(f.main.getNativeModPersistenceReservation().phase,'held');
  }
});

integration('actual lower INSERT failure and lost COMMIT acknowledgement retain the exact primary, never retry, and hold main',async t=>{
  for(const [where,primary] of [['insert',undefined],['commit',null]]) {
    const f=await createMainAnchorFixture(t,{afterRun(sql){
      if((where==='insert'&&sql.startsWith('INSERT INTO'))||(where==='commit'&&sql==='COMMIT'))throw primary;
    }}),owner=await f.reserve();
    const outcome=await f.write(owner,null,anchor()).then(()=>({ok:true}),error=>({ok:false,error}));
    assert.equal(outcome.ok,false);assert.equal(outcome.error,primary);
    assert.equal(f.calls.filter(c=>c.sql==='COMMIT').length,where==='commit'?1:0);
    assert.equal(f.calls.filter(c=>c.sql==='ROLLBACK').length,where==='insert'?1:0);
    assert.equal(f.committed.has(K),where==='commit');
    assert.equal(f.main.getNativeModPersistenceReservation().phase,'held');
    const before=f.calls.length;await assert.rejects(f.write(owner,null,anchor()),/ANCHOR_REFUSED/);
    assert.equal(f.calls.length,before);assert.throws(()=>f.main.releaseNativeTrackedMod(owner),/ANCHOR_HELD/);
  }
});

integration('all reserved hive aliases refuse before reads or factory while unrelated hydration remains usable',async t=>{
  const f=await createMainAnchorFixture(t);let calls=0;
  const persistor={async getAllKVs(){calls++;return[];},setResetCallback(){calls++;}};
  f.main.setPersistorFactory(()=>{calls++;return persistor;});
  for(const key of [K,K+'###child']) {
    await assert.rejects(f.main.insertPersistor(key,persistor),/ANCHOR_PRIVATE/);
    assert.throws(()=>f.main.applyDiffOperations(key,diff),/ANCHOR_PRIVATE/);
    await assert.rejects(f.main.applyDiffOperationsAcknowledged(key,diff));
    await assert.rejects(f.main.flushPersistenceAcknowledged([{hive:key,operations:diff}]));
    f.main.mPersistors[key]=persistor;
  }
  const hydrated=await f.main.getAllHydrationData();assert.equal(Object.hasOwn(hydrated,K),false);
  assert.equal(Object.hasOwn(hydrated,K+'###child'),false);assert.equal(calls,0);
  await f.main.insertPersistor('ordinary',persistor);assert.equal(calls,2);
});

integration('baseline hydration exposes the reserved row, while the actual new source refuses before its reader',async t=>{
  const f=await createMainAnchorFixture(t);
  const Previous=execute(prepared(mainStages.slice(0,-1)),'ReduxPersistorIPC',{
    LevelPersist:f.types.LevelPersist,snapshotNativeNewModRegistration:f.types.snapshotNativeNewModRegistration,
    snapshotNativeTrackedModRegistration:f.types.snapshotNativeTrackedModRegistration,structuredClone});
  let reads=0;const source={async getAllKVs(){reads++;return[{key:['rootId'],value:'"own-private"'}];},setResetCallback(){}};
  const old=new Previous(),leaked=await old.insertPersistor(K,source);
  assert.equal(leaked.rootId,'own-private');assert.equal(reads,1);
  await assert.rejects(f.main.insertPersistor(K,source),/ANCHOR_PRIVATE/);assert.equal(reads,1);
});

integration('actual initialized binding requires its genuine ready owner and reads null or canonical detached bytes',async t=>{
  const f=await createBindingFixture(t),before=f.calls.length;
  await assert.rejects(f.wiring.readNativeExecutorHistoryAnchor({}));assert.equal(f.calls.length,before);
  assert.equal(await f.wiring.readNativeExecutorHistoryAnchor(f.mainReadyOwner),null);
  const bytes=anchor();f.committed.set(K,bytes.toString());
  const result=await f.wiring.readNativeExecutorHistoryAnchor(f.mainReadyOwner);
  assert.equal(Buffer.from(result).toString(),bytes.toString());result.fill(0);
  assert.equal(f.committed.get(K),bytes.toString());
});

integration('strict binding captures the reader and refuses replaced initialization ownership without reading',async t=>{
  const f=await createBindingFixture(t);
  f.level.readNativeExecutorAnchor=()=>{throw Error('instance reader replacement must not execute');};
  f.types.LevelPersist.prototype.readNativeExecutorAnchor=()=>{throw Error('prototype reader replacement must not execute');};
  assert.equal(await f.wiring.readNativeExecutorHistoryAnchor(f.mainReadyOwner),null);
  f.wiring.initMainPersistence(f.level);const before=f.calls.length;
  await assert.rejects(f.wiring.readNativeExecutorHistoryAnchor(f.mainReadyOwner));assert.equal(f.calls.length,before);
});

integration('initialization changes during the actual pending Level read cannot return a late null acknowledgement',async t=>{
  const entered=deferred(),gate=deferred();
  const f=await createBindingFixture(t,{async beforeRead(sql){if(sql.includes('AS exact_key')){entered.resolve();await gate.promise;}}});
  const reading=f.wiring.readNativeExecutorHistoryAnchor(f.mainReadyOwner),observed=reading.then(value=>({ok:true,value}),error=>({ok:false,error}));
  await entered.promise;f.wiring.initMainPersistence(f.level);gate.resolve();assert.equal((await observed).ok,false);
});

integration('malformed persisted anchor propagates strict storage failure rather than legacy undefined or empty hydration',async t=>{
  const f=await createBindingFixture(t,{seed:[[K,'{}']]});
  await assert.rejects(f.wiring.readNativeExecutorHistoryAnchor(f.mainReadyOwner),/NATIVE_EXECUTOR_ANCHOR_HOLD/);
});

integration('main high-level reserved aliases never enter legacy catch-and-fallback paths',async t=>{
  const f=await createBindingFixture(t),before=f.calls.length;
  for(const key of [K,K+'###child']) {
    await assert.rejects(f.wiring.registerHive(key),/ANCHOR_PRIVATE/);
    await assert.rejects(f.wiring.readHiveData(key),/ANCHOR_PRIVATE/);
    await assert.rejects(f.wiring.readPersistedValue(key,[]),/ANCHOR_PRIVATE/);
    await assert.rejects(f.wiring.writePersistedValue(key,[],{}),/ANCHOR_PRIVATE/);
  }
  assert.equal(f.calls.length,before);
  f.level.getPersistedHives=async()=>[K,K+'###child','ordinary'];
  assert.deepEqual(Array.from(await f.wiring.getPersistedHives()),['ordinary']);
  assert.equal(Object.hasOwn(await f.wiring.registerAllPersistedHives(),K),false);
});
}
