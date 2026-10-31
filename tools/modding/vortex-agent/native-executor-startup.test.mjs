import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';import {createRequire} from 'node:module';import {fileURLToPath}from'node:url';
import {types as nativeStartupTypes}from'node:util';
import {repo,prepared,stage,sha,execute,original,deferred,tick}from'./native-query-source-admission.test.mjs';
import {createAnchorFixture}from'./native-executor-anchor-storage.test.mjs';
import job from './install-job-contract.cjs';
import dispatch from './native-dispatch-contract.cjs';
import{createNativeExecutorJournal}from'./native-executor-journal.mjs';
const HERE=path.dirname(fileURLToPath(import.meta.url)),K='nativeExecutorAnchorV1';
const names=['owned-zip-relay-client.mjs','owned-zip-relay-runner.mjs','child-terminal-observer.cjs','owned-zip-worker-client.mjs','owned-zip-worker.py','owned-file-transfer.py','owned-zip-extractor.py','native-executor-journal.mjs','native-intent-journal.mjs','immutable-records.mjs','paths.cjs','paths-core.cjs','native-dispatch-contract.cjs','install-job-contract.cjs','strict-json.cjs'];
const stages=['native-query-owner-binding','native-main-readiness','native-main-anchor-binding','native-main-executor-startup'];
const native=(name,fn)=>test(name,{timeout:15000,skip:repo?false:'Set VORTEX_EXTENSION_ADMISSION_REPO'},fn);
async function fixture(t,options={}){
 const f=await createAnchorFixture(t,{unreserved:true,...options});
 const scratch=path.resolve(HERE,'../../../local-state/native-runtime-binding/recovery/startup-tests');fs.mkdirSync(scratch,{recursive:true});
 const workspace=fs.mkdtempSync(path.join(scratch,'run-')),sdk=path.join(workspace,'tools/modding/vortex-agent');fs.mkdirSync(sdk,{recursive:true});
 const sourceSHA256={};for(const n of names){const b=fs.readFileSync(path.join(HERE,n));fs.writeFileSync(path.join(sdk,n),b,{flag:'wx'});sourceSHA256[n]=sha(b);}
 const binding={schema:'native-executor-runtime-binding/1',workspaceRoot:workspace.replaceAll('\\','/'),relayNodeSHA256:'5c976096e04e5c2c1f091938926234cc9fbebfe9787ddd149351b3b0ecc707b5',sourceSHA256};
 const journalRoot=path.join(workspace,'local-state/vortex-agent-build/native-install-executor');
 let calls=0;const baseRequire=createRequire(import.meta.url),loader=file=>{calls++;return options.load?options.load(file,baseRequire):baseRequire(file);};loader.cache=options.cache??baseRequire.cache;
 function build(value=binding){const api=execute(prepared(stages),'({verifyNativeExecutorStartup})',{
  LevelPersist:f.types.LevelPersist,snapshotNativeExecutorAnchor:f.types.snapshotNativeExecutorAnchor,isNativeExecutorAnchorKey:f.types.isNativeExecutorAnchorKey,
  nativeStartupFS:options.fs??fs,nativeStartupHash:crypto.createHash,nativeStartupTypes,createRequire:()=>loader,__filename:fileURLToPath(import.meta.url),__NEXUS_NATIVE_RUNTIME_BINDING__:value});return api;}
 const seedClosed=()=>{fs.mkdirSync(journalRoot,{recursive:true});const j=createNativeExecutorJournal({root:journalRoot}),i=j.inventory();const anchor={schema:'native-executor-anchor/1',rootId:i.observedRootId,inventorySHA256:i.observedInventorySHA256};f.committed.set(K,JSON.stringify(anchor));return{j,anchor};};
 return{...f,workspace,sdk,binding,journalRoot,seedClosed,build,calls:()=>calls};
}
function passive(result,phase){assert.equal(result.phase,phase);for(const k of ['nativeAdmission','installationPermit','effectsAllowed','powerLossPersistenceVerified'])assert.equal(result[k],false);assert(Object.isFrozen(result));}

test('startup artifacts pin actual predecessors and builder companion without installer authority',()=>{
 for(const[name,parent]of[['native-main-executor-startup','native-main-anchor-binding'],['native-application-executor-startup','ack-application-owner']]){const{m,patch}=stage(name),p=stage(parent);assert.equal(sha(patch),m.patchSHA256);assert.equal(m.inputSHA256,p.m.outputSHA256);assert.equal(m.prerequisitePatchSHA256,p.m.patchSHA256);for(const k of['installed','nativeAcceptanceVerified','installationPermit','powerLossPersistenceVerified','startupGateSupported'])assert.equal(m[k],false);}
 const m=stage('native-main-executor-startup').m;assert.equal(m.requiredCompanionPatchSHA256,stage('native-main-runtime-binding').m.patchSHA256);
});
native('unconfigured absent anchor allows ordinary startup without importing or creating a journal',async t=>{const f=await fixture(t),a=f.build(null);passive(await a.verifyNativeExecutorStartup(f.level),'unconfigured');assert.equal(f.calls(),0);assert.equal(fs.existsSync(f.journalRoot),false);});
native('unconfigured present anchor holds before SDK loader or main initialization',async t=>{const f=await fixture(t);f.seedClosed();await assert.rejects(f.build(null).verifyNativeExecutorStartup(f.level),/STARTUP_HOLD/);assert.equal(f.calls(),0);});
native('configured both absent is uninitialized, no genesis and no require',async t=>{const f=await fixture(t);passive(await f.build().verifyNativeExecutorStartup(f.level),'uninitialized');assert.equal(fs.existsSync(f.journalRoot),false);assert.equal(f.committed.has(K),false);assert.equal(f.calls(),0);});
native('actual fixed synchronous ESM journal loads at fresh SDK path and validates closed trusted seal',async t=>{const f=await fixture(t);f.seedClosed();passive(await f.build().verifyNativeExecutorStartup(f.level),'initialized');assert.equal(f.calls(),1);});
native('mixed root and anchor presence, stale census and malformed anchor all hold',async t=>{
 for(const mode of ['root-only','anchor-only','stale','corrupt']){const f=await fixture(t);if(mode==='root-only')fs.mkdirSync(f.journalRoot,{recursive:true});else{f.seedClosed();if(mode==='anchor-only')fs.renameSync(f.journalRoot,path.join(f.workspace,'keeper'));if(mode==='stale'){const a=JSON.parse(f.committed.get(K));a.inventorySHA256='a'.repeat(64);f.committed.set(K,JSON.stringify(a));}if(mode==='corrupt')f.committed.set(K,'notjson');}await assert.rejects(f.build().verifyNativeExecutorStartup(f.level),/STARTUP_HOLD/);}
});
native('initialized restore merge or repair refuses before loading SDK',async t=>{const f=await fixture(t);f.seedClosed();await assert.rejects(f.build().verifyNativeExecutorStartup(f.level,true),/STARTUP_HOLD/);assert.equal(f.calls(),0);});
native('duplicate and swallowed reentry while actual anchor read awaits hold late completion',async t=>{const gate=deferred();let paused=false;const f=await fixture(t,{beforeRead:()=>{if(!paused){paused=true;return gate.promise;}}});const api=f.build(null);const first=api.verifyNativeExecutorStartup(f.level);await tick();await assert.rejects(api.verifyNativeExecutorStartup(f.level),/STARTUP_HOLD/);gate.resolve();await assert.rejects(first,/STARTUP_HOLD/);assert.equal(f.calls(),0);});
native('ordinary repair may recheck a different fresh backend only after uninitialized success',async t=>{const f=await fixture(t),a=f.build(null);passive(await a.verifyNativeExecutorStartup(f.level),'unconfigured');const other=new f.types.LevelPersist(f.backend,'db');passive(await a.verifyNativeExecutorStartup(other,true),'unconfigured');await assert.rejects(a.verifyNativeExecutorStartup(other,true),/STARTUP_HOLD/);});
native('malformed tuple getters/proxies and noncanonical Windows roots never invoke caller code',async t=>{const f=await fixture(t);let calls=0;const getter={...f.binding};Object.defineProperty(getter,'workspaceRoot',{get(){calls++;return f.workspace;}});const proxy=new Proxy(f.binding,{get(){calls++;throw Error('caller')}});for(const value of [getter,proxy,{...f.binding,extra:true},{...f.binding,workspaceRoot:'/rooted'},{...f.binding,workspaceRoot:'//?/C:/bad'},{...f.binding,workspaceRoot:f.binding.workspaceRoot+' '},{...f.binding,sourceSHA256:{...f.binding.sourceSHA256,extra:'a'.repeat(64)}},{...f.binding,workspaceRoot:'C:/'+('a'.repeat(8000))}])await assert.rejects(f.build(value).verifyNativeExecutorStartup(f.level),e=>e.message==='NATIVE_EXECUTOR_STARTUP_HOLD'&&e.reasonCode==='BINDING');assert.equal(calls,0);assert.equal(f.calls(),0);});
native('source hash extra-byte growth and reparse ancestors refuse before SDK require',async t=>{for(const mode of ['drift','oversize','link']){const f=await fixture(t);f.seedClosed();if(mode==='drift')fs.appendFileSync(path.join(f.sdk,'paths-core.cjs'),'\n// late');if(mode==='oversize')fs.writeFileSync(path.join(f.sdk,'paths-core.cjs'),Buffer.alloc(524289));if(mode==='link'){fs.renameSync(f.sdk,path.join(f.workspace,'sdk-keeper'));fs.symlinkSync(path.join(f.workspace,'sdk-keeper'),f.sdk,'junction');}await assert.rejects(f.build().verifyNativeExecutorStartup(f.level),e=>e.message==='NATIVE_EXECUTOR_STARTUP_HOLD'&&e.reasonCode==='SOURCE_CLOSURE');assert.equal(f.calls(),0);}});
native('existing require cache, loader failure and mutation during load remain sticky held',async t=>{for(const mode of ['cache','throw','drift']){let f;const cache={};f=await fixture(t,{cache,load:(file,require)=>{if(mode==='throw')throw Error('load');if(mode==='drift')fs.appendFileSync(path.join(f.sdk,'paths-core.cjs'),'\n//changed');return require(file);}});f.seedClosed();if(mode==='cache')cache[path.join(f.sdk,'native-executor-journal.mjs')]={};const api=f.build();await assert.rejects(api.verifyNativeExecutorStartup(f.level),/STARTUP_HOLD/);await assert.rejects(api.verifyNativeExecutorStartup(f.level),/STARTUP_HOLD/);}});
native('root appears during absent-source census or disappears during loading cannot pass',async t=>{for(const mode of ['appears','moves']){let f,changed=false;const ownFS=Object.create(fs);ownFS.openSync=(file,...args)=>{if(mode==='appears'&&!changed){changed=true;fs.mkdirSync(f.journalRoot,{recursive:true});}return fs.openSync(file,...args);};f=await fixture(t,{fs:ownFS,load:(file,require)=>{if(mode==='moves'){fs.renameSync(f.journalRoot,path.join(f.workspace,'root-keeper'));changed=true;}return require(file);}});if(mode==='moves')f.seedClosed();await assert.rejects(f.build().verifyNativeExecutorStartup(f.level),/STARTUP_HOLD/);assert(changed);}});

native('actual Application selected-backend gate runs before restore heal IPC and fails as ordinary HOLD',async t=>{
 const appSource=prepared(['ack-application-owner','native-application-executor-startup']);
 const start=appSource.indexOf('  private async setupPersistence('),end=appSource.indexOf('  private async initDevel(',start);assert(start>0&&end>start);
 const body=appSource.slice(start,end),seen=[],base={},selected={};let creates=0;
 class DataInvalid extends Error{};
 const Class=execute('class Harness{'+body+'}','Harness',{
  path,updateStartupSettings(){},app:{getVersion:()=> 'fixture',getPath:()=> 'C:/fixture'},ipcMain:{removeHandler(){}},betterIpcMain:{handle(){}},currentStatePath:'state',
  LevelPersist:{async create(){return ++creates===1?base:selected;}},SubPersistor:class{async getItem(){return'false'}},setVortexPath(){},statSync(){},mkdirSync(){},changeLogPath(){},
  verifyNativeExecutorStartup:async(backend,maintenance)=>{assert.equal(backend,selected);assert.equal(maintenance,true);seen.push('gate');throw Error('NATIVE_EXECUTOR_STARTUP_HOLD');},
  healInvalidKeys:async()=>seen.push('heal'),initMainPersistence:()=>seen.push('init'),registerHive:async()=>seen.push('hydrate'),DataInvalid,getErrorMessageOrDefault:()=>'',
 });
 const instance=new Class();instance.mBasePath='C:/fixture-base';instance.mArgs={userData:'C:/selected',restore:'own-backup'};instance.mLevelPersistors=[];instance.importBackup=async()=>seen.push('restore');
 await assert.rejects(instance.setupPersistence(),/STARTUP_HOLD/);assert.deepEqual(seen,['gate']);assert.equal(creates,2);
});

function pendingHistory(f,closed=false){
 fs.mkdirSync(f.journalRoot,{recursive:true});const j=createNativeExecutorJournal({root:f.journalRoot}),h='a'.repeat(64);
 const plan={schema:'install-job-plan/1',family:'tracked-new-disabled',contractId:job.CONTRACT_ID,
  context:{gameId:'cyberpunk2077',profileId:'fixture',gamePath:'F:/Fixture/Game',stagingPath:'F:/Fixture/Stage',downloadPath:'D:/Fixture/Downloads',filesystemIds:{gamePath:'1:2',stagingPath:'1:3',downloadPath:'2:4'}},
  package:{downloadId:'tracked',fileName:'Own.zip',expectedModId:'Own',expectedType:'',bytes:200,sha256:h,md5:'b'.repeat(32),expectedUncompressedBytes:10,payload:{'r6/scripts/own.reds':h}},
  evidence:{buildSHA256:h,sourceSHA256:h,nativeAdmissionSHA256:h},options:{enabled:false,deploy:false}};
 const request={schema:'native-dispatch-request/1',contractId:dispatch.CONTRACT_ID,operationId:'op_'+'1'.repeat(32),nativeJobId:'exec_'+'1'.repeat(32),planId:job.installPlanId(plan),managerScope:'manager-fixture-1',rendererGeneration:'renderer_'+'1'.repeat(32),admissionSHA256:h,plan};
 const status=j.begin(Buffer.from(JSON.stringify(request)),'worker_'+'1'.repeat(32),h);
 if(closed)j.appendTerminal({operationId:request.operationId,nativeJobId:request.nativeJobId,requestSHA256:status.requestSHA256,packetSHA256:h,workerLifetime:'worker_'+'1'.repeat(32)},Buffer.from(JSON.stringify({schema:'native-executor-terminal-evidence/1',outcome:'committed_adopted_closed',fullRecordSHA256:h,registrationObservationSHA256:h,adoptionObservationSHA256:h,workerClosureObservationSHA256:h,releaseObservationSHA256:h})));
 const i=j.inventory(),a={schema:'native-executor-anchor/1',rootId:i.observedRootId,inventorySHA256:i.observedInventorySHA256};f.committed.set(K,JSON.stringify(a));return j.inventory({expectedRootId:a.rootId,expectedInventorySHA256:a.inventorySHA256});
}
native('matching trusted pending census holds even though both anchor comparisons succeed',async t=>{const f=await fixture(t),i=pendingHistory(f);assert.equal(i.historySealVerified,true);assert.equal(i.startupHoldRequired,true);assert.equal(i.unresolvedCount,1);await assert.rejects(f.build().verifyNativeExecutorStartup(f.level),e=>e.message==='NATIVE_EXECUTOR_STARTUP_HOLD'&&e.reasonCode==='HISTORY_SCAN');});
native('nonempty closed historical metadata permits startup classification without current-state authority',async t=>{const f=await fixture(t),i=pendingHistory(f,true);assert.equal(i.closedCount,1);assert.equal(i.startupHoldRequired,false);passive(await f.build().verifyNativeExecutorStartup(f.level),'initialized');});
native('wrong root identity is refused independently of a matching census digest',async t=>{const f=await fixture(t),{anchor}=f.seedClosed();f.committed.set(K,JSON.stringify({...anchor,rootId:'0:1'}));await assert.rejects(f.build().verifyNativeExecutorStartup(f.level),/STARTUP_HOLD/);});
native('EACCES probing a configured missing root is an error and never absence',async t=>{let f;const io=Object.create(fs);io.lstatSync=(file,...args)=>{if(path.resolve(String(file))===f.journalRoot){const e=Error('own denied');e.code='EACCES';throw e;}return fs.lstatSync(file,...args);};f=await fixture(t,{fs:io});fs.mkdirSync(path.dirname(f.journalRoot),{recursive:true});await assert.rejects(f.build().verifyNativeExecutorStartup(f.level),/STARTUP_HOLD/);assert.equal(f.calls(),0);assert.equal(fs.existsSync(f.journalRoot),false);});
native('loaded inventory getters are refused without callbacks or a successful classification',async t=>{let getters=0;const f=await fixture(t,{load:()=>({createNativeExecutorJournal:()=>({inventory:()=>({get complete(){getters++;return true;}})})})});f.seedClosed();await assert.rejects(f.build().verifyNativeExecutorStartup(f.level),/STARTUP_HOLD/);assert.equal(getters,0);});
