import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {TextDecoder,types as nativeRegistrationTypes} from 'node:util';
import {repo,prepared,execute,original,stage,sha,parsed,deferred,tick} from './native-query-source-admission.test.mjs';
import {registrationBackend} from './native-owned-mod-registration.test.mjs';
import {createNativeExecutorJournal} from './native-executor-journal.mjs';
import {RELAY_SOURCE_NAMES} from './owned-zip-relay-client.mjs';
const HERE=path.dirname(fileURLToPath(import.meta.url)),K='nativeExecutorAnchorV1';
const levelStages=['new-mod-conflict-query','backend-write-admission','native-backend-sql-admission','native-owned-mod-registration','native-tracked-mod-registration','native-backend-registration-release','native-executor-anchor-storage'];
const mainStages=['batch-acknowledgement','target-reservation','acknowledged-packet','backend-reservation-admission','legacy-rollback-primary','native-main-sql-admission','native-main-mod-registration','native-main-tracked-mod-registration','native-main-registration-release','native-main-executor-anchor','native-main-executor-hold'];
const stages=['native-query-owner-binding','native-main-readiness','native-main-anchor-binding','native-main-executor-startup','native-main-executor-genesis'];
const integration=(name,fn)=>test(name,{timeout:15000,skip:repo?false:'Set VORTEX_EXTENSION_ADMISSION_REPO'},fn);
/** Actual main/Level/Registry/pool source. SQL is an owned transactional facade;
 * Database/watcher/invalidator are initialization-only facades, not host objects. */
export async function createGenesisFixture(t,options={}){
  const base=await registrationBackend(t,{main:true});
  const committed=new Map(),calls=[];let transaction=null,commits=0;
  base.backend.run=async(sql,params)=>{
    calls.push({sql,params:params?structuredClone(params):undefined});await options.beforeRun?.(sql,params);
    if(sql==='BEGIN TRANSACTION'){assert.equal(transaction,null);transaction=new Map(committed);}
    else if(sql==='COMMIT'){assert.ok(transaction);committed.clear();for(const pair of transaction)committed.set(...pair);transaction=null;commits++;}
    else if(sql==='ROLLBACK')transaction=null;
    else if(sql.startsWith('INSERT INTO')){assert.ok(transaction);for(let n=0;n<params.length;n+=2)transaction.set(params[n],params[n+1]);}
    else throw Error('UNSUPPORTED_OWN_WRITE');
    await options.afterRun?.(sql,params);
  };
  base.backend.runAndReadAll=async(sql,params)=>{
    calls.push({sql,params:structuredClone(params)});await options.beforeRead?.(sql,params);
    const data=transaction??committed;let rows;
    if(sql.includes('AS exact_key'))rows=[...data].filter(([key])=>key===K||key.startsWith(K+'###')).slice(0,2)
      .map(([key,value])=>[key===K,typeof value==='string'&&Buffer.byteLength(value)<=1024?Buffer.from(value).toString('hex').toUpperCase():null]);
    else if(sql.includes('SELECT 1 FROM keys'))rows=[];
    else throw Error('UNSUPPORTED_OWN_READ');
    return{getRows:()=>options.rows?options.rows(sql,rows,commits):rows};
  };
  const types=execute(prepared(levelStages),'({LevelPersist,snapshotNativeNewModRegistration,snapshotNativeTrackedModRegistration,snapshotNativeExecutorAnchor,isNativeExecutorAnchorKey})',{
    DuckDBSingleton:base.Singleton,nativeRegistrationHash:crypto.createHash,NativeRegistrationDecoder:TextDecoder,nativeRegistrationTypes,unknownToError:e=>e,log:()=>{}});
  const level=new types.LevelPersist(base.backend,'db');
  const Main=execute(prepared(mainStages),'ReduxPersistorIPC',{...types,structuredClone,unknownToError:e=>e,terminate:e=>{throw e;}});
  const SubPersistor=execute(original('src/main/src/store/SubPersistor.ts').toString(),'SubPersistor');
  const prep=path.resolve(HERE,'../../../local-state/executor-pending-anchor/prep/genesis/cases');fs.mkdirSync(prep,{recursive:true});
  const workspace=fs.mkdtempSync(path.join(prep,'run-')),sdk=path.join(workspace,'tools/modding/vortex-agent');fs.mkdirSync(sdk,{recursive:true});
  const sources={};for(const name of RELAY_SOURCE_NAMES){const bytes=fs.readFileSync(path.join(HERE,name));fs.writeFileSync(path.join(sdk,name),bytes,{flag:'wx'});sources[name]=sha(bytes);}
  for(const relative of ['select/nexus_files.sql','select/profiles.sql','setup/tables.sql']){const file=path.join(workspace,'queries',relative);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,original('src/queries/'+relative),{flag:'wx'});}
  const root=path.join(workspace,'local-state/vortex-agent-build/native-install-executor');fs.mkdirSync(path.dirname(root),{recursive:true});
  if(options.initialized){const receipt=createNativeExecutorJournal({root}).provision();committed.set(K,JSON.stringify(receipt.anchor));}
  const binding={schema:'native-executor-runtime-binding/1',workspaceRoot:workspace.replaceAll('\\','/'),relayNodeSHA256:'5c976096e04e5c2c1f091938926234cc9fbebfe9787ddd149351b3b0ecc707b5',sourceSHA256:sources};
  let loads=0;const actualRequire=createRequire(import.meta.url),loader=file=>{loads++;return options.load?options.load(file,actualRequire):actualRequire(file);};loader.cache=actualRequire.cache;
  const wiring=execute(prepared(stages),`({verifyNativeExecutorStartup,initMainPersistence,waitForNativeMainPersistenceReady,
    checkNativeMainPersistenceReady,initializeNativeExecutorHistory,getMainPersistor,closeMainPersistence})`,{
    ...types,ReduxPersistorIPC:Main,SubPersistor,DuckDBSingleton:base.Singleton,QueryRegistry:base.Registry,
    QueryInvalidator:class{notifyDirtyTables(){}setWatcher(){}},Database:class{},QueryWatcher:class{},
    parseAllQueries:dir=>parsed(dir),getVortexPath:()=>workspace,setupPersistenceIPC(){},getErrorMessageOrDefault:()=>'',
    nativeStartupFS:fs,nativeStartupHash:crypto.createHash,nativeStartupTypes:nativeRegistrationTypes,createRequire:()=>loader,
    __filename:fileURLToPath(import.meta.url),__NEXUS_NATIVE_RUNTIME_BINDING__:binding});
  const startup=await wiring.verifyNativeExecutorStartup(level);
  const mainBackend=options.differentBackend?new types.LevelPersist(base.backend,'db'):level;
  const main=wiring.initMainPersistence(mainBackend),mainOwner=await wiring.waitForNativeMainPersistenceReady();
  main.mPersistors.persistent=new SubPersistor(mainBackend,'persistent');main.mPersistors.settings=new SubPersistor(mainBackend,'settings');
  const owner=await main.reserveNativeModPersistence('game','new');
  return{...base,types,Main,level:mainBackend,selectedBackend:level,main,mainOwner,owner,wiring,committed,calls,workspace,sdk,root,startup,loads:()=>loads,
    initialize:()=>wiring.initializeNativeExecutorHistory(mainOwner,owner)};
}
function held(f){assert.equal(f.main.getNativeModPersistenceReservation().phase,'held');assert.throws(()=>f.main.checkNativeModPersistenceReservation(f.owner));}
function passive(value){assert.equal(value.schema,'native-executor-history-initialization/1');assert(Object.isFrozen(value));assert(Object.isFrozen(value.owner));assert.deepEqual(Object.keys(value.owner),[]);for(const key of ['effectsAllowed','installationPermit','powerLossPersistenceVerified'])assert.equal(value[key],false);}

test('genesis patch binds exact startup and genuine main hold producer without START authority',()=>{
  const {m,patch}=stage('native-main-executor-genesis'),parent=stage('native-main-executor-startup').m,lower=stage('native-main-executor-hold').m;
  assert.equal(sha(patch),m.patchSHA256);assert.equal(m.inputSHA256,parent.outputSHA256);assert.equal(m.prerequisitePatchSHA256,parent.patchSHA256);
  assert.equal(m.requiredCompanionPatchSHA256,lower.patchSHA256);assert.equal(m.requiredCompanionOutputSHA256,lower.outputSHA256);
  for(const key of ['installed','nativeAcceptanceVerified','installationPermit','powerLossPersistenceVerified','startupGateSupported'])assert.equal(m[key],false);
});
integration('actual main genesis commits exact provisioned empty anchor and retains all owners without START',async t=>{
  const f=await createGenesisFixture(t);assert.equal(f.startup.phase,'uninitialized');assert.equal(fs.existsSync(f.root),false);
  const result=await f.initialize();passive(result);assert.equal(f.loads(),1);
  const anchor=JSON.parse(f.committed.get(K));assert.equal(anchor.rootId,result.rootId);assert.equal(anchor.inventorySHA256,result.inventorySHA256);
  assert.deepEqual(fs.readdirSync(f.root),[]);assert.equal(f.calls.filter(c=>c.sql==='COMMIT').length,1);
  f.main.checkNativeModPersistenceReservation(f.owner);f.wiring.checkNativeMainPersistenceReady(f.mainOwner);
  assert.equal(fs.existsSync(path.join(f.workspace,'local-state/owned-zip-worker-work')),false);
});
integration('initialized startup reuses actual retained namespace and journal without require, provision or write',async t=>{
  const f=await createGenesisFixture(t,{initialized:true}),previous=f.committed.get(K),count=f.calls.length;assert.equal(f.loads(),1);
  const result=await f.initialize();passive(result);assert.equal(f.loads(),1);assert.equal(f.committed.get(K),previous);
  assert.equal(f.calls.slice(count).some(c=>['BEGIN TRANSACTION','COMMIT'].includes(c.sql)),false);
});
integration('forged readiness or mod owner refuses before FS without consuming valid initialization',async t=>{
  const f=await createGenesisFixture(t);await assert.rejects(f.wiring.initializeNativeExecutorHistory({},f.owner));
  await assert.rejects(f.wiring.initializeNativeExecutorHistory(f.mainOwner,{}));
  assert.equal(fs.existsSync(f.root),false);assert.equal(f.loads(),0);f.main.checkNativeModPersistenceReservation(f.owner);
  passive(await f.initialize());
});
integration('delayed real CAS keeps root allocated but no returned handle; duplicate cannot replay',async t=>{
  const gate=deferred();const f=await createGenesisFixture(t,{beforeRun:sql=>sql==='COMMIT'?gate.promise:undefined});
  const initializing=f.initialize();let settled=false;initializing.then(()=>{settled=true;},()=>{settled=true;});await tick();
  assert.equal(settled,false);assert.equal(fs.existsSync(f.root),true);assert.equal(f.committed.size,0);
  gate.resolve();passive(await initializing);await assert.rejects(f.initialize());held(f);
  assert.equal(f.calls.filter(c=>c.sql==='COMMIT').length,1);
});
integration('lost real COMMIT acknowledgement preserves anchor/root and holds without rollback or retry',async t=>{
  const primary=Error('own lost reply'),f=await createGenesisFixture(t,{afterRun:sql=>{if(sql==='COMMIT')throw primary;}});
  await assert.rejects(f.initialize(),error=>error===primary);held(f);assert.equal(f.committed.has(K),true);assert.deepEqual(fs.readdirSync(f.root),[]);
  const count=f.calls.length;await assert.rejects(f.initialize());assert.equal(f.calls.length,count);
  assert.equal(f.calls.some(c=>c.sql==='ROLLBACK'),false);
});
integration('actual post-COMMIT readback corruption stays held and preserves journal without rollback',async t=>{
  const f=await createGenesisFixture(t,{rows:(sql,rows,commits)=>commits&&sql.includes('AS exact_key')?[[true,'7B7D']]:rows});
  await assert.rejects(f.initialize());held(f);assert.equal(f.committed.has(K),true);assert.equal(fs.existsSync(f.root),true);
  assert.equal(f.calls.some(c=>c.sql==='ROLLBACK'),false);
});
integration('root appearing after startup and mkdir EEXIST race never adopt or write an anchor',async t=>{
  for(const race of [false,true]){
    const f=await createGenesisFixture(t),original=fs.mkdirSync;let changed=false;
    if(!race){fs.mkdirSync(f.root);fs.writeFileSync(path.join(f.root,'keeper'),'keep',{flag:'wx'});}
    else fs.mkdirSync=function(target,...args){if(path.resolve(target)===f.root&&!changed){changed=true;original.call(fs,target,...args);fs.writeFileSync(path.join(f.root,'keeper'),'keep',{flag:'wx'});}return original.call(fs,target,...args);};
    try{await assert.rejects(f.initialize());}finally{fs.mkdirSync=original;}
    held(f);assert.equal(f.committed.size,0);assert.equal(fs.readFileSync(path.join(f.root,'keeper'),'utf8'),'keep');
  }
});
integration('actual ready backend mismatch from startup refuses before root creation',async t=>{
  const f=await createGenesisFixture(t,{differentBackend:true});
  assert.notEqual(f.level,f.selectedBackend);
  await assert.rejects(f.initialize());assert.equal(fs.existsSync(f.root),false);
});
integration('malformed frozen provision anchor refuses before stringifying caller values',async t=>{
  let callbacks=0;
  const f=await createGenesisFixture(t,{load:(file,require)=>{
    const module=require(file);
    return {...module,createNativeExecutorJournal:options=>{
      const journal=module.createNativeExecutorJournal(options);
      return Object.freeze({...journal,provision:()=>Object.freeze({schema:'native-executor-genesis-observation/1',
        anchor:Object.freeze({schema:'native-executor-anchor/1',rootId:{toJSON(){callbacks++;return'1:2';}},inventorySHA256:'a'.repeat(64)}),
        effectsAllowed:false,installationPermit:false,powerLossPersistenceVerified:false})});
    }};
  }});
  await assert.rejects(f.initialize());held(f);assert.equal(callbacks,0);assert.equal(f.committed.size,0);
});
integration('journal changes during final source closure cannot escape the terminal closed-census check',async t=>{
  const f=await createGenesisFixture(t),original=fs.openSync;let changed=false;
  fs.openSync=function(file,...args){
    if(!changed&&f.committed.has(K)&&String(file).startsWith(f.sdk+path.sep)){
      changed=true;fs.writeFileSync(path.join(f.root,'unknown-late'),'keep',{flag:'wx'});
    }
    return original.call(fs,file,...args);
  };
  try{await assert.rejects(f.initialize());}finally{fs.openSync=original;}
  held(f);assert(changed);assert.equal(f.committed.has(K),true);assert.equal(fs.readFileSync(path.join(f.root,'unknown-late'),'utf8'),'keep');
});
integration('same-owner duplicate during a deferred CAS invalidates both attempts without a second write',async t=>{
  const gate=deferred(),f=await createGenesisFixture(t,{beforeRun:sql=>sql==='COMMIT'?gate.promise:undefined});
  const first=f.initialize();first.catch(()=>{});await tick();
  await assert.rejects(f.initialize());held(f);gate.resolve();await assert.rejects(first);
  assert.equal(f.calls.filter(c=>c.sql==='COMMIT').length,1);
});
