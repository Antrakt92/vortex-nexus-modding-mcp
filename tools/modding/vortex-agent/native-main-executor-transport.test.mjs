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
import job from './install-job-contract.cjs';
import dispatch from './native-dispatch-contract.cjs';
import {frameFixture} from './native-executor-frame-owner.test.mjs';
const HERE=path.dirname(fileURLToPath(import.meta.url)),K='nativeExecutorAnchorV1';
const levelStages=['new-mod-conflict-query','backend-write-admission','native-backend-sql-admission','native-owned-mod-registration','native-tracked-mod-registration','native-backend-registration-release','native-executor-anchor-storage','native-backend-executor-terminal-window'];
const mainStages=['batch-acknowledgement','target-reservation','acknowledged-packet','backend-reservation-admission','legacy-rollback-primary','native-main-sql-admission','native-main-mod-registration','native-main-tracked-mod-registration','native-main-registration-release','native-main-executor-anchor','native-main-executor-hold','native-main-executor-target','native-main-executor-terminal-window'];
const stages=['native-query-owner-binding','native-main-readiness','native-main-anchor-binding','native-main-executor-startup','native-main-executor-genesis','native-main-executor-pending','native-main-executor-transport'];
const integration=(name,fn)=>test(name,{timeout:15000,skip:repo?false:'Set VORTEX_EXTENSION_ADMISSION_REPO'},fn);
/** Actual main/Level/Registry/pool source. SQL is an owned transactional facade;
 * Database/watcher/invalidator are initialization-only facades, not host objects. */
export async function createTransportMainFixture(t,options={}){
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
  const Main=execute(prepared(mainStages),'ReduxPersistorIPC',{...types,nativeTerminalTypes:nativeRegistrationTypes,structuredClone,unknownToError:e=>e,terminate:e=>{throw e;}});
  const SubPersistor=execute(original('src/main/src/store/SubPersistor.ts').toString(),'SubPersistor');
  const prep=path.resolve(HERE,'../../../local-state/renderer-executor-transport/recovery/main/cases');fs.mkdirSync(prep,{recursive:true});
  const workspace=fs.mkdtempSync(path.join(prep,'run-')),sdk=path.join(workspace,'tools/modding/vortex-agent');fs.mkdirSync(sdk,{recursive:true});
  const sources={};for(const name of RELAY_SOURCE_NAMES){const bytes=fs.readFileSync(path.join(HERE,name));fs.writeFileSync(path.join(sdk,name),bytes,{flag:'wx'});sources[name]=sha(bytes);}
  for(const relative of ['select/nexus_files.sql','select/profiles.sql','setup/tables.sql']){const file=path.join(workspace,'queries',relative);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,original('src/queries/'+relative),{flag:'wx'});}
  const root=path.join(workspace,'local-state/vortex-agent-build/native-install-executor');fs.mkdirSync(path.dirname(root),{recursive:true});
  if(options.initialized){const receipt=createNativeExecutorJournal({root}).provision();committed.set(K,JSON.stringify(receipt.anchor));}
  options.seed?.({root,workspace,committed});
  const binding={schema:'native-executor-runtime-binding/1',workspaceRoot:workspace.replaceAll('\\','/'),relayNodeSHA256:'5c976096e04e5c2c1f091938926234cc9fbebfe9787ddd149351b3b0ecc707b5',sourceSHA256:sources};
  let loads=0,frame,relayCreated=0,prepareCalls=0,startCalls=0;const actualRequire=createRequire(import.meta.url);
  const transport=[];
  const loader=file=>{
    loads++;const module=options.load?options.load(file,actualRequire):actualRequire(file);
    if(options.realRelay||!file.endsWith('owned-zip-relay-client.mjs'))return module;
    return {...module,createBoundOwnedZipRelay(requestBytes,archiveBytes,runtimeBytes){
      relayCreated++;const request=dispatch.parseDispatchRequest(requestBytes),binding={operationId:request.operationId,nativeJobId:request.nativeJobId,
        requestSHA256:dispatch.dispatchRequestDigest(requestBytes),rendererGeneration:request.rendererGeneration};
      assert.equal(JSON.parse(runtimeBytes).workspaceRoot,workspace.replaceAll('\\','/'));
      const owner=Object.freeze({async prepare(anchorBytes){
        prepareCalls++;await options.beforePrepare?.();
        const journal=actualRequire(path.join(sdk,'native-executor-journal.mjs')).createNativeExecutorJournal({root});
        const workerLifetime='worker_'+'4'.repeat(32),packetSHA256='5'.repeat(64);
        const pending=journal.reservePending(requestBytes,workerLifetime,packetSHA256,anchorBytes);
        const receipt={schema:'owned-zip-worker-prepared/1',binding,workerLifetime,workerPid:4321,creationTime:'12345',packetSHA256,transition:pending.transition};
        transport.push({journal,pending,receipt});await options.afterPrepare?.({journal,pending,receipt});
        return options.receipt?options.receipt(receipt):receipt;
      },startPrepared(){startCalls++;throw Error('START forbidden in source fixture');}});
      return owner;
    }};
  };loader.cache=actualRequire.cache;
  const wiring=execute(prepared(stages),`({verifyNativeExecutorStartup,initMainPersistence,waitForNativeMainPersistenceReady,
    checkNativeMainPersistenceReady,initializeNativeExecutorHistory,prepareNativeExecutorPending,getMainPersistor,closeMainPersistence,
    testOnlyPendingRelay:()=>nativePendingAttempt?.relay,
    preflightNativeExecutorTransport,getNativeExecutorTransportBinding,checkNativeExecutorTransport,holdNativeExecutorTransport,
    reserveNativeExecutorTransport,prepareNativeExecutorTransportPending})`,{
    ...types,ReduxPersistorIPC:Main,SubPersistor,
    checkNativeExecutorFrame:owner=>options.frameAPI?options.frameAPI.checkNativeExecutorFrame(owner):frame.check(owner),
    holdNativeExecutorFrame:owner=>options.frameAPI?options.frameAPI.holdNativeExecutorFrame(owner):frame.hold(owner),DuckDBSingleton:base.Singleton,QueryRegistry:base.Registry,
    QueryInvalidator:class{notifyDirtyTables(){}setWatcher(){}},Database:class{},QueryWatcher:class{},
    parseAllQueries:dir=>parsed(dir),getVortexPath:()=>workspace,setupPersistenceIPC(){},getErrorMessageOrDefault:()=>'',
    nativeStartupFS:options.nativeFS??fs,nativeStartupHash:crypto.createHash,nativeStartupTypes:nativeRegistrationTypes,createRequire:()=>loader,
    __filename:fileURLToPath(import.meta.url),__NEXUS_NATIVE_RUNTIME_BINDING__:binding});
  const startup=await wiring.verifyNativeExecutorStartup(level);
  const mainBackend=options.differentBackend?new types.LevelPersist(base.backend,'db'):level;
  const main=wiring.initMainPersistence(mainBackend),mainOwner=await wiring.waitForNativeMainPersistenceReady();
  main.mPersistors.persistent=new SubPersistor(mainBackend,'persistent');main.mPersistors.settings=new SubPersistor(mainBackend,'settings');
  const owner=undefined;
  frame=frameFixture({setup:false});frame.state.current=main;frame.api.setupPersistenceIPC(main);const frameOwner=frame.reserve();
  const h='a'.repeat(64),plan={schema:'install-job-plan/1',family:'tracked-new-disabled',contractId:job.CONTRACT_ID,
    context:{gameId:'cyberpunk2077',profileId:'pending-fixture',gamePath:path.join(workspace,'game'),stagingPath:path.join(workspace,'stage'),downloadPath:path.join(workspace,'downloads'),filesystemIds:{gamePath:'1:1',stagingPath:'1:2',downloadPath:'1:3'}},
    package:{downloadId:'own-download',fileName:'own.zip',expectedModId:'own',expectedType:'',bytes:32,sha256:h,md5:'b'.repeat(32),expectedUncompressedBytes:1,payload:{'a.txt':h}},
    evidence:{buildSHA256:h,sourceSHA256:h,nativeAdmissionSHA256:h},options:{enabled:false,deploy:false}};
  const request={schema:'native-dispatch-request/1',contractId:dispatch.CONTRACT_ID,operationId:'op_'+'1'.repeat(32),nativeJobId:'exec_'+'2'.repeat(32),
    planId:job.installPlanId(plan),managerScope:'manager-pending-fixture-1',rendererGeneration:'renderer_'+'3'.repeat(32),admissionSHA256:h,plan};
  const identity={schema:'win-file-id128/1',volumeSerialNumber:'1',fileId:'2'};
  const archive={parent:plan.context.downloadPath,parentIdentity:identity,identity:{...identity,fileId:'3'},leaf:'own.zip',bytes:32,sha256:h};
  options.configureInputs?.({request,archive,workspace});request.planId=job.installPlanId(request.plan);
  const requestBytes=Buffer.from(JSON.stringify(request)),archiveBytes=Buffer.from(JSON.stringify(archive));
  const mainAPI=Object.freeze(Object.fromEntries(['preflightNativeExecutorTransport','getNativeExecutorTransportBinding','checkNativeExecutorTransport','holdNativeExecutorTransport','reserveNativeExecutorTransport','prepareNativeExecutorTransportPending'].map(name=>[name,wiring[name]])));
  const mainReadyContext=Object.freeze({waitForNativeMainPersistenceReady:wiring.waitForNativeMainPersistenceReady,checkNativeMainPersistenceReady:wiring.checkNativeMainPersistenceReady,getMainPersistor:wiring.getMainPersistor});
  return{mainAPI,mainReadyContext,frame,frameOwner,request,archive,requestBytes,archiveBytes,transport,counts:()=>({relayCreated,prepareCalls,startCalls}),...base,types,Main,level:mainBackend,selectedBackend:level,main,mainOwner,wiring,committed,calls,workspace,sdk,root,startup,loads:()=>loads,
    preflight:(r=requestBytes,a=archiveBytes)=>wiring.preflightNativeExecutorTransport(mainOwner,r,a)};
}
export const createMainTransportFixture=createTransportMainFixture;

const bytes=value=>Buffer.from(JSON.stringify(value));
function sourceOnly(f){assert.equal(fs.existsSync(f.root),false);assert.equal(f.committed.size,0);assert.equal(f.counts().relayCreated,0);assert.equal(f.counts().startCalls,0);}
function stopped(f,ticket){assert.throws(()=>f.wiring.checkNativeExecutorTransport(ticket));assert.equal(f.counts().startCalls,0);}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
test('Main transport artifact pins exact pending parent and actual current Main terminal companion',()=>{
 const{m,patch}=stage('native-main-executor-transport'),p=stage('native-main-executor-pending').m,c=stage('native-main-executor-terminal-window').m;
 assert.equal(sha(patch),m.patchSHA256);assert.equal(m.inputSHA256,p.outputSHA256);assert.equal(m.prerequisitePatchSHA256,p.patchSHA256);
 assert.equal(m.requiredCompanionPatchSHA256,c.patchSHA256);assert.equal(m.requiredCompanionOutputSHA256,c.outputSHA256);
 const shared=stage('native-executor-transport-shared-ipc').m;assert.deepEqual(m.additionalCompanions,[{packet:'persistence',name:'native-executor-transport-shared-ipc',patchSHA256:shared.patchSHA256,outputSHA256:shared.outputSHA256}]);
 for(const k of ['installed','nativeAcceptanceVerified','installationPermit','effectsAllowed','nativeAdmission','powerLossPersistenceVerified'])assert.equal(m[k],false);
});
integration('actual SDK preflight derives exact ten binding fields without reservation, root, history or relay',async t=>{
 const f=await createTransportMainFixture(t),ticket=f.preflight();assert(Object.isFrozen(ticket));assert.deepEqual(Object.keys(ticket),[]);
 const b=f.wiring.getNativeExecutorTransportBinding(ticket);assert(Object.isFrozen(b));
 assert.deepEqual(Object.keys(b),['operationId','nativeJobId','requestSHA256','requestBytesSHA256','archiveBytesSHA256','gameId','modId','profileId','managerScope','rendererGeneration']);
 assert.equal(b.requestSHA256,dispatch.dispatchRequestDigest(f.requestBytes));assert.equal(b.requestBytesSHA256,sha(f.requestBytes));assert.equal(b.archiveBytesSHA256,sha(f.archiveBytes));
 assert.equal(b.gameId,'cyberpunk2077');assert.equal(b.modId,'own');assert.equal(b.profileId,f.request.plan.context.profileId);assert.equal(b.managerScope,f.request.managerScope);assert.equal(b.rendererGeneration,f.request.rendererGeneration);
 assert.equal(f.main.getNativeModPersistenceReservation().phase,'not_reserved');sourceOnly(f);
});
integration('both raw inputs detach before the first SDK/filesystem callback',async t=>{
 let armed=false,f;const io=Object.create(fs);io.openSync=(...args)=>{if(armed){armed=false;f.requestBytes.fill(0);f.archiveBytes.fill(0);}return fs.openSync(...args);};
 f=await createTransportMainFixture(t,{nativeFS:io});const requestHash=sha(f.requestBytes),archiveHash=sha(f.archiveBytes);armed=true;
 const ticket=f.preflight(),b=f.wiring.getNativeExecutorTransportBinding(ticket);assert.equal(b.requestBytesSHA256,requestHash);assert.equal(b.archiveBytesSHA256,archiveHash);
 assert.equal(b.modId,'own');assert.equal(f.requestBytes.every(x=>x===0),true);assert.equal(f.archiveBytes.every(x=>x===0),true);sourceOnly(f);
});
integration('invalid byte brands, shared memory, proxies, BOM and caps reject before SDK callbacks',async t=>{
 const invalid=[()=>({}),r=>new Proxy(r,{get(){assert.fail('proxy trap');}}),r=>new Uint8Array(new SharedArrayBuffer(r.length)),r=>Buffer.concat([Buffer.from([239,187,191]),r]),()=>Buffer.alloc(1052673)];
 for(const side of ['request','archive'])for(const make of invalid){let armed=false,ioCalls=0;const io=Object.create(fs);io.lstatSync=(...args)=>{if(armed)ioCalls++;return fs.lstatSync(...args);};
  const f=await createTransportMainFixture(t,{nativeFS:io}),input=make(side==='request'?f.requestBytes:f.archiveBytes);armed=true;
  assert.throws(()=>f.preflight(side==='request'?input:f.requestBytes,side==='archive'?input:f.archiveBytes));assert.equal(ioCalls,0);assert.equal(f.loads(),0);sourceOnly(f);
 }
});
integration('ordinary input formatting binds distinct raw bytes but the same canonical request digest',async t=>{
 const f=await createTransportMainFixture(t),r=Buffer.from(' \n'+f.requestBytes+'\t'),a=Buffer.from('\n'+f.archiveBytes+' '),ticket=f.preflight(r,a),b=f.wiring.getNativeExecutorTransportBinding(ticket);
 assert.equal(b.requestSHA256,dispatch.dispatchRequestDigest(f.requestBytes));assert.notEqual(b.requestBytesSHA256,sha(f.requestBytes));assert.equal(b.requestBytesSHA256,sha(r));assert.equal(b.archiveBytesSHA256,sha(a));sourceOnly(f);
});
integration('fake readiness and forged ticket aliases cannot become authority or poison a genuine ticket',async t=>{
 const f=await createTransportMainFixture(t);assert.throws(()=>f.wiring.preflightNativeExecutorTransport({},f.requestBytes,f.archiveBytes));sourceOnly(f);
 const g=await createTransportMainFixture(t),ticket=g.preflight(),n=g.loads();
 for(const fake of [{},Object.freeze({}),structuredClone(ticket),null,new Proxy(ticket,{get(){assert.fail('ticket proxy');}})]){
  assert.throws(()=>g.wiring.getNativeExecutorTransportBinding(fake));assert.throws(()=>g.wiring.checkNativeExecutorTransport(fake));assert.throws(()=>g.wiring.holdNativeExecutorTransport(fake));
 }
 assert.equal(g.loads(),n);g.wiring.checkNativeExecutorTransport(ticket);sourceOnly(g);
});
integration('reservation uses actual captured Main prototype, never caller DTO or shadowed method',async t=>{
 const f=await createTransportMainFixture(t),ticket=f.preflight();
 f.main.reserveNativeModPersistence=()=>assert.fail('shadow reserve');f.main.getNativeModPersistenceReservation=()=>assert.fail('diagnostic DTO');
 await f.wiring.reserveNativeExecutorTransport(ticket);f.wiring.checkNativeExecutorTransport(ticket);
 const record=f.main.mNativeModPersistenceReservation;assert.equal(record.gameId,'cyberpunk2077');assert.equal(record.modId,'own');assert.equal(record.phase,'reserved');sourceOnly(f);
});
integration('held pending reservation retains and poisons its genuine late owner without refund or history',async t=>{
 const gate=deferred(),f=await createTransportMainFixture(t,{beforeRead:sql=>sql.includes('SELECT 1 FROM keys')?gate.promise:undefined}),ticket=f.preflight();
 const reserving=f.wiring.reserveNativeExecutorTransport(ticket);reserving.catch(()=>{});await tick();f.wiring.holdNativeExecutorTransport(ticket);gate.resolve();await assert.rejects(reserving);
 stopped(f,ticket);assert.equal(f.main.getNativeModPersistenceReservation().phase,'held');sourceOnly(f);
 const count=f.calls.length;await assert.rejects(f.wiring.reserveNativeExecutorTransport(ticket));assert.equal(f.calls.length,count);
});
integration('only actual reserved Main plus actual frame can prepare a bound pending projection without owner',async t=>{
 const f=await createTransportMainFixture(t),ticket=f.preflight();await f.wiring.reserveNativeExecutorTransport(ticket);
 const out=await f.wiring.prepareNativeExecutorTransportPending(ticket,f.frameOwner);assert(Object.isFrozen(out));
 assert.deepEqual(Object.keys(out),['schema','operationId','nativeJobId','requestSHA256','rootId','inventorySHA256','effectsAllowed','installationPermit','nativeAdmission','powerLossPersistenceVerified']);
 assert.equal(out.schema,'native-executor-pending-preparation/1');assert.equal(out.operationId,f.request.operationId);assert(!Object.hasOwn(out,'owner'));assert(!Object.hasOwn(out,'relay'));assert(!Object.hasOwn(out,'start'));
 for(const k of ['effectsAllowed','installationPermit','nativeAdmission','powerLossPersistenceVerified'])assert.equal(out[k],false);
 const a=JSON.parse(f.committed.get(K)),i=createNativeExecutorJournal({root:f.root}).inventory({expectedRootId:a.rootId,expectedInventorySHA256:a.inventorySHA256});
 assert.equal(i.historySealVerified,true);assert.equal(i.startupHoldRequired,true);assert.equal(i.unresolvedCount,1);assert.equal(f.calls.filter(c=>c.sql==='COMMIT').length,2);
 assert.equal(f.counts().startCalls,0);f.wiring.checkNativeExecutorTransport(ticket);
});
integration('hold while relay preparation awaits poisons only matching Main/pending/frame owners',async t=>{
 const gate=deferred(),f=await createTransportMainFixture(t,{beforePrepare:()=>gate.promise}),ticket=f.preflight();await f.wiring.reserveNativeExecutorTransport(ticket);
 const preparing=f.wiring.prepareNativeExecutorTransportPending(ticket,f.frameOwner);preparing.catch(()=>{});await tick();f.wiring.holdNativeExecutorTransport(ticket);gate.resolve();await assert.rejects(preparing);
 stopped(f,ticket);assert.equal(f.main.getNativeModPersistenceReservation().phase,'held');assert.throws(()=>f.frame.check(f.frameOwner));assert.equal(f.counts().prepareCalls,1);assert.equal(f.calls.filter(c=>c.sql==='COMMIT').length,1);
});
integration('late post-prepare hold invalidates retained pending state without cancel, release or ID reset',async t=>{
 const f=await createTransportMainFixture(t),ticket=f.preflight();await f.wiring.reserveNativeExecutorTransport(ticket);await f.wiring.prepareNativeExecutorTransportPending(ticket,f.frameOwner);
 const n=f.calls.length;f.wiring.holdNativeExecutorTransport(ticket);stopped(f,ticket);assert.equal(f.main.getNativeModPersistenceReservation().phase,'held');assert.throws(()=>f.frame.check(f.frameOwner));
 await assert.rejects(f.wiring.prepareNativeExecutorTransportPending(ticket,f.frameOwner));assert.equal(f.calls.length,n);assert.equal(f.counts().prepareCalls,1);assert.equal(f.counts().startCalls,0);
});
integration('frame mismatch and source/cache drift refuse without provisioning or reservation replacement',async t=>{
 for(const mode of ['frame','source','cache']){const f=await createTransportMainFixture(t),ticket=f.preflight();
  if(mode==='frame'){await f.wiring.reserveNativeExecutorTransport(ticket);await assert.rejects(f.wiring.prepareNativeExecutorTransportPending(ticket,{}));f.frame.check(f.frameOwner);}
  else{if(mode==='source')fs.appendFileSync(path.join(f.sdk,'paths-core.cjs'),'\n// own drift');else createRequire(import.meta.url).cache[path.join(f.sdk,'owned-zip-relay-client.mjs')]={exports:{}};
   assert.throws(()=>f.wiring.checkNativeExecutorTransport(ticket));}
  stopped(f,ticket);sourceOnly(f);
 }
});
integration('one-shot duplicate preflight/reserve consumes no second reservation or controller',async t=>{
 const f=await createTransportMainFixture(t),ticket=f.preflight();assert.throws(()=>f.preflight());stopped(f,ticket);sourceOnly(f);
 const gate=deferred(),g=await createTransportMainFixture(t,{beforeRead:sql=>sql.includes('SELECT 1 FROM keys')?gate.promise:undefined}),other=g.preflight();
 const first=g.wiring.reserveNativeExecutorTransport(other);first.catch(()=>{});await tick();await assert.rejects(g.wiring.reserveNativeExecutorTransport(other));gate.resolve();await assert.rejects(first);
 assert.equal(g.calls.filter(c=>c.sql.includes('SELECT 1 FROM keys')).length,1);assert.equal(g.main.getNativeModPersistenceReservation().phase,'held');sourceOnly(g);
});
integration('caught source callback reentry cannot revive preflight or a checked transport ticket',async t=>{
 for(const mode of ['preflight','check']){let armed=false,f,ticket,nested=false;const io=Object.create(fs);io.openSync=(...args)=>{
  if(armed){armed=false;nested=true;assert.throws(()=>mode==='preflight'?f.preflight():f.wiring.checkNativeExecutorTransport(ticket));}return fs.openSync(...args);
 };
  f=await createTransportMainFixture(t,{nativeFS:io});if(mode==='check')ticket=f.preflight();armed=true;
  assert.throws(()=>mode==='preflight'?f.preflight():f.wiring.getNativeExecutorTransportBinding(ticket));assert(nested);sourceOnly(f);
 }
});
integration('unknown real pending COMMIT preserves null/undefined primary and keeps matching owners held',async t=>{
 for(const primary of [null,undefined]){let commits=0;const f=await createTransportMainFixture(t,{afterRun:sql=>{if(sql==='COMMIT'&&++commits===2)throw primary;}}),ticket=f.preflight();
  await f.wiring.reserveNativeExecutorTransport(ticket);
  await f.wiring.prepareNativeExecutorTransportPending(ticket,f.frameOwner).then(()=>assert.fail('unexpected projection'),error=>assert.equal(error,primary));
  stopped(f,ticket);assert.equal(f.main.getNativeModPersistenceReservation().phase,'held');assert.throws(()=>f.frame.check(f.frameOwner));
  assert.equal(f.calls.filter(c=>c.sql==='COMMIT').length,2);assert.equal(f.calls.some(c=>c.sql==='ROLLBACK'),false);assert.equal(f.counts().prepareCalls,1);
 }
});
integration('actual frame identity drift after prepared projection poisons retained Main and pending state',async t=>{
 const f=await createTransportMainFixture(t),ticket=f.preflight();await f.wiring.reserveNativeExecutorTransport(ticket);await f.wiring.prepareNativeExecutorTransportPending(ticket,f.frameOwner);
 f.frame.owner.rendererPID++;assert.throws(()=>f.wiring.checkNativeExecutorTransport(ticket));stopped(f,ticket);assert.equal(f.main.getNativeModPersistenceReservation().phase,'held');
 assert.throws(()=>f.wiring.getNativeExecutorTransportBinding(ticket));assert.equal(f.counts().startCalls,0);
});
}
