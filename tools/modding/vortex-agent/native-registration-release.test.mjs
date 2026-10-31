import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { TextDecoder, types as nativeRegistrationTypes } from 'node:util';
import { repo, prepared, execute, parsed, sqlTree, original, stage, sha, deferred, tick } from './native-query-source-admission.test.mjs';
import { trackedRequest } from './native-tracked-mod-registration.test.mjs';

const mainStages=['batch-acknowledgement','target-reservation','acknowledged-packet','backend-reservation-admission','legacy-rollback-primary','native-main-sql-admission','native-main-mod-registration','native-main-tracked-mod-registration','native-main-registration-release'];
const levelStages=['new-mod-conflict-query','backend-write-admission','native-backend-sql-admission','native-owned-mod-registration','native-tracked-mod-registration','native-backend-registration-release'];
const names=['native-query-registration-release','native-sql-registration-release','native-backend-registration-release','native-main-registration-release'];
const seedDownload=(archive)=>['state','game','localPath','size','fileMD5'].map(key=>[`persistent###downloads###files###${archive.id}###${key}`,JSON.stringify(archive[key])]);
export const releaseRequest=(index=1,overrides={})=>trackedRequest({
  operationId:'op_'+String(index).repeat(32),nativeJobId:'exec_'+String(index).repeat(32),requestSHA256:String(index+2).repeat(64),
  modId:index===1?'new':'new'+index,installationPath:index===1?'new':'new'+index,
  archive:{...trackedRequest().archive,id:index===1?'archive':'archive'+index,
    localPath:index===1?'own.zip':'own'+index+'.zip',fileMD5:String(index+5).repeat(32)},...overrides});

// Actual composed classes and one committed database model survive both cycles.
// The SQL model derives every target/archive prefix from the production parameters.
export async function createReleaseFixture(t,{downloads=[releaseRequest(1).archive,releaseRequest(2).archive],before,after,queryPrepare,sqlPrepare}={}){
  const root=sqlTree(t),committed=new Map(downloads.flatMap(seedDownload)),calls=[];let txn=null,connectionId=0;
  const data=()=>txn??committed;
  const makeConnection=()=>({id:++connectionId,closed:false,
    async run(sql,params){calls.push({sql,params:params?structuredClone(params):undefined});await before?.(sql,params);
      if(sql==='BEGIN TRANSACTION'){assert.equal(txn,null);txn=new Map(committed);}
      else if(sql.startsWith('INSERT INTO')){const target=txn??committed;for(let i=0;i<params.length;i+=2)target.set(params[i],params[i+1]);}
      else if(sql==='COMMIT'){assert(txn);committed.clear();for(const pair of txn)committed.set(...pair);txn=null;}
      else if(sql==='ROLLBACK')txn=null;
      await after?.(sql,params);
    },
    async runAndReadAll(sql,params=[]){calls.push({sql,params:structuredClone(params)});let rows;
      if(sql.includes('SELECT 1 FROM keys')){
        const[gamePrefix,targetPrefix,modId]=params;
        rows=[...data().keys()].some(key=>key===''||key==='persistent'||key==='persistent###mods'||key===gamePrefix
          ||key===targetPrefix||key.startsWith(targetPrefix+'###')||key==='persistent###profiles'
          ||(key.startsWith('persistent###profiles###')&&(key.split('###').length===3
             ||(key.split('###')[3]==='modState'&&(key.split('###').length===4||key.split('###')[4]===modId)))))?[[1]]:[];
      }else if(sql.includes('CASE WHEN key IN')){
        const[base,...keys]=params,allowed=new Set(keys);
        rows=[...data()].filter(([key])=>key===base||key==='persistent###downloads'||key==='persistent###downloads###files'
          ||keys.some(k=>key===k||key.startsWith(k+'###'))||key===base+'###installed'||key.startsWith(base+'###installed###'))
          .map(([key,value])=>[key,allowed.has(key)?value:null]).slice(0,8);
      }else if(sql.startsWith('SELECT DISTINCT CASE')){
        rows=[...new Set([...data().keys()].filter(k=>k.startsWith('persistent###downloads###files###')).map(k=>k.split('###')[3]))].map(id=>[id]);
      }else if(sql.includes('length(key)<=512')){
        rows=[...data()].filter(([key])=>{const p=key.split('###');return p[0]==='persistent'&&((p[1]==='mods'&&(p.length<=4||['archiveId','fileMD5'].includes(p[4])||(p[4]==='attributes'&&(p.length===5||p[5]==='fileMD5'))))||(p[1]==='downloads'&&p[2]==='files'&&(p.length<=4||['fileMD5','localPath'].includes(p[4]))));}).slice(0,40001);
      }else if(sql.includes('SELECT key, value FROM keys')){
        const[prefix,gamePrefix,modId,base,...extra]=params,wanted=new Set(extra);
        rows=[...data()].filter(([key])=>key===prefix||key.startsWith(prefix+'###')||key===gamePrefix||['persistent','persistent###mods','persistent###profiles'].includes(key)
          ||(key.startsWith('persistent###profiles###')&&(key.split('###').length===3||(key.split('###')[3]==='modState'&&(key.split('###').length===4||key.split('###')[4]===modId))))
          ||wanted.has(key)||(base!==undefined&&(key===base||key===base+'###installed'||key.startsWith(base+'###installed###'))));
      }else rows=[];
      return{getRows:()=>rows,getRowObjectsJson:()=>[]};
    },getTableNames(){return[];},closeSync(){this.closed=true;}});
  const Registry=execute(prepared(['native-query-source-admission','native-query-registration-release']),'QueryRegistry');
  if(queryPrepare){const actual=Registry.prototype.prepareNativeQueryRelease;Registry.prototype.prepareNativeQueryRelease=function(...args){queryPrepare(...args);return actual.apply(this,args);};}
  const Singleton=execute(prepared(['native-singleton-sql-admission','native-sql-registration-release']),'DuckDBSingleton',{
    QueryRegistry:Registry,DuckDBInstance:{async create(){return{connect:async()=>makeConnection(),closeSync(){}};}}});
  if(sqlPrepare){const actual=Singleton.prototype.prepareNativeSQLRelease;Singleton.prototype.prepareNativeSQLRelease=function(...args){sqlPrepare();return actual.apply(this,args);};}
  const pool=Singleton.getInstance();await pool.initialize('own reviewed source fixture');const backend=await pool.attachDatabase('own fixture','db');
  const types=execute(prepared(levelStages),'({LevelPersist,snapshotNativeNewModRegistration,snapshotNativeTrackedModRegistration})',{
    DuckDBSingleton:Singleton,nativeRegistrationHash:createHash,NativeRegistrationDecoder:TextDecoder,nativeRegistrationTypes,unknownToError:e=>e});
  const level=new types.LevelPersist(backend,'db');
  const Main=execute(prepared(mainStages),'ReduxPersistorIPC',{LevelPersist:types.LevelPersist,
    snapshotNativeNewModRegistration:types.snapshotNativeNewModRegistration,snapshotNativeTrackedModRegistration:types.snapshotNativeTrackedModRegistration,
    Buffer,structuredClone,unknownToError:e=>e,terminate:e=>{throw e;}});
  const SubPersistor=execute(original('src/main/src/store/SubPersistor.ts').toString(),'SubPersistor');
  const queryDir=path.join(root,'queries');fs.mkdirSync(queryDir);for(const dir of['select','setup'])fs.renameSync(path.join(root,dir),path.join(queryDir,dir));
  const wiring=execute(prepared(['native-query-owner-binding','native-main-readiness']),'({initMainPersistence,waitForNativeMainPersistenceReady,registry:()=>queryRegistry})',{
    DuckDBSingleton:Singleton,QueryRegistry:Registry,ReduxPersistorIPC:Main,
    setupPersistenceIPC:main=>{main.mPersistors.persistent=new SubPersistor(level,'persistent');main.mPersistors.settings=new SubPersistor(level,'settings');},
    Database:class{},QueryInvalidator:class{notifyDirtyTables(){}setWatcher(){}},QueryWatcher:class{},getVortexPath:()=>root,
    parseAllQueries:parsed,getErrorMessageOrDefault:()=>''});
  const main=wiring.initMainPersistence(level);await wiring.waitForNativeMainPersistenceReady();
  const registry=wiring.registry();calls.length=0;
  return{root,main,owner:main,level,pool,registry,Registry,Singleton,Level:types.LevelPersist,committed,calls,
    reserve:(gameId,modId)=>main.reserveNativeModPersistence(gameId,modId),
    register:(token,request)=>main.registerNativeTrackedMod(token,Buffer.from(typeof request==='string'?request:JSON.stringify(request))),
    release:token=>main.releaseNativeTrackedMod(token)};
}
const integration=(name,fn)=>test(name,{timeout:10000,skip:repo?false:'Set VORTEX_EXTENSION_ADMISSION_REPO'},fn);
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
test('four release artifacts retain exact companion chain and no durable/installed permit',()=>{
  for(let i=0;i<names.length;i++){const{m,patch}=stage(names[i]);assert.equal(sha(patch),m.patchSHA256);
    for(const k of['installed','nativeAcceptanceVerified','installationPermit','powerLossPersistenceVerified','trackedInstallComplete','durableConsumedIDsVerified'])assert.equal(m[k],false);
    if(i){const child=stage(names[i-1]).m;assert.equal(m.requiredCompanionPatchSHA256,child.patchSHA256);assert.equal(m.requiredCompanionOutputSHA256,child.outputSHA256);}}
});
integration('same actual main/backend/pool/registry release and register two different targets without losing first',async t=>{
  const f=await createReleaseFixture(t),first=releaseRequest(1),second=releaseRequest(2),initial=f.committed.size;
  const a=await f.reserve('game','new'),one=await f.register(a,first),firstRows=[...f.committed].filter(([k])=>k.startsWith('persistent###mods###game###new###'));
  const receipt=f.release(a);assert.equal(receipt.released,true);assert.equal(receipt.fullRecordSHA256,one.fullRecordSHA256);
  assert.equal(f.main.getNativeModPersistenceReservation().phase,'not_reserved');assert.equal(f.level.getNativeBackendWriteStatus().phase,'not_reserved');assert.equal(f.pool.getNativeSQLConnectionStatus().phase,'not_reserved');
  await f.main.applyDiffOperationsAcknowledged('settings',[{type:'set',path:['ordinary'],value:'between'}]);
  const b=await f.reserve('game','new2'),two=await f.register(b,second);f.release(b);
  assert.equal(two.schema,'native-tracked-mod-registration-observed/2');assert.equal(f.committed.size,initial+16+1);
  for(const[k,v]of firstRows)assert.equal(f.committed.get(k),v);
  assert.equal(f.committed.get('persistent###downloads###files###archive2###installed###modId'),'"new2"');
  assert.equal(f.committed.get('settings###ordinary'),'"between"');
  assert.throws(()=>f.release(a),/REFUSED/);assert.throws(()=>f.release(b),/REFUSED/);
});
integration('old release/query/SQL/backend owners cannot clear a second fresh reservation',async t=>{
  const f=await createReleaseFixture(t),a=await f.reserve('game','new');await f.register(a,releaseRequest(1));
  const r=f.main.mNativeModPersistenceReservation;
  const old=f.level.prepareNativeTrackedRegistrationRelease(r.backendOwner,r.sqlOwner,r.registry);f.release(a);
  const b=await f.reserve('game','new2');assert.throws(old,/REFUSED/);assert.throws(()=>f.release(a),/REFUSED/);
  f.main.checkNativeModPersistenceReservation(b);await f.register(b,releaseRequest(2));f.release(b);
});
integration('consumed operation/job/request bindings reject reuse across different targets under new owner',async t=>{
  for(const field of['operationId','nativeJobId','requestSHA256']){
    const f=await createReleaseFixture(t),one=releaseRequest(1),a=await f.reserve('game','new');await f.register(a,one);f.release(a);
    const b=await f.reserve('game','new2'),two=releaseRequest(2,{[field]:one[field]});await assert.rejects(f.register(b,two),/CONSUMED/);
    assert.throws(()=>f.release(b),/REFUSED/);assert.equal(f.committed.has('persistent###mods###game###new2###id'),false);
  }
});
integration('release rejects early active unknown-commit and legacy v1 attempts',async t=>{
  const d=deferred(),active=await createReleaseFixture(t,{before:sql=>sql==='COMMIT'?d.promise:undefined}),a=await active.reserve('game','new'),write=active.register(a,releaseRequest(1));
  await tick();assert.throws(()=>active.release(a),/REFUSED/);d.resolve();await write;active.release(a);
  const primary=Error('lost'),unknown=await createReleaseFixture(t,{after:sql=>{if(sql==='COMMIT')throw primary;}}),b=await unknown.reserve('game','new');
  await assert.rejects(unknown.register(b,releaseRequest(1)),e=>e===primary);assert.throws(()=>unknown.release(b),/REFUSED/);
  assert.equal(unknown.pool.getNativeSQLConnectionStatus().phase,'reserved');assert.equal(unknown.level.getNativeBackendWriteStatus().phase,'held');
  const legacy=await createReleaseFixture(t),c=await legacy.reserve('game','new');const v1={...releaseRequest(1),schema:'native-new-mod-registration-request/1',archiveId:null};delete v1.archive;
  await legacy.main.registerNativeNewMod(c,Buffer.from(JSON.stringify(v1)));assert.throws(()=>legacy.release(c),/REFUSED/);
});
integration('poison after a prepared backend finalizer leaves all layers held; no stale refund',async t=>{
  const f=await createReleaseFixture(t),a=await f.reserve('game','new');await f.register(a,releaseRequest(1));
  const r=f.main.mNativeModPersistenceReservation,finish=f.level.prepareNativeTrackedRegistrationRelease(r.backendOwner,r.sqlOwner,r.registry);
  await assert.rejects(f.level.setItem(['ordinary'],'"bad"'));assert.throws(finish,/REFUSED/);
  assert.equal(f.pool.getNativeSQLConnectionStatus().phase,'reserved');assert.equal(f.main.getNativeModPersistenceReservation().phase,'reserved');
  assert.throws(()=>f.release(a));assert.equal(f.main.getNativeModPersistenceReservation().phase,'held');
});
integration('callback reentry during prepare cannot open main or any lower layer',async t=>{
  let f,armed=false,blocked;f=await createReleaseFixture(t,{queryPrepare(){if(armed){armed=false;blocked=f.main.applyDiffOperationsAcknowledged('settings',[{type:'set',path:['reentrant'],value:'bad'}]);}}});
  const a=await f.reserve('game','new');await f.register(a,releaseRequest(1));armed=true;assert.throws(()=>f.release(a));
  await assert.rejects(blocked);assert.equal(f.committed.has('settings###reentrant'),false);
  assert.equal(f.pool.getNativeSQLConnectionStatus().phase,'reserved');assert.equal(f.level.getNativeBackendWriteStatus().phase,'reserved');
  assert.equal(f.main.getNativeModPersistenceReservation().phase,'held');
});
integration('reentrant release cannot finalize an inner attempt while the outer preparation is active',async t=>{
  let f,armed=false,nested;f=await createReleaseFixture(t,{queryPrepare(){if(armed){armed=false;try{f.release(token);}catch(e){nested=e;}}}});
  const token=await f.reserve('game','new');await f.register(token,releaseRequest(1));armed=true;
  assert.throws(()=>f.release(token));assert(nested);
  assert.equal(f.main.getNativeModPersistenceReservation().phase,'held');
  assert.equal(f.pool.getNativeSQLConnectionStatus().phase,'reserved');assert.equal(f.level.getNativeBackendWriteStatus().phase,'reserved');
});
integration('old query and SQL finalizers cannot revoke the next owner; repeated finalization refuses',async t=>{
  let captured;const f=await createReleaseFixture(t,{queryPrepare(owner,connection){captured={owner,connection};}});
  const a=await f.reserve('game','new');await f.register(a,releaseRequest(1));
  const r=f.main.mNativeModPersistenceReservation;
  const finishSQL=f.pool.prepareNativeSQLRelease(r.sqlOwner);
  const finishQuery=f.registry.prepareNativeQueryRelease(captured.owner,captured.connection);
  f.release(a);
  assert.throws(finishSQL,/REFUSED/);assert.throws(finishQuery,/REFUSED/);
  const b=await f.reserve('game','new2');assert.throws(finishSQL,/REFUSED/);assert.throws(finishQuery,/REFUSED/);
  f.main.checkNativeModPersistenceReservation(b);await f.register(b,releaseRequest(2));f.release(b);
});
integration('query invalidation after prepare prevents every opener in the nested cascade',async t=>{
  const f=await createReleaseFixture(t),a=await f.reserve('game','new');await f.register(a,releaseRequest(1));
  const r=f.main.mNativeModPersistenceReservation,finish=f.level.prepareNativeTrackedRegistrationRelease(r.backendOwner,r.sqlOwner,r.registry);
  await assert.rejects(f.registry.initialize([],f.root),/HELD/);assert.throws(finish,/REFUSED/);
  assert.equal(f.pool.getNativeSQLConnectionStatus().phase,'reserved');assert.equal(f.level.getNativeBackendWriteStatus().phase,'reserved');
  assert.equal(f.main.getNativeModPersistenceReservation().phase,'reserved');
});
integration('backend consumed binding defense survives release even if main entry is bypassed internally',async t=>{
  const f=await createReleaseFixture(t),one=releaseRequest(1),a=await f.reserve('game','new');await f.register(a,one);f.release(a);
  await f.reserve('game','new2');const r=f.main.mNativeModPersistenceReservation;
  const before=f.calls.filter(c=>c.sql==='BEGIN TRANSACTION').length;
  await assert.rejects(f.level.registerNativeTrackedMod(r.backendOwner,r.sqlOwner,r.registry,Buffer.from(JSON.stringify(releaseRequest(2,{operationId:one.operationId})))),/CONSUMED/);
  assert.equal(f.calls.filter(c=>c.sql==='BEGIN TRANSACTION').length,before);
});
integration('fixed release tail does not call logging, query IO, ordinary writer or callback after first opener',async t=>{
  const f=await createReleaseFixture(t),a=await f.reserve('game','new');await f.register(a,releaseRequest(1));
  const before=f.calls.length;const receipt=f.release(a);assert.equal(f.calls.length,before);assert.equal(receipt.installationPermit,false);
  assert.equal(f.pool.getNativeSQLConnectionStatus().issuedConnections,2);
});
integration('nonwritable main fields refuse before any lower owner opens',async t=>{
  for(const field of['mNativeRegistration','mNativeModPersistenceReservation']){
    const f=await createReleaseFixture(t),a=await f.reserve('game','new');await f.register(a,releaseRequest(1));
    Object.defineProperty(f.main,field,{writable:false});assert.throws(()=>f.release(a));
    assert.equal(f.pool.getNativeSQLConnectionStatus().phase,'reserved');assert.equal(f.level.getNativeBackendWriteStatus().phase,'reserved');
  }
});
}
