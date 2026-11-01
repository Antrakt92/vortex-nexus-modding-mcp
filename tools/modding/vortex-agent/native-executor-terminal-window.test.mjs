import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { TextDecoder, types as nativeRegistrationTypes } from 'node:util';
import { repo, prepared, execute, parsed, sqlTree, original, stage, sha, deferred, tick } from './native-query-source-admission.test.mjs';
import { trackedRequest } from './native-tracked-mod-registration.test.mjs';

const mainStages=['batch-acknowledgement','target-reservation','acknowledged-packet','backend-reservation-admission','legacy-rollback-primary','native-main-sql-admission','native-main-mod-registration','native-main-tracked-mod-registration','native-main-registration-release','native-main-executor-anchor','native-main-executor-hold','native-main-executor-target','native-main-executor-terminal-window'];
const levelStages=['new-mod-conflict-query','backend-write-admission','native-backend-sql-admission','native-owned-mod-registration','native-tracked-mod-registration','native-backend-registration-release','native-executor-anchor-storage','native-backend-executor-terminal-window'];
const names=['native-query-registration-release','native-sql-registration-release','native-backend-registration-release','native-main-registration-release'];
const seedDownload=(archive)=>['state','game','localPath','size','fileMD5'].map(key=>[`persistent###downloads###files###${archive.id}###${key}`,JSON.stringify(archive[key])]);
export const releaseRequest=(index=1,overrides={})=>trackedRequest({
  operationId:'op_'+String(index).repeat(32),nativeJobId:'exec_'+String(index).repeat(32),requestSHA256:String(index+2).repeat(64),
  modId:index===1?'new':'new'+index,installationPath:index===1?'new':'new'+index,
  archive:{...trackedRequest().archive,id:index===1?'archive':'archive'+index,
    localPath:index===1?'own.zip':'own'+index+'.zip',fileMD5:String(index+5).repeat(32)},...overrides});

// Actual composed classes and one committed database model survive both cycles.
// The SQL model derives every target/archive prefix from the production parameters.
export async function createTerminalFixture(t,{downloads=[releaseRequest(1).archive,releaseRequest(2).archive],before,after,queryPrepare,sqlPrepare,beforeRead,readRows}={}){
  const root=sqlTree(t),committed=new Map(downloads.flatMap(seedDownload)),calls=[];let txn=null,connectionId=0;
  committed.set('nativeExecutorAnchorV1',JSON.stringify({schema:'native-executor-anchor/1',rootId:'1:2',inventorySHA256:'a'.repeat(64)}));
  const data=()=>txn??committed;
  const makeConnection=()=>({id:++connectionId,closed:false,
    async run(sql,params){calls.push({sql,params:params?structuredClone(params):undefined});await before?.(sql,params);
      if(sql==='BEGIN TRANSACTION'){assert.equal(txn,null);txn=new Map(committed);}
      else if(sql.startsWith('INSERT INTO')){const target=txn??committed;for(let i=0;i<params.length;i+=2)target.set(params[i],params[i+1]);}
      else if(sql==='COMMIT'){assert(txn);committed.clear();for(const pair of txn)committed.set(...pair);txn=null;}
      else if(sql==='ROLLBACK')txn=null;
      await after?.(sql,params);
    },
    async runAndReadAll(sql,params=[]){calls.push({sql,params:structuredClone(params)});await beforeRead?.(sql,params);let rows;
      if(sql.includes('AS exact_key')){rows=[...data()].filter(([key])=>key==='nativeExecutorAnchorV1'||key.startsWith('nativeExecutorAnchorV1###')).slice(0,2).map(([key,value])=>[key==='nativeExecutorAnchorV1',typeof value==='string'&&Buffer.byteLength(value)<=1024?Buffer.from(value).toString('hex').toUpperCase():null]);}
      else if(sql.includes('SELECT 1 FROM keys')){
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
      return{getRows:()=>readRows?readRows(sql,rows):rows,getRowObjectsJson:()=>[]};
    },getTableNames(){return[];},closeSync(){this.closed=true;}});
  const Registry=execute(prepared(['native-query-source-admission','native-query-registration-release']),'QueryRegistry');
  if(queryPrepare){const actual=Registry.prototype.prepareNativeQueryRelease;Registry.prototype.prepareNativeQueryRelease=function(...args){queryPrepare(...args);return actual.apply(this,args);};}
  const Singleton=execute(prepared(['native-singleton-sql-admission','native-sql-registration-release']),'DuckDBSingleton',{
    QueryRegistry:Registry,DuckDBInstance:{async create(){return{connect:async()=>makeConnection(),closeSync(){}};}}});
  if(sqlPrepare){const actual=Singleton.prototype.prepareNativeSQLRelease;Singleton.prototype.prepareNativeSQLRelease=function(...args){sqlPrepare();return actual.apply(this,args);};}
  const pool=Singleton.getInstance();await pool.initialize('own reviewed source fixture');const backend=await pool.attachDatabase('own fixture','db');
  const types=execute(prepared(levelStages),'({LevelPersist,snapshotNativeNewModRegistration,snapshotNativeTrackedModRegistration,snapshotNativeExecutorAnchor,isNativeExecutorAnchorKey})',{
    DuckDBSingleton:Singleton,nativeRegistrationHash:createHash,NativeRegistrationDecoder:TextDecoder,nativeRegistrationTypes,unknownToError:e=>e});
  const level=new types.LevelPersist(backend,'db');
  const Main=execute(prepared(mainStages),'ReduxPersistorIPC',{LevelPersist:types.LevelPersist,
    snapshotNativeNewModRegistration:types.snapshotNativeNewModRegistration,snapshotNativeTrackedModRegistration:types.snapshotNativeTrackedModRegistration,
    snapshotNativeExecutorAnchor:types.snapshotNativeExecutorAnchor,isNativeExecutorAnchorKey:types.isNativeExecutorAnchorKey,
    nativeTerminalTypes:nativeRegistrationTypes,Buffer,structuredClone,unknownToError:e=>e,terminate:e=>{throw e;}});
  const SubPersistor=execute(original('src/main/src/store/SubPersistor.ts').toString(),'SubPersistor');
  const queryDir=path.join(root,'queries');fs.mkdirSync(queryDir);for(const dir of['select','setup'])fs.renameSync(path.join(root,dir),path.join(queryDir,dir));
  const wiring=execute(prepared(['native-query-owner-binding','native-main-readiness']),'({initMainPersistence,waitForNativeMainPersistenceReady,registry:()=>queryRegistry})',{
    DuckDBSingleton:Singleton,QueryRegistry:Registry,ReduxPersistorIPC:Main,
    setupPersistenceIPC:main=>{main.mPersistors.persistent=new SubPersistor(level,'persistent');main.mPersistors.settings=new SubPersistor(level,'settings');},
    Database:class{},QueryInvalidator:class{notifyDirtyTables(){}setWatcher(){}},QueryWatcher:class{},getVortexPath:()=>root,
    parseAllQueries:parsed,getErrorMessageOrDefault:()=>''});
  const main=wiring.initMainPersistence(level);await wiring.waitForNativeMainPersistenceReady();
  const registry=wiring.registry();calls.length=0;
  return{root,main,Main,owner:main,level,pool,registry,Registry,Singleton,Level:types.LevelPersist,committed,calls,
    reserve:(gameId,modId)=>main.reserveNativeModPersistence(gameId,modId),
    register:(token,request)=>main.registerNativeTrackedMod(token,Buffer.from(typeof request==='string'?request:JSON.stringify(request))),
    release:token=>main.releaseNativeTrackedMod(token)};
}
const integration=(name,fn)=>test(name,{timeout:15000,skip:repo?false:'Set VORTEX_EXTENSION_ADMISSION_REPO'},fn);
const anchor=(hash='a'.repeat(64),rootId='1:2')=>Buffer.from(JSON.stringify({schema:'native-executor-anchor/1',rootId,inventorySHA256:hash}));
async function committedFixture(t,options={}){
 const f=await createTerminalFixture(t,options),request=releaseRequest(1),modOwner=await f.reserve('game','new'),observed=await f.register(modOwner,request);
 const begin=()=>f.main.beginNativeExecutorTerminalWindow(modOwner,request.operationId,request.nativeJobId,request.requestSHA256,observed.fullRecordSHA256);
 return{...f,request,modOwner,observed,begin};
}
function retained(f){assert.equal(f.main.getNativeModPersistenceReservation().phase,'reserved');assert.equal(f.level.getNativeBackendWriteStatus().phase,'reserved');assert.equal(f.pool.getNativeSQLConnectionStatus().phase,'reserved');}
function held(f,token){assert.throws(()=>f.main.checkNativeExecutorTerminalWindow(token));assert.throws(()=>f.main.releaseNativeExecutorTerminalWindow(token));assert.notEqual(f.pool.getNativeSQLConnectionStatus().phase,'not_reserved');}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
test('terminal window pairs pin exact storage/target prerequisites and source-only authority',()=>{
 for(const[name,parent]of[['native-backend-executor-terminal-window','native-executor-anchor-storage'],['native-main-executor-terminal-window','native-main-executor-target']]){
  const{m,patch}=stage(name),p=stage(parent).m;assert.equal(m.inputSHA256,p.outputSHA256);assert.equal(m.prerequisitePatchSHA256,p.patchSHA256);assert.equal(sha(patch),m.patchSHA256);
  for(const k of ['installed','nativeAcceptanceVerified','installationPermit','effectsAllowed','nativeAdmission','powerLossPersistenceVerified'])assert.equal(m[k],false);
 }
 const m=stage('native-main-executor-terminal-window').m,l=stage('native-backend-executor-terminal-window').m;assert.equal(m.requiredCompanionPatchSHA256,l.patchSHA256);assert.equal(m.requiredCompanionOutputSHA256,l.outputSHA256);
});
integration('genuine committed registration window retains all owners through changed CAS and direct readback before release',async t=>{
 const f=await committedFixture(t),token=f.begin();assert(Object.isFrozen(token));assert.deepEqual(Object.keys(token),[]);f.main.checkNativeExecutorTerminalWindow(token);retained(f);
 assert.deepEqual(Buffer.from(await f.main.readNativeExecutorTerminalAnchor(token)),anchor());
 await assert.rejects(f.level.readNativeExecutorAnchor());await assert.rejects(f.main.writeNativeExecutorAnchor(f.modOwner,anchor(),anchor('b'.repeat(64))));
 assert.throws(()=>f.release(f.modOwner));retained(f);
 const ack=await f.main.writeNativeExecutorTerminalAnchor(token,anchor(),anchor('b'.repeat(64)));assert.equal(ack.commitObserved,true);assert.equal(ack.previousSHA256,sha(anchor()));retained(f);
 assert.throws(()=>f.main.releaseNativeExecutorTerminalWindow(token),/REFUSED/);retained(f);
 assert.deepEqual(Buffer.from(await f.main.readNativeExecutorTerminalAnchor(token)),anchor('b'.repeat(64)));
 const receipt=f.main.releaseNativeExecutorTerminalWindow(token);assert.equal(receipt.fullRecordSHA256,f.observed.fullRecordSHA256);assert.equal(receipt.released,true);
 assert.equal(f.main.getNativeModPersistenceReservation().phase,'not_reserved');assert.equal(f.level.getNativeBackendWriteStatus().phase,'not_reserved');assert.equal(f.pool.getNativeSQLConnectionStatus().phase,'not_reserved');
 await f.main.applyDiffOperationsAcknowledged('settings',[{type:'set',path:['after'],value:7}]);assert.equal(f.committed.get('settings###after'),'7');
 assert.throws(()=>f.main.releaseNativeExecutorTerminalWindow(token));
});
integration('two source cycles keep first record and consumed bindings; stale window cannot release second',async t=>{
 const f=await committedFixture(t),a=f.begin();await f.main.writeNativeExecutorTerminalAnchor(a,anchor(),anchor('b'.repeat(64)));await f.main.readNativeExecutorTerminalAnchor(a);f.main.releaseNativeExecutorTerminalWindow(a);
 const first=[...f.committed].filter(([k])=>k.startsWith('persistent###mods###game###new###'));
 const r=releaseRequest(2),owner=await f.reserve('game','new2'),out=await f.register(owner,r),b=f.main.beginNativeExecutorTerminalWindow(owner,r.operationId,r.nativeJobId,r.requestSHA256,out.fullRecordSHA256);
 assert.throws(()=>f.main.releaseNativeExecutorTerminalWindow(a));f.main.checkNativeExecutorTerminalWindow(b);
 await f.main.writeNativeExecutorTerminalAnchor(b,anchor('b'.repeat(64)),anchor('c'.repeat(64)));await f.main.readNativeExecutorTerminalAnchor(b);f.main.releaseNativeExecutorTerminalWindow(b);
 for(const[k,v]of first)assert.equal(f.committed.get(k),v);assert.equal(f.committed.get('persistent###downloads###files###archive2###installed###modId'),'"new2"');
 assert.deepEqual(Buffer.from(await f.level.readNativeExecutorAnchor()),anchor('c'.repeat(64)));
});
integration('legacy tracked release outside terminal windows preserves existing behavior',async t=>{
 const f=await committedFixture(t);assert.equal(f.release(f.modOwner).released,true);assert.equal(f.pool.getNativeSQLConnectionStatus().phase,'not_reserved');
});
integration('legacy fixed-key anchor path still works before registration with no terminal window',async t=>{
 const f=await createTerminalFixture(t),owner=await f.reserve('game','new');
 const ack=await f.main.writeNativeExecutorAnchor(owner,anchor(),anchor('b'.repeat(64)));assert.equal(ack.commitObserved,true);
 assert.deepEqual(Buffer.from(await f.level.readNativeExecutorAnchor()),anchor('b'.repeat(64)));
 await f.register(owner,releaseRequest(1));assert.equal(f.release(owner).released,true);
});
integration('early or wrong binding begin cannot mint a window or consume genuine later admission',async t=>{
 const f=await createTerminalFixture(t),owner=await f.reserve('game','new'),r=releaseRequest(1);
 assert.throws(()=>f.main.beginNativeExecutorTerminalWindow(owner,r.operationId,r.nativeJobId,r.requestSHA256,'a'.repeat(64)));
 const out=await f.register(owner,r);let coerced=0;const foreign={toString(){coerced++;return r.operationId;}};
 for(const args of [[{},r.operationId,r.nativeJobId,r.requestSHA256,out.fullRecordSHA256],[owner,foreign,r.nativeJobId,r.requestSHA256,out.fullRecordSHA256],[owner,r.operationId,r.nativeJobId,'a'.repeat(64),out.fullRecordSHA256],[owner,r.operationId,r.nativeJobId,r.requestSHA256,'a'.repeat(64)]])assert.throws(()=>f.main.beginNativeExecutorTerminalWindow(...args));
 assert.equal(coerced,0);const token=f.main.beginNativeExecutorTerminalWindow(owner,r.operationId,r.nativeJobId,r.requestSHA256,out.fullRecordSHA256);f.main.checkNativeExecutorTerminalWindow(token);retained(f);
});
integration('wrong token and forged receivers do not poison genuine window or execute SQL',async t=>{
 const f=await committedFixture(t),token=f.begin(),count=f.calls.length;
 for(const fake of [{},Object.freeze({}),structuredClone(token),null]){
  assert.throws(()=>f.main.checkNativeExecutorTerminalWindow(fake));await assert.rejects(f.main.readNativeExecutorTerminalAnchor(fake));
  await assert.rejects(f.main.writeNativeExecutorTerminalAnchor(fake,anchor(),anchor('b'.repeat(64))));assert.throws(()=>f.main.releaseNativeExecutorTerminalWindow(fake));
 }
 for(const receiver of [null,{},Object.create(f.Main.prototype),new Proxy(f.main,{})])assert.throws(()=>f.Main.prototype.checkNativeExecutorTerminalWindow.call(receiver,token));
 assert.equal(f.calls.length,count);f.main.checkNativeExecutorTerminalWindow(token);retained(f);
});
integration('nonnull, same-root and changed-census restrictions refuse before any terminal SQL attempt',async t=>{
 for(const[before,next]of[[null,anchor('b'.repeat(64))],[anchor(),anchor()],[anchor(),anchor('b'.repeat(64),'1:3')]]){
  const f=await committedFixture(t),token=f.begin(),count=f.calls.length;await assert.rejects(f.main.writeNativeExecutorTerminalAnchor(token,before,next));held(f,token);assert.equal(f.calls.length,count);
 }
});
integration('CAS predecessor conflict rolls back and cannot be retried or released',async t=>{
 const f=await committedFixture(t),token=f.begin();await assert.rejects(f.main.writeNativeExecutorTerminalAnchor(token,anchor('c'.repeat(64)),anchor('b'.repeat(64))));held(f,token);
 assert.equal(f.committed.get('nativeExecutorAnchorV1'),anchor().toString());assert.equal(f.calls.filter(c=>c.sql==='ROLLBACK').length,1);const n=f.calls.length;
 await assert.rejects(f.main.writeNativeExecutorTerminalAnchor(token,anchor(),anchor('b'.repeat(64))));assert.equal(f.calls.length,n);
});
integration('terminal COMMIT unknown keeps real written successor held and preserves null/undefined primary',async t=>{
 for(const primary of [null,undefined]){let commits=0;const f=await committedFixture(t,{after:sql=>{if(sql==='COMMIT'&&++commits===2)throw primary;}}),token=f.begin();
  await f.main.writeNativeExecutorTerminalAnchor(token,anchor(),anchor('b'.repeat(64))).then(()=>assert.fail('grant'),e=>assert.equal(e,primary));held(f,token);
  assert.equal(f.committed.get('nativeExecutorAnchorV1'),anchor('b'.repeat(64)).toString());assert.equal(f.calls.some(c=>c.sql==='ROLLBACK'),false);
  const n=f.calls.length;await assert.rejects(f.main.readNativeExecutorTerminalAnchor(token));assert.equal(f.calls.length,n);
 }
});
integration('direct post-CAS readback drift cannot release even after bytes are restored',async t=>{
 const f=await committedFixture(t),token=f.begin();await f.main.writeNativeExecutorTerminalAnchor(token,anchor(),anchor('b'.repeat(64)));
 f.committed.set('nativeExecutorAnchorV1',anchor('c'.repeat(64)).toString());await assert.rejects(f.main.readNativeExecutorTerminalAnchor(token));held(f,token);
 f.committed.set('nativeExecutorAnchorV1',anchor('b'.repeat(64)).toString());held(f,token);
});
integration('stale legacy lower finalizer prepared before window cannot clear its current holds',async t=>{
 const f=await committedFixture(t),r=f.main.mNativeModPersistenceReservation;
 const old=f.level.prepareNativeTrackedRegistrationRelease(r.backendOwner,r.sqlOwner,r.registry),token=f.begin();
 assert.throws(old);retained(f);f.main.checkNativeExecutorTerminalWindow(token);
});
integration('duplicate genuine begin poisons the window instead of returning or refunding a token',async t=>{
 const f=await committedFixture(t),token=f.begin();assert.throws(f.begin);held(f,token);assert.notEqual(f.main.getNativeModPersistenceReservation().phase,'not_reserved');
});
integration('ordinary writer during terminal CAS cannot interleave and poisons the current operation',async t=>{
 const gate=deferred();let commits=0;const f=await committedFixture(t,{before:sql=>sql==='COMMIT'&&++commits===2?gate.promise:undefined}),token=f.begin();
 const writing=f.main.writeNativeExecutorTerminalAnchor(token,anchor(),anchor('b'.repeat(64)));writing.catch(()=>{});await tick();
 assert.equal(f.level.getNativeBackendWriteStatus().activeIntents,1);assert.equal(f.pool.getNativeSQLConnectionStatus().phase,'reserved');
 await assert.rejects(f.main.applyDiffOperationsAcknowledged('settings',[{type:'set',path:['interleave'],value:8}]));gate.resolve();await assert.rejects(writing);held(f,token);
 assert.equal(f.committed.has('settings###interleave'),false);
});
integration('genuine check reentry from a terminal read cannot be swallowed into a valid readback',async t=>{
 let f,token,armed=false,nested;f=await committedFixture(t,{beforeRead:sql=>{if(armed&&sql.includes('AS exact_key')){armed=false;try{f.main.checkNativeExecutorTerminalWindow(token);}catch(e){nested=e;}}}});
 token=f.begin();armed=true;await assert.rejects(f.main.readNativeExecutorTerminalAnchor(token));assert(nested);held(f,token);
});
integration('genuine lower window token checks retain brands and cannot be cloned or borrowed',async t=>{
 const f=await committedFixture(t),r=f.main.mNativeModPersistenceReservation,token=f.level.beginNativeExecutorTerminalWindow(r.backendOwner,r.sqlOwner,r.registry),count=f.calls.length;
 for(const fake of [{},structuredClone(token),null]){
  assert.throws(()=>f.level.checkNativeExecutorTerminalWindow(fake));await assert.rejects(f.level.readNativeExecutorTerminalAnchor(fake));
  await assert.rejects(f.level.writeNativeExecutorTerminalAnchor(fake,anchor(),anchor('b'.repeat(64))));assert.throws(()=>f.level.prepareNativeExecutorTerminalRelease(fake));
 }
 for(const receiver of [null,{},Object.create(f.Level.prototype),new Proxy(f.level,{})])assert.throws(()=>f.Level.prototype.checkNativeExecutorTerminalWindow.call(receiver,token));
 assert.equal(f.calls.length,count);f.level.checkNativeExecutorTerminalWindow(token);retained(f);
});
integration('nested final release during lower preparation keeps all owners closed',async t=>{
 let f,token,armed=false,nested;f=await committedFixture(t,{queryPrepare:()=>{if(armed){armed=false;try{f.main.releaseNativeExecutorTerminalWindow(token);}catch(e){nested=e;}}}});
 token=f.begin();await f.main.writeNativeExecutorTerminalAnchor(token,anchor(),anchor('b'.repeat(64)));await f.main.readNativeExecutorTerminalAnchor(token);
 armed=true;assert.throws(()=>f.main.releaseNativeExecutorTerminalWindow(token));assert(nested);held(f,token);
 assert.equal(f.pool.getNativeSQLConnectionStatus().phase,'reserved');assert.notEqual(f.level.getNativeBackendWriteStatus().phase,'not_reserved');
});
integration('terminal write detaches caller bytes before delayed SQL and refuses a second CAS',async t=>{
 const gate=deferred();let commits=0;const f=await committedFixture(t,{before:sql=>sql==='COMMIT'&&++commits===2?gate.promise:undefined}),token=f.begin(),before=anchor(),next=anchor('b'.repeat(64));
 const writing=f.main.writeNativeExecutorTerminalAnchor(token,before,next);await tick();before.fill(0);next.fill(0);gate.resolve();const ack=await writing;
 assert.equal(ack.anchorSHA256,sha(anchor('b'.repeat(64))));assert.deepEqual(Buffer.from(await f.main.readNativeExecutorTerminalAnchor(token)),anchor('b'.repeat(64)));
 await assert.rejects(f.main.writeNativeExecutorTerminalAnchor(token,anchor('b'.repeat(64)),anchor('c'.repeat(64))));held(f,token);
});
integration('window rejects replacement or mutation of its original committed binding and observed record',async t=>{
 for(const key of ['binding','observed']){
  const f=await committedFixture(t),token=f.begin(),record=f.main.mNativeRegistration,prior=record[key];
  record[key]={...prior};assert.throws(()=>f.main.checkNativeExecutorTerminalWindow(token));record[key]=prior;held(f,token);
 }
 const f=await committedFixture(t),token=f.begin();f.main.mNativeRegistration.binding.requestSHA256='f'.repeat(64);
 assert.throws(()=>f.main.checkNativeExecutorTerminalWindow(token));held(f,token);
});
integration('window refuses observed accessor substitution without executing it',async t=>{
 const f=await committedFixture(t),token=f.begin();let getters=0;
 Object.defineProperty(f.main.mNativeRegistration,'observed',{get(){getters++;throw Error('foreign getter');},configurable:true});
 assert.throws(()=>f.main.checkNativeExecutorTerminalWindow(token));assert.equal(getters,0);held(f,token);assert.equal(getters,0);
});
integration('record drift inside an awaited SQL read cannot certify terminal ownership',async t=>{
 let f,armed=false;f=await committedFixture(t,{beforeRead:sql=>{if(armed&&sql.includes('AS exact_key')){armed=false;f.main.mNativeRegistration.observed=Object.freeze({...f.main.mNativeRegistration.observed,fullRecordSHA256:'f'.repeat(64)});}}});
 const token=f.begin();armed=true;await assert.rejects(f.main.readNativeExecutorTerminalAnchor(token));held(f,token);
});
integration('release cannot acknowledge a different committed record after the terminal CAS',async t=>{
 const f=await committedFixture(t),token=f.begin();await f.main.writeNativeExecutorTerminalAnchor(token,anchor(),anchor('b'.repeat(64)));await f.main.readNativeExecutorTerminalAnchor(token);
 f.main.mNativeRegistration.observed=Object.freeze({...f.main.mNativeRegistration.observed,fullRecordSHA256:'f'.repeat(64)});
 assert.throws(()=>f.main.releaseNativeExecutorTerminalWindow(token));held(f,token);assert.equal(f.pool.getNativeSQLConnectionStatus().phase,'reserved');
});

}
