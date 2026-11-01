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
const levelStages=['new-mod-conflict-query','backend-write-admission','native-backend-sql-admission','native-owned-mod-registration','native-tracked-mod-registration','native-backend-registration-release','native-executor-anchor-storage'];
const mainStages=['batch-acknowledgement','target-reservation','acknowledged-packet','backend-reservation-admission','legacy-rollback-primary','native-main-sql-admission','native-main-mod-registration','native-main-tracked-mod-registration','native-main-registration-release','native-main-executor-anchor','native-main-executor-hold','native-main-executor-target'];
const stages=['native-query-owner-binding','native-main-readiness','native-main-anchor-binding','native-main-executor-startup','native-main-executor-genesis','native-main-executor-pending'];
const integration=(name,fn)=>test(name,{timeout:15000,skip:repo?false:'Set VORTEX_EXTENSION_ADMISSION_REPO'},fn);
/** Actual main/Level/Registry/pool source. SQL is an owned transactional facade;
 * Database/watcher/invalidator are initialization-only facades, not host objects. */
export async function createPendingFixture(t,options={}){
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
  const prep=path.resolve(HERE,'../../../local-state/renderer-executor-admission/recovery/main-pending/cases');fs.mkdirSync(prep,{recursive:true});
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
    testOnlyPendingRelay:()=>nativePendingAttempt?.relay})`,{
    ...types,ReduxPersistorIPC:Main,SubPersistor,checkNativeExecutorFrame:owner=>frame.check(owner),holdNativeExecutorFrame:owner=>frame.hold(owner),DuckDBSingleton:base.Singleton,QueryRegistry:base.Registry,
    QueryInvalidator:class{notifyDirtyTables(){}setWatcher(){}},Database:class{},QueryWatcher:class{},
    parseAllQueries:dir=>parsed(dir),getVortexPath:()=>workspace,setupPersistenceIPC(){},getErrorMessageOrDefault:()=>'',
    nativeStartupFS:fs,nativeStartupHash:crypto.createHash,nativeStartupTypes:nativeRegistrationTypes,createRequire:()=>loader,
    __filename:fileURLToPath(import.meta.url),__NEXUS_NATIVE_RUNTIME_BINDING__:binding});
  const startup=await wiring.verifyNativeExecutorStartup(level);
  const mainBackend=options.differentBackend?new types.LevelPersist(base.backend,'db'):level;
  const main=wiring.initMainPersistence(mainBackend),mainOwner=await wiring.waitForNativeMainPersistenceReady();
  main.mPersistors.persistent=new SubPersistor(mainBackend,'persistent');main.mPersistors.settings=new SubPersistor(mainBackend,'settings');
  const owner=await main.reserveNativeModPersistence('cyberpunk2077',options.modId??'own');
  frame=frameFixture({setup:false});frame.state.current=main;frame.api.setupPersistenceIPC(main);const frameOwner=frame.reserve();
  const h='a'.repeat(64),plan={schema:'install-job-plan/1',family:'tracked-new-disabled',contractId:job.CONTRACT_ID,
    context:{gameId:'cyberpunk2077',profileId:'pending-fixture',gamePath:path.join(workspace,'game'),stagingPath:path.join(workspace,'stage'),downloadPath:path.join(workspace,'downloads'),filesystemIds:{gamePath:'1:1',stagingPath:'1:2',downloadPath:'1:3'}},
    package:{downloadId:'own-download',fileName:'own.zip',expectedModId:'own',expectedType:'',bytes:32,sha256:h,md5:'b'.repeat(32),expectedUncompressedBytes:1,payload:{'a.txt':h}},
    evidence:{buildSHA256:h,sourceSHA256:h,nativeAdmissionSHA256:h},options:{enabled:false,deploy:false}};
  const request={schema:'native-dispatch-request/1',contractId:dispatch.CONTRACT_ID,operationId:'op_'+'1'.repeat(32),nativeJobId:'exec_'+'2'.repeat(32),
    planId:job.installPlanId(plan),managerScope:'manager-pending-fixture-1',rendererGeneration:'renderer_'+'3'.repeat(32),admissionSHA256:h,plan};
  const identity={schema:'win-file-id128/1',volumeSerialNumber:'1',fileId:'2'};
  const archive={parent:plan.context.downloadPath,parentIdentity:identity,identity:{...identity,fileId:'3'},leaf:'own.zip',bytes:32,sha256:h};
  const requestBytes=Buffer.from(JSON.stringify(request)),archiveBytes=Buffer.from(JSON.stringify(archive));
  return{frame,frameOwner,request,archive,requestBytes,archiveBytes,transport,counts:()=>({relayCreated,prepareCalls,startCalls}),pending:()=>wiring.prepareNativeExecutorPending(mainOwner,owner,frameOwner,requestBytes,archiveBytes),...base,types,Main,level:mainBackend,selectedBackend:level,main,mainOwner,owner,wiring,committed,calls,workspace,sdk,root,startup,loads:()=>loads,
    initialize:()=>wiring.initializeNativeExecutorHistory(mainOwner,owner)};
}

function held(f){assert.equal(f.main.getNativeModPersistenceReservation().phase,'held');assert.throws(()=>f.frame.check(f.frameOwner));assert.equal(f.counts().startCalls,0);}
function pendingInventory(f){const a=JSON.parse(f.committed.get(K));return createNativeExecutorJournal({root:f.root}).inventory({expectedRootId:a.rootId,expectedInventorySHA256:a.inventorySHA256});}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
test('pending artifact pins actual genesis and actual source-frame producer without START authority',()=>{
  const{m,patch}=stage('native-main-executor-pending'),p=stage('native-main-executor-genesis').m,c=stage('native-executor-frame-owner').m;
  assert.equal(m.inputSHA256,p.outputSHA256);assert.equal(m.prerequisitePatchSHA256,p.patchSHA256);assert.equal(sha(patch),m.patchSHA256);
  assert.equal(m.requiredCompanionPatchSHA256,c.patchSHA256);assert.equal(m.requiredCompanionOutputSHA256,c.outputSHA256);
  const target=stage('native-main-executor-target').m;
  assert.deepEqual(m.additionalCompanions,[{packet:'persistence',name:'native-main-executor-target',patchSHA256:target.patchSHA256,outputSHA256:target.outputSHA256}]);
  for(const k of ['installed','nativeAcceptanceVerified','effectsAllowed','installationPermit','nativeAdmission','powerLossPersistenceVerified'])assert.equal(m[k],false);
});
integration('actual classes provision then commit the authentic pending successor without exposing relay or START',async t=>{
  const f=await createPendingFixture(t),out=await f.pending();assert.equal(out.schema,'native-executor-pending-preparation/1');
  assert(Object.isFrozen(out));assert(Object.isFrozen(out.owner));assert.deepEqual(Reflect.ownKeys(out.owner),[]);
  assert.equal(out.operationId,f.request.operationId);assert.equal(out.nativeJobId,f.request.nativeJobId);
  assert.equal(out.requestSHA256,dispatch.dispatchRequestDigest(f.requestBytes));
  for(const k of ['effectsAllowed','installationPermit','nativeAdmission','powerLossPersistenceVerified'])assert.equal(out[k],false);
  assert(!Object.hasOwn(out,'relay'));assert(!Object.hasOwn(out,'start'));assert(!Object.hasOwn(out,'startPrepared'));
  assert.equal(f.calls.filter(c=>c.sql==='COMMIT').length,2);assert.deepEqual(f.counts(),{relayCreated:1,prepareCalls:1,startCalls:0});
  const i=pendingInventory(f);assert.equal(i.historySealVerified,true);assert.equal(i.startupHoldRequired,true);assert.equal(i.unresolvedCount,1);
  f.frame.check(f.frameOwner);f.main.checkNativeModPersistenceTarget(f.owner,'cyberpunk2077','own');
});
integration('initialized startup and existing READY genesis reuse the same journal instead of cold-cache refusal',async t=>{
  for(const existing of [false,true]){const f=await createPendingFixture(t,{initialized:true});if(existing)await f.initialize();
    const out=await f.pending();assert.equal(out.schema,'native-executor-pending-preparation/1');assert.equal(f.calls.filter(c=>c.sql==='COMMIT').length,1);
    assert.equal(f.loads(),4);assert.equal(f.counts().startCalls,0);}
});
integration('invalid archive or request refuses before genesis root, anchor write or relay construction',async t=>{
  for(const mode of ['archive','parent','request','BOM']){const f=await createPendingFixture(t);let r=f.requestBytes,a=f.archiveBytes;
    if(mode==='archive')a=Buffer.from(JSON.stringify({...f.archive,bytes:33}));if(mode==='parent')a=Buffer.from(JSON.stringify({...f.archive,parent:'C:/elsewhere'}));
    if(mode==='request')r=Buffer.from(JSON.stringify({...f.request,planId:'f'.repeat(64)}));if(mode==='BOM')a=Buffer.concat([Buffer.from([239,187,191]),a]);
    await assert.rejects(f.wiring.prepareNativeExecutorPending(f.mainOwner,f.owner,f.frameOwner,r,a));held(f);
    assert.equal(fs.existsSync(f.root),false);assert.equal(f.committed.size,0);assert.equal(f.counts().relayCreated,0);
  }
});
integration('SDK-supported family metadata is checked before actual genesis or provisioning',async t=>{
  for(const mutate of [r=>r.plan.package.downloadId='Constructor',r=>r.plan.package.downloadId='_archive',
    r=>r.plan.package.payload={'a#.txt':'c'.repeat(64)},r=>r.plan.package.payload={'a~.txt':'c'.repeat(64)},
    r=>r.plan.package.payload={['a/'.repeat(32)+'a.txt']:'c'.repeat(64)},
    r=>r.plan.context.stagingPath='C:/own~stage',r=>r.plan.context.stagingPath='C:/'+Array(33).fill('stage').join('/')]){
    const f=await createPendingFixture(t),request=structuredClone(f.request);mutate(request);request.planId=job.installPlanId(request.plan);
    await assert.rejects(f.wiring.prepareNativeExecutorPending(f.mainOwner,f.owner,f.frameOwner,Buffer.from(JSON.stringify(request)),f.archiveBytes),/UNSUPPORTED_/);
    held(f);assert.equal(fs.existsSync(f.root),false);assert.equal(f.committed.size,0);assert.equal(f.counts().relayCreated,0);
  }
});
integration('genuine reservation for another target cannot use diagnostic DTO forgery to provision',async t=>{
  const f=await createPendingFixture(t,{modId:'other'});f.main.getNativeModPersistenceReservation=()=>({phase:'reserved',gameId:'cyberpunk2077',modId:'own'});
  await assert.rejects(f.pending(),/TARGET/);assert.equal(fs.existsSync(f.root),false);assert.equal(f.committed.size,0);
  assert.throws(()=>f.main.checkNativeModPersistenceReservation(f.owner));assert.throws(()=>f.frame.check(f.frameOwner));
});
integration('forged readiness/mod/frame owners never provision, reserve pending or construct relay',async t=>{
  for(const which of ['ready','mod','frame']){const f=await createPendingFixture(t);
    await assert.rejects(f.wiring.prepareNativeExecutorPending(which==='ready'?{}:f.mainOwner,which==='mod'?{}:f.owner,which==='frame'?{}:f.frameOwner,f.requestBytes,f.archiveBytes));
    assert.equal(fs.existsSync(f.root),false);assert.equal(f.committed.size,0);assert.equal(f.counts().relayCreated,0);}
});
integration('actual navigation while prepare is pending retains reservation and never writes successor anchor',async t=>{
  const gate=deferred(),f=await createPendingFixture(t,{beforePrepare:()=>gate.promise});const first=f.pending();first.catch(()=>{});await tick();
  f.frame.owner.emit('did-start-navigation',{isMainFrame:true});gate.resolve();await assert.rejects(first);held(f);
  assert.equal(f.calls.filter(c=>c.sql==='COMMIT').length,1);assert.equal(pendingInventory(f).historySealVerified,false);
});
integration('actual frame identity drift during second COMMIT invalidates a successfully written successor',async t=>{
  let commits=0,f;f=await createPendingFixture(t,{afterRun:sql=>{if(sql==='COMMIT'&&++commits===2)f.frame.owner.rendererPID++;}});
  await assert.rejects(f.pending());held(f);assert.equal(f.calls.filter(c=>c.sql==='COMMIT').length,2);
  assert.equal(pendingInventory(f).historySealVerified,true);assert.equal(pendingInventory(f).startupHoldRequired,true);
});
integration('lost second COMMIT acknowledgement preserves original error and never retries or cancels relay',async t=>{
  const primary=Error('own pending commit reply lost');let commits=0;
  const f=await createPendingFixture(t,{afterRun:sql=>{if(sql==='COMMIT'&&++commits===2)throw primary;}});
  await assert.rejects(f.pending(),e=>e===primary);held(f);const n=f.calls.length;await assert.rejects(f.pending());assert.equal(f.calls.length,n);
  assert.equal(pendingInventory(f).historySealVerified,true);assert.equal(f.calls.some(c=>c.sql==='ROLLBACK'),false);
});
integration('malformed prepared binding or transition refuses before pending CAS without refund',async t=>{
  for(const which of ['binding','transition','packet']){const f=await createPendingFixture(t,{receipt:r=>which==='binding'?{...r,binding:{...r.binding,nativeJobId:'exec_'+'9'.repeat(32)}}:
    which==='transition'?{...r,transition:{...r.transition,previousInventorySHA256:'a'.repeat(64)}}:{...r,packetSHA256:'a'.repeat(64)}});
    await assert.rejects(f.pending());held(f);assert.equal(f.calls.filter(c=>c.sql==='COMMIT').length,1);assert.equal(fs.existsSync(path.join(f.root,'jobs')),true);}
});
integration('extra pending operation after authentic receipt fails independent inventory membership',async t=>{
  const f=await createPendingFixture(t,{afterPrepare:({journal})=>{
    const other=structuredClone(f.request);other.operationId='op_'+'8'.repeat(32);other.nativeJobId='exec_'+'8'.repeat(32);
    journal.begin(Buffer.from(JSON.stringify(other)),'worker_'+'8'.repeat(32),'8'.repeat(64));
  }});await assert.rejects(f.pending());held(f);assert.equal(f.calls.filter(c=>c.sql==='COMMIT').length,1);
});
integration('stale actual DB predecessor refuses before relay prepare despite a valid private genesis owner',async t=>{
  const f=await createPendingFixture(t,{initialized:true});await f.initialize();const old=JSON.parse(f.committed.get(K));f.committed.set(K,JSON.stringify({...old,inventorySHA256:'a'.repeat(64)}));
  await assert.rejects(f.pending());held(f);assert.equal(f.counts().prepareCalls,0);
});
integration('unexpected source or cache entry drift refuses before relay prepare and remains held',async t=>{
  for(const mode of ['source','cache']){const f=await createPendingFixture(t,{initialized:true});
    if(mode==='source')fs.appendFileSync(path.join(f.sdk,'paths-core.cjs'),'\n// own drift');
    else createRequire(import.meta.url).cache[path.join(f.sdk,'owned-zip-relay-client.mjs')]={exports:{}};
    await assert.rejects(f.pending());held(f);assert.equal(f.counts().prepareCalls,0);assert.equal(f.calls.filter(c=>c.sql==='COMMIT').length,0);}
});
integration('duplicate during pending CAS holds both invocations without a second pending reservation',async t=>{
  const gate=deferred();let commits=0;const f=await createPendingFixture(t,{beforeRun:sql=>sql==='COMMIT'&&++commits===2?gate.promise:undefined});
  const first=f.pending();first.catch(()=>{});await tick();await assert.rejects(f.pending());gate.resolve();await assert.rejects(first);held(f);
  assert.equal(f.counts().prepareCalls,1);assert.equal(f.calls.filter(c=>c.sql==='COMMIT').length,2);
});

function historicalSeed({root,workspace,committed}){
  const h='7'.repeat(64),plan={schema:'install-job-plan/1',family:'tracked-new-disabled',contractId:job.CONTRACT_ID,
    context:{gameId:'cyberpunk2077',profileId:'old-own',gamePath:path.join(workspace,'game'),stagingPath:path.join(workspace,'stage'),downloadPath:path.join(workspace,'downloads'),filesystemIds:{gamePath:'1:1',stagingPath:'1:2',downloadPath:'1:3'}},
    package:{downloadId:'old-download',fileName:'old.zip',expectedModId:'old',expectedType:'',bytes:32,sha256:h,md5:'7'.repeat(32),expectedUncompressedBytes:1,payload:{'a.txt':h}},
    evidence:{buildSHA256:h,sourceSHA256:h,nativeAdmissionSHA256:h},options:{enabled:false,deploy:false}};
  const request={schema:'native-dispatch-request/1',contractId:dispatch.CONTRACT_ID,operationId:'op_'+'7'.repeat(32),nativeJobId:'exec_'+'7'.repeat(32),planId:job.installPlanId(plan),managerScope:'manager-old-1',rendererGeneration:'renderer_'+'7'.repeat(32),admissionSHA256:h,plan};
  const journal=createNativeExecutorJournal({root}),status=journal.begin(Buffer.from(JSON.stringify(request)),'worker_'+'7'.repeat(32),h);
  journal.appendTerminal({operationId:request.operationId,nativeJobId:request.nativeJobId,requestSHA256:status.requestSHA256,packetSHA256:h,workerLifetime:'worker_'+'7'.repeat(32)},Buffer.from(JSON.stringify({schema:'native-executor-terminal-evidence/1',outcome:'committed_adopted_closed',fullRecordSHA256:h,registrationObservationSHA256:h,adoptionObservationSHA256:h,workerClosureObservationSHA256:h,releaseObservationSHA256:h})));
  const i=journal.inventory();committed.set(K,JSON.stringify({schema:'native-executor-anchor/1',rootId:i.observedRootId,inventorySHA256:i.observedInventorySHA256}));
}
integration('nonempty historical census remains exactly bound while one new pending row is added',async t=>{
  const f=await createPendingFixture(t,{initialized:true,seed:historicalSeed});
  const before=pendingInventory(f);assert.equal(before.closedCount,1);assert.equal(before.unresolvedCount,0);
  await f.pending();const after=pendingInventory(f);assert.equal(after.closedCount,1);assert.equal(after.unresolvedCount,1);
  assert.deepEqual(after.records.find(row=>row.operationId==='op_'+'7'.repeat(32)),before.records[0]);assert.equal(f.counts().startCalls,0);
});
integration('prepared receipt accessor is refused without running it or committing successor',async t=>{
  let getters=0;const f=await createPendingFixture(t,{receipt:r=>Object.defineProperty({...r},'packetSHA256',{get(){getters++;throw Error('receipt getter');}})});
  await assert.rejects(f.pending());held(f);assert.equal(getters,0);assert.equal(f.calls.filter(c=>c.sql==='COMMIT').length,1);
});
}
