import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {repo,stage,sha,deferred,tick} from './native-query-source-admission.test.mjs';
import job from './install-job-contract.cjs';
import dispatch from './native-dispatch-contract.cjs';
const HERE=path.dirname(fileURLToPath(import.meta.url));
const integration=(name,fn)=>test(name,{skip:repo?false:'Set VORTEX_EXTENSION_ADMISSION_REPO',timeout:15000},fn);
let factory;
async function fixtureFactory(){
 if(factory)return factory;
 const original=new URL('./native-main-executor-transport.test.mjs',import.meta.url);
 let text=fs.readFileSync(original,'utf8');
 const once=(a,b)=>{assert.equal(text.split(a).length,2,a);text=text.replace(a,b);};
 once("'native-main-executor-pending','native-main-executor-transport'];","'native-main-executor-pending','native-main-executor-transport','native-main-executor-continuation'];");
 once('reserveNativeExecutorTransport,prepareNativeExecutorTransportPending})','reserveNativeExecutorTransport,prepareNativeExecutorTransportPending,copyNativeExecutorTransport,registerNativeExecutorTransportCopied})');
 once("const prep=path.resolve(HERE,'../../../local-state/renderer-executor-transport/recovery/main/cases');", "const prep=path.resolve(HERE,'../../../local-state/native-coordinator/recovery/cases');");
 const start=text.indexOf('  base.backend.runAndReadAll=async'),end=text.indexOf('  const types=execute',start);assert(start>0&&end>start);
 text=text.slice(0,start)+`  base.backend.runAndReadAll=async(sql,params)=>{
   calls.push({sql,params:structuredClone(params)});await options.beforeRead?.(sql,params);const data=transaction??committed;let rows;
   if(sql.includes('AS exact_key'))rows=[...data].filter(([k])=>k===K||k.startsWith(K+'###')).slice(0,2).map(([k,v])=>[k===K,typeof v==='string'&&Buffer.byteLength(v)<=1024?Buffer.from(v).toString('hex').toUpperCase():null]);
   else if(sql.includes('SELECT 1 FROM keys'))rows=[];
   else if(sql.includes('CASE WHEN key IN')){const allowed=new Set(params.slice(1)),base=params[0];rows=[...data].filter(([k])=>k===base||k==='persistent###downloads'||k==='persistent###downloads###files'||[...allowed].some(x=>k===x||k.startsWith(x+'###'))||k===base+'###installed'||k.startsWith(base+'###installed###')).map(([k,v])=>[k,allowed.has(k)?v:null]).slice(0,8);}
   else if(sql.startsWith('SELECT DISTINCT CASE'))rows=[...new Set([...data.keys()].filter(k=>k.startsWith('persistent###downloads###files###')).map(k=>k.split('###')[3]))].map(id=>[id]);
   else if(sql.includes('length(key)<=512'))rows=[...data].filter(([k])=>{const p=k.split('###');return p[0]==='persistent'&&((p[1]==='mods'&&(p.length<=4||['archiveId','fileMD5'].includes(p[4])||(p[4]==='attributes'&&(p.length===5||p[5]==='fileMD5'))))||(p[1]==='downloads'&&p[2]==='files'&&(p.length<=4||['fileMD5','localPath'].includes(p[4]))));}).slice(0,40001);
   else{const wanted=new Set(params.slice(4)),base=params[3],prefix=params[0];rows=[...data].filter(([k])=>k.startsWith(prefix+'###')||wanted.has(k)||k===base||k===base+'###installed'||k.startsWith(base+'###installed###'));}
   return{getRows:()=>options.rows?options.rows(sql,rows,commits):rows};
  };
`+text.slice(end);
 text=text.replace(/(from\s*['"])(\.\/[^'"]+)(['"])/g,(_all,a,b,c)=>a+new URL(b,original).href+c).replaceAll('import.meta.url',JSON.stringify(original.href));
 const module=await import('data:text/javascript;base64,'+Buffer.from(text).toString('base64'));factory=module.createMainTransportFixture;return factory;
}
/** Actual Main/Level/Registry/pool and SDK parser/journal. SQL and physical relay
 * are explicit source fixtures, not actual database/process/custody acceptance. */
export async function createContinuationFixture(t,options={}){
 const make=await fixtureFactory(),calls=[],state={phase:'prepared'},h='a'.repeat(64);let context,receipt,proof;
 const req=createRequire(import.meta.url);
 const f=await make(t,{...options,realRelay:true,
  seed(args){const base='persistent###downloads###files###own-download';for(const[k,v]of Object.entries({state:'finished',game:['cyberpunk2077'],localPath:'own.zip',size:32,fileMD5:'b'.repeat(32)}))args.committed.set(base+'###'+k,JSON.stringify(v));options.seed?.(args);},
  load(file,actual){const module=actual(file);if(!file.endsWith('owned-zip-relay-client.mjs'))return module;return{...module,createBoundOwnedZipRelay(rb,ab,runtime){
   const request=dispatch.parseDispatchRequest(rb),binding={operationId:request.operationId,nativeJobId:request.nativeJobId,requestSHA256:dispatch.dispatchRequestDigest(rb),rendererGeneration:request.rendererGeneration};
   const root=path.join(JSON.parse(runtime).workspaceRoot,'local-state/vortex-agent-build/native-install-executor');
   const identity={schema:'win-file-id128/1',volumeSerialNumber:'1',fileId:'4'};
   const destination={parent:request.plan.context.stagingPath,leaf:request.plan.package.expectedModId,parentIdentity:identity,directoryIdentity:{...identity,fileId:'5'}};
   const workerTerminal={spawnObserved:true,exitObserved:false,closeObserved:false,childErrorObserved:false,childResourcesClosed:false,held:false};
   const sdk={phase:'copied',workerPid:4321,creationTime:'12345',workerLifetime:'worker_'+'4'.repeat(32),packetSHA256:'5'.repeat(64),destination,workerTerminal,copyProof:null};
   proof={schema:'owned-zip-copy-proof/1',workerLifetime:sdk.workerLifetime,binding,packetSHA256:sdk.packetSHA256,destination,
    files:[{path:'a.txt',bytes:1,sha256:h,sourceIdentity:{...identity,fileId:'6'},destinationIdentity:{...identity,fileId:'7'}}],copiedFiles:1,totalBytes:1,effectsAllowed:false,nativeInstallAccepted:false,persistenceVerified:false};
   const pb=module.relayCopyProofBytes(proof);sdk.copyProof={bytes:pb.length,sha256:sha(pb),files:1,totalBytes:1};
   const status=()=>({schema:'owned-zip-relay-owner-status/1',binding,mode:'staging',relayLifetime:'relay_'+'6'.repeat(32),relayPid:4320,startSHA256:'7'.repeat(64),startAttempted:true,startSent:true,cancelAttempted:false,handoffAttempted:state.phase==='copied',releaseAttempted:false,controllerEnded:false,phase:state.phase,relayTerminal:workerTerminal,sdk,errorCode:null,stderrObserved:false,effectsAllowed:false,nativeInstallAccepted:false,persistenceVerified:false});
   context={request,binding,sdk,proof,status,refreshProof(){const b=module.relayCopyProofBytes(proof);sdk.copyProof.bytes=b.length;sdk.copyProof.sha256=sha(b);}};
   return Object.freeze({async prepare(anchor){const journal=actual(path.join(path.dirname(file),'native-executor-journal.mjs')).createNativeExecutorJournal({root}),pending=journal.reservePending(rb,sdk.workerLifetime,sdk.packetSHA256,anchor);receipt={schema:'owned-zip-worker-prepared/1',binding,workerLifetime:sdk.workerLifetime,workerPid:4321,creationTime:'12345',packetSHA256:sdk.packetSHA256,transition:pending.transition};return receipt;},
    async startPrepared(){calls.push('start');await options.start?.(context);state.phase='accepted';return status();},
    async waitFor(phase){calls.push('wait:'+phase);await options.extracted?.(context);state.phase=phase;return status();},
    async handoff(){calls.push('handoff');await options.handoff?.(context);state.phase='copied';return status();},
    async copyProof(){calls.push('proof');await options.proof?.(context);return proof;},status(){options.status?.(context);return status();},
    cancel(){assert.fail('No automatic cancel');},release(){assert.fail('No worker release');}});
  }};}});
 return{...f,relayCalls:calls,relayState:state,context:()=>context,receipt:()=>receipt,
  async prepare(){const ticket=f.preflight();await f.wiring.reserveNativeExecutorTransport(ticket);await f.wiring.prepareNativeExecutorTransportPending(ticket,f.frameOwner);return ticket;},
  copy:ticket=>f.wiring.copyNativeExecutorTransport(ticket),register:ticket=>f.wiring.registerNativeExecutorTransportCopied(ticket)};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 test('continuation manifest pins exact transport and real terminal owner companion',()=>{const{m,patch}=stage('native-main-executor-continuation'),parent=stage('native-main-executor-transport').m,c=stage('native-main-executor-terminal-window').m;assert.equal(sha(patch),m.patchSHA256);assert.equal(m.inputSHA256,parent.outputSHA256);assert.equal(m.prerequisitePatchSHA256,parent.patchSHA256);assert.equal(m.requiredCompanionOutputSHA256,c.outputSHA256);for(const k of ['installed','effectsAllowed','nativeAdmission','installationPermit','nativeAcceptanceVerified'])assert.equal(m[k],false);});
 integration('prepared actual Main/journal advances through live copy proof to real tracked commit and terminal window without worker release',async t=>{
  const f=await createContinuationFixture(t),ticket=await f.prepare(),copied=await f.copy(ticket),observed=await f.register(ticket);
  assert.deepEqual(f.relayCalls,['start','wait:extracted','handoff','proof','proof']);assert.equal(observed.schema,'native-tracked-mod-registration-observed/2');assert.equal(observed.commitObserved,true);assert.equal(observed.trackedAssociationVerified,true);assert.equal(observed.trackedInstallComplete,false);assert.equal(observed.installationPermit,false);assert(!Object.hasOwn(observed,'owner'));
  const record=JSON.parse(observed.recordJSON),marker=record.attributes.__nmtNativeRegistration;assert.equal(marker.payloadSHA256,job.installPayloadDigest(f.request.plan));assert.equal(marker.archiveSHA256,f.request.plan.package.sha256);assert.equal(record.archiveId,'own-download');f.wiring.checkNativeExecutorTransport(ticket);
  assert.equal(f.committed.get('persistent###downloads###files###own-download###installed###modId'),'"own"');assert.equal(f.main.getNativeModPersistenceReservation().phase,'reserved');assert.equal(f.level.getNativeBackendWriteStatus().phase,'reserved');assert.equal(f.pool.getNativeSQLConnectionStatus().phase,'reserved');
  assert.throws(()=>f.main.checkNativeModPersistenceTarget(f.main.mNativeModPersistenceReservation.owner,'cyberpunk2077','own'));
 });
 integration('REGISTER before COPY refuses without START, SQL mutation or owner refund',async t=>{
  const f=await createContinuationFixture(t),ticket=await f.prepare(),n=f.calls.length;await assert.rejects(f.register(ticket));assert.deepEqual(f.relayCalls,[]);assert.equal(f.calls.length,n);assert.equal(f.main.getNativeModPersistenceReservation().phase,'held');await assert.rejects(f.copy(ticket));
 });
 integration('fake tickets cannot poison the genuine prepared continuation',async t=>{
  const f=await createContinuationFixture(t),ticket=await f.prepare();for(const fake of [{},Object.freeze({}),null,new Proxy(ticket,{get(){assert.fail('proxy');}})]){await assert.rejects(f.copy(fake));await assert.rejects(f.register(fake));}await f.copy(ticket);await f.register(ticket);
 });
 integration('COPY consumes once before asynchronous START and duplicate cannot start twice',async t=>{
  const gate=deferred(),f=await createContinuationFixture(t,{start:()=>gate.promise}),ticket=await f.prepare(),first=f.copy(ticket);first.catch(()=>{});await tick();await assert.rejects(f.copy(ticket));gate.resolve();await assert.rejects(first);assert.deepEqual(f.relayCalls,['start']);assert.equal(f.main.getNativeModPersistenceReservation().phase,'held');await assert.rejects(f.register(ticket));
 });
 integration('pending anchor drift refuses before START and preserves unknown reservation',async t=>{
  const f=await createContinuationFixture(t),ticket=await f.prepare(),old=JSON.parse(f.committed.get('nativeExecutorAnchorV1'));f.committed.set('nativeExecutorAnchorV1',JSON.stringify({...old,inventorySHA256:'f'.repeat(64)}));await assert.rejects(f.copy(ticket));assert.deepEqual(f.relayCalls,[]);assert.equal(f.main.getNativeModPersistenceReservation().phase,'held');
 });
 integration('invalid live proof path/hash/size and wrong destination never reach registration',async t=>{
  for(const [mutation,code]of [[c=>c.proof.files[0].path='other.txt','OWNED_ZIP_RELAY_COPY_PROOF_MISMATCH'],[c=>c.proof.files[0].sha256='f'.repeat(64),'OWNED_ZIP_RELAY_COPY_PROOF_MISMATCH'],[c=>c.proof.files[0].bytes=2,'OWNED_ZIP_RELAY_COPY_PROOF_MISMATCH'],[c=>c.proof.destination.parent+='-other','NATIVE_EXECUTOR_TRANSPORT_HELD'],[c=>c.proof.destination.leaf='other','NATIVE_EXECUTOR_TRANSPORT_HELD']]){
   const f=await createContinuationFixture(t,{proof:c=>{mutation(c);c.refreshProof();}}),ticket=await f.prepare();await assert.rejects(f.copy(ticket),error=>Object.getOwnPropertyDescriptor(error,'message')?.value===code);assert.equal(f.calls.filter(x=>x.sql.startsWith('INSERT INTO')&&x.params.some(p=>typeof p==='string'&&p.startsWith('persistent###mods'))).length,0);await assert.rejects(f.register(ticket));
  }
 });
 integration('worker death, proof drift, frame drift and source drift between stages refuse all registration writes',async t=>{
  for(const mode of ['worker','proof','frame','source']){const f=await createContinuationFixture(t),ticket=await f.prepare();await f.copy(ticket);const n=f.calls.filter(c=>c.sql.startsWith('INSERT INTO')).length;
   if(mode==='worker')f.context().sdk.workerTerminal.closeObserved=true;
   if(mode==='proof'){f.context().proof.files[0].sourceIdentity.fileId='99';f.context().refreshProof();}
   if(mode==='frame')f.frame.owner.rendererPID++;
   if(mode==='source')fs.appendFileSync(path.join(f.sdk,'paths-core.cjs'),'\n// changed own fixture');
   await assert.rejects(f.register(ticket));assert.equal(f.calls.filter(c=>c.sql.startsWith('INSERT INTO')).length,n);assert.equal(f.main.getNativeModPersistenceReservation().phase,'held');assert.equal(f.relayCalls.filter(x=>x==='start').length,1);
  }
 });
 integration('unknown START and copy failures preserve primary null/undefined without retry or cleanup',async t=>{
  for(const stage of ['start','handoff'])for(const primary of [null,undefined]){const f=await createContinuationFixture(t,{[stage]:()=>{throw primary;}}),ticket=await f.prepare();await f.copy(ticket).then(()=>assert.fail('unexpected COPY'),e=>assert.equal(e,primary));const n=f.relayCalls.length;await assert.rejects(f.copy(ticket));await assert.rejects(f.register(ticket));assert.equal(f.relayCalls.length,n);assert.equal(f.main.getNativeModPersistenceReservation().phase,'held');}
 });
 integration('registration unknown COMMIT retains committed rows and every source owner held',async t=>{
  for(const primary of [null,undefined]){let commits=0;const f=await createContinuationFixture(t,{afterRun:sql=>{if(sql==='COMMIT'&&++commits===3)throw primary;}}),ticket=await f.prepare();await f.copy(ticket);await f.register(ticket).then(()=>assert.fail('unexpected result'),e=>assert.equal(e,primary));assert(f.committed.has('persistent###mods###cyberpunk2077###own###id'));assert.equal(f.main.getNativeModPersistenceReservation().phase,'held');const n=f.calls.length;await assert.rejects(f.register(ticket));assert.equal(f.calls.length,n);assert.equal(f.calls.some(c=>c.sql==='ROLLBACK'),false);}
 });
 integration('caught reentry during live SDK callback cannot revive either continuation stage',async t=>{
  let f,ticket,entered=false;f=await createContinuationFixture(t,{proof:()=>{if(!entered){entered=true;void f.copy(ticket).catch(()=>{});}}});ticket=await f.prepare();await assert.rejects(f.copy(ticket));assert(entered);assert.equal(f.main.getNativeModPersistenceReservation().phase,'held');await assert.rejects(f.register(ticket));
 });
 integration('REGISTER consumes once while actual INSERT remains pending and observes its late failure',async t=>{
  const gate=deferred();let armed=false;const f=await createContinuationFixture(t,{beforeRun:sql=>armed&&sql.startsWith('INSERT INTO')?gate.promise:undefined}),ticket=await f.prepare();await f.copy(ticket);armed=true;const first=f.register(ticket);first.catch(()=>{});await tick();await assert.rejects(f.register(ticket));gate.reject(Error('owned delayed insert'));await assert.rejects(first);assert.equal(f.main.getNativeModPersistenceReservation().phase,'held');
 });

 integration('worker death during actual registration COMMIT refuses observation but preserves committed rows held',async t=>{
  let f,armed=false;f=await createContinuationFixture(t,{beforeRun:sql=>{if(armed&&sql==='COMMIT')f.context().sdk.workerTerminal.closeObserved=true;}});const ticket=await f.prepare();await f.copy(ticket);armed=true;await assert.rejects(f.register(ticket));assert(f.committed.has('persistent###mods###cyberpunk2077###own###id'));assert.equal(f.main.getNativeModPersistenceReservation().phase,'held');assert.equal(f.calls.some(c=>c.sql==='ROLLBACK'),false);await assert.rejects(f.register(ticket));
 });
 integration('worker loss after committed observation poisons later source checks before adoption',async t=>{
  const f=await createContinuationFixture(t),ticket=await f.prepare();await f.copy(ticket);await f.register(ticket);f.context().sdk.workerTerminal.closeObserved=true;assert.throws(()=>f.wiring.checkNativeExecutorTransport(ticket));assert.equal(f.main.getNativeModPersistenceReservation().phase,'held');assert(f.committed.has('persistent###mods###cyberpunk2077###own###id'));
 });

 integration('Python-normalized destination parent preserves reviewed Windows path aliases',async t=>{
  const f=await createContinuationFixture(t,{configureInputs:({request})=>{request.plan.context.stagingPath=request.plan.context.stagingPath.replaceAll('\\','/').replace(/^F:/,'f:');},handoff:c=>{c.proof.destination.parent=c.request.plan.context.stagingPath.replaceAll('/','\\').replace(/^[a-z]:/,d=>d.toUpperCase());c.refreshProof();}}),ticket=await f.prepare();
  const copied=await f.copy(ticket);assert.equal(copied.schema,'native-executor-copy-observed/1');
  assert.notEqual(f.request.plan.context.stagingPath,f.context().proof.destination.parent);assert.equal(path.win32.resolve(f.request.plan.context.stagingPath).toLowerCase(),path.win32.resolve(f.context().proof.destination.parent).toLowerCase());
  const result=await f.register(ticket);assert.equal(result.schema,'native-tracked-mod-registration-observed/2');
 });

}
