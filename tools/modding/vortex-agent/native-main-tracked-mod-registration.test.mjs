import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {repo,prepared,execute,parsed,deferred,tick} from './native-query-source-admission.test.mjs';
import {registrationBytes} from './native-owned-mod-registration.test.mjs';
import {trackedBackend,trackedBytes} from './native-tracked-mod-registration.test.mjs';
const names=['batch-acknowledgement','target-reservation','acknowledged-packet','backend-reservation-admission','legacy-rollback-primary','native-main-sql-admission','native-main-mod-registration','native-main-tracked-mod-registration'];
async function fixture(t,options={}){
  const f=await trackedBackend(t,{...options,main:true});
  const Main=execute(prepared(names),'ReduxPersistorIPC',{LevelPersist:f.LevelPersist,
    snapshotNativeNewModRegistration:f.snapshotNativeNewModRegistration,
    snapshotNativeTrackedModRegistration:bytes=>{options.parse?.();return f.snapshotNativeTrackedModRegistration(bytes);},
    Buffer,structuredClone,unknownToError:e=>e,terminate:e=>{throw e;}});
  const queryDir=path.join(f.root,'queries');fs.mkdirSync(queryDir);for(const dir of ['select','setup'])fs.renameSync(path.join(f.root,dir),path.join(queryDir,dir));
  const wiring=execute(prepared(['native-query-owner-binding','native-main-readiness']),'({initMainPersistence,waitForNativeMainPersistenceReady})',{
    DuckDBSingleton:f.Singleton,QueryRegistry:f.Registry,ReduxPersistorIPC:Main,
    setupPersistenceIPC:main=>{main.mPersistors.persistent=f.level;main.mPersistors.settings=f.level;},Database:class{},
    QueryInvalidator:class{notifyDirtyTables(){assert.fail('held notification');}setWatcher(){}},QueryWatcher:class{},
    getVortexPath:()=>f.root,parseAllQueries:parsed,getErrorMessageOrDefault:()=>''});
  const owner=wiring.initMainPersistence(f.level);await wiring.waitForNativeMainPersistenceReady();
  const token=await owner.reserveNativeModPersistence('game','new');f.calls.length=0;
  return{...f,owner,token,register:bytes=>owner.registerNativeTrackedMod(token,bytes??trackedBytes())};
}
const integration=(name,fn)=>test(name,{timeout:10000,skip:repo?false:'Set VORTEX_EXTENSION_ADMISSION_REPO'},fn);
integration('actual main initialization/reservation joins tracked eight-row transaction and exact response',async t=>{
  const f=await fixture(t),result=await f.register();assert.equal(result.trackedAssociationVerified,true);assert.equal(f.committed.size,13);
  assert.equal(f.owner.getNativeModPersistenceReservation().registrationPhase,'committed');
  f.owner.checkNativeNewModRegistration(f.token);await assert.rejects(f.register(),/REFUSED/);
});
integration('wrong main owner refuses without consuming real owner, bad target consumes actual attempt',async t=>{
  const f=await fixture(t);await assert.rejects(f.owner.registerNativeTrackedMod({},trackedBytes()),/REFUSED/);await f.register();
  const g=await fixture(t);await assert.rejects(g.register(trackedBytes({modId:'other',installationPath:'other'})),/TARGET/);
  assert.equal(g.calls.length,0);assert.equal(g.owner.getNativeModPersistenceReservation().phase,'held');
});
integration('main claims one-shot before parser reentry and detaches both nested descriptor and bytes',async t=>{
  let f,armed=false,nested;f=await fixture(t,{parse(){if(armed){armed=false;nested=f.register();}}});armed=true;
  const bytes=trackedBytes(),write=f.register(bytes);bytes.fill(0);await assert.rejects(nested,/REFUSED/);
  assert.equal((await write).requestSHA256,'3'.repeat(64));assert.equal(f.calls.filter(c=>c.sql==='COMMIT').length,1);
});
integration('main captures actual tracked writer against instance and later prototype shadow',async t=>{
  const f=await fixture(t);f.level.registerNativeTrackedMod=async()=>assert.fail('own shadow');
  f.LevelPersist.prototype.registerNativeTrackedMod=async()=>assert.fail('prototype shadow');await f.register();assert.equal(f.committed.size,13);
});
integration('main preserves source conflict and deferred rollback before returning held',async t=>{
  const d=deferred(),f=await fixture(t,{seed:[],before:sql=>sql==='ROLLBACK'?d.promise:undefined});let done=false;
  const write=f.register();write.catch(()=>{done=true;});await tick();assert.equal(done,false);d.resolve();await assert.rejects(write,/ARCHIVE_CONFLICT/);
  assert.equal(f.owner.getNativeModPersistenceReservation().phase,'held');assert.equal(f.committed.size,0);
});
integration('main read checker permits active progress but ordinary packet poisons late completion',async t=>{
  const d=deferred(),f=await fixture(t,{before:sql=>sql==='COMMIT'?d.promise:undefined}),write=f.register();await tick();
  f.owner.checkNativeNewModRegistration(f.token);await assert.rejects(f.owner.applyDiffOperationsAcknowledged('settings',[{type:'set',path:['own'],value:'bad'}]));
  d.resolve();await assert.rejects(write);assert.equal(f.committed.size,13);assert.equal(f.owner.getNativeModPersistenceReservation().phase,'held');
});
integration('lost COMMIT acknowledgement stays held with both associations; no rollback/replay',async t=>{
  const primary=Error('lost'),f=await fixture(t,{after:sql=>{if(sql==='COMMIT')throw primary;}});
  await assert.rejects(f.register(),e=>e===primary);assert.equal(f.committed.size,13);assert.equal(f.calls.some(c=>c.sql==='ROLLBACK'),false);
  await assert.rejects(f.register(),/REFUSED/);assert.equal(f.calls.filter(c=>c.sql==='COMMIT').length,1);
});
integration('shared main and Level private runners preserve legacy v1 null response and five-row write',async t=>{
  const f=await fixture(t),result=await f.owner.registerNativeNewMod(f.token,registrationBytes());
  assert.equal(result.schema,'native-new-mod-registration-observed/1');assert.equal(Object.hasOwn(result,'recordJSON'),false);
  assert.equal(Object.hasOwn(result,'trackedAssociationVerified'),false);assert.equal(f.committed.size,10);
  assert.equal(f.calls.find(c=>c.sql.startsWith('INSERT')).params.length,10);
});
