import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {createNativeExecutorJournal,appendNativeExecutorTerminalAnchored} from './native-executor-journal.mjs';
import job from './install-job-contract.cjs';
import dispatch from './native-dispatch-contract.cjs';
const HERE=path.dirname(fileURLToPath(import.meta.url));
const scratch=path.resolve(HERE,'../../../local-state/native-completion/recovery/journal-cases');
const hex=n=>n.toString(16).padStart(32,'0'),packet='d'.repeat(64),h='a'.repeat(64);
const encode=v=>Buffer.from(JSON.stringify(v)),sha=v=>crypto.createHash('sha256').update(v).digest('hex');
function request(n=1,j=n){const plan={schema:'install-job-plan/1',family:'tracked-new-disabled',contractId:job.CONTRACT_ID,
 context:{gameId:'cyberpunk2077',profileId:'fixture',gamePath:'F:/Fixture/Game',stagingPath:'F:/Fixture/Stage',downloadPath:'D:/Fixture/Downloads',filesystemIds:{gamePath:'1:2',stagingPath:'1:3',downloadPath:'2:4'}},
 package:{downloadId:'tracked',fileName:'Own.zip',expectedModId:'Own',expectedType:'',bytes:200,sha256:h,md5:'b'.repeat(32),expectedUncompressedBytes:10,payload:{'r6/scripts/own.reds':h}},
 evidence:{buildSHA256:h,sourceSHA256:h,nativeAdmissionSHA256:h},options:{enabled:false,deploy:false}};
 return{schema:'native-dispatch-request/1',contractId:dispatch.CONTRACT_ID,operationId:'op_'+hex(n),nativeJobId:'exec_'+hex(j),planId:job.installPlanId(plan),managerScope:'manager-fixture-1',rendererGeneration:'renderer_'+hex(1),admissionSHA256:'c'.repeat(64),plan};}
const binding=r=>({operationId:r.operationId,nativeJobId:r.nativeJobId,requestSHA256:dispatch.dispatchRequestDigest(encode(r)),packetSHA256:packet,workerLifetime:'worker_'+r.operationId.slice(3)});
const evidence=()=>({schema:'native-executor-terminal-evidence/2',outcome:'committed_adopted_worker_closed',fullRecordSHA256:'1'.repeat(64),registrationObservationSHA256:'2'.repeat(64),adoptionObservationSHA256:'3'.repeat(64),workerClosureObservationSHA256:'4'.repeat(64),ownershipHoldObservationSHA256:'5'.repeat(64)});
const anchor=store=>{const s=store.inventory();return encode({schema:'native-executor-anchor/1',rootId:s.observedRootId,inventorySHA256:s.observedInventorySHA256});};
function fixture(){fs.mkdirSync(scratch,{recursive:true});const workspace=fs.mkdtempSync(path.join(scratch,'run-')),root=path.join(workspace,'executor'),store=createNativeExecutorJournal({root});return{workspace,root,store};}
const begin=(f,r=request())=>{const b=binding(r);f.store.begin(encode(r),b.workerLifetime,packet);return b;};
const close=(f,b,seal=anchor(f.store))=>appendNativeExecutorTerminalAnchored(f.store,b,encode(evidence()),seal);
const terminalPath=(f,r=request())=>path.join(f.root,'terminals',r.operationId,'terminal.json');
function assertHeld(f){assert.throws(()=>f.store.begin(encode(request(99)),binding(request(99)).workerLifetime,packet),/TERMINAL_TRANSITION_HELD/);assert.throws(()=>close(f,binding(request())),/TERMINAL_TRANSITION_HELD/);}
function withFS(name,hook,body){const original=fs[name];fs[name]=(...args)=>hook(original,...args);try{return body();}finally{fs[name]=original;}}
function onTerminalDir(f,r,body,callback){let done=false;return withFS('mkdirSync',(original,file,...args)=>{if(!done&&String(file)===path.dirname(terminalPath(f,r))){done=true;callback();}return original(file,...args);},()=>{const result=body();assert(done);return result;});}

test('module helper preserves exact old six-method factory ABI and refuses foreign/proxy/getter journals inertly',()=>{
 const f=fixture();assert(Object.isFrozen(f.store));assert.deepEqual(Object.keys(f.store),['begin','read','appendTerminal','inventory','reservePending','provision']);
 let getters=0;const fake={get inventory(){getters++;throw Error('getter');}};
 for(const journal of [null,{},fake,Object.create(f.store),new Proxy(f.store,{get(){assert.fail('proxy');}})])assert.throws(()=>appendNativeExecutorTerminalAnchored(journal,binding(request()),encode(evidence()),Buffer.from('{}')),/INVALID_JOURNAL/);
 assert.equal(getters,0);assert.equal(fs.existsSync(f.root),false);const b=begin(f);assert.equal(close(f,b).operationId,b.operationId);
 assert.throws(()=>appendNativeExecutorTerminalAnchored(f.store,b,encode(evidence())),/INVALID_ARGUMENTS/);
 assert.throws(()=>appendNativeExecutorTerminalAnchored(f.store,b,encode(evidence()),Buffer.from('{}'),()=>assert.fail('callback')),/INVALID_ARGUMENTS/);
});

test('anchored B to C changes only one terminal and returns exactly ten historical transition fields',()=>{
 const f=fixture(),b=begin(f),before=anchor(f.store),transition=close(f,b,before);
 assert.deepEqual(Object.keys(transition),['schema','rootId','previousInventorySHA256','inventorySHA256','operationId','nativeJobId','requestSHA256','packetSHA256','workerLifetime','evidenceSHA256']);assert(Object.isFrozen(transition));
 assert.equal(transition.schema,'native-executor-terminal-transition/1');assert.equal(transition.previousInventorySHA256,JSON.parse(before).inventorySHA256);assert.equal(transition.evidenceSHA256,sha(encode(evidence())));
 const after=f.store.inventory({expectedRootId:transition.rootId,expectedInventorySHA256:transition.inventorySHA256});assert.equal(after.complete,true);assert.equal(after.historySealVerified,true);assert.equal(after.closedCount,1);assert.equal(after.unresolvedCount,0);assert.equal(after.startupHoldRequired,false);
 for(const key of ['effectsAllowed','installationPermit','independentCompletionVerified','currentStateVerified','canReplay','powerLossPersistenceVerified'])assert.equal(after[key],false,key);
 assert.equal(createNativeExecutorJournal({root:f.root}).inventory().closedCount,1);assert.deepEqual(fs.readdirSync(f.root).sort(),['jobs','operations','terminals']);
});

test('the genuine journal brand is local to the exact loaded module instance',async()=>{
 const f=fixture(),url=new URL('./native-executor-journal.mjs',import.meta.url);url.searchParams.set('own-fixture',crypto.randomBytes(6).toString('hex'));
 const other=await import(url.href),foreign=other.createNativeExecutorJournal({root:f.root});
 assert.throws(()=>appendNativeExecutorTerminalAnchored(foreign,binding(request()),encode(evidence()),Buffer.from('{}')),/INVALID_JOURNAL/);assert.equal(fs.existsSync(f.root),false);
 const b=binding(request());foreign.begin(encode(request()),b.workerLifetime,packet);
 const result=other.appendNativeExecutorTerminalAnchored(foreign,b,encode(evidence()),anchor(foreign));assert.equal(result.operationId,b.operationId);
});

test('old closed history and its exact file bytes survive a new terminal transition',()=>{
 const f=fixture(),r=request(1),b=begin(f,r);f.store.appendTerminal(b,encode(evidence()));const prior=fs.readFileSync(terminalPath(f,r));
 const next=begin(f,request(2)),result=close(f,next);assert.equal(result.operationId,request(2).operationId);assert.deepEqual(fs.readFileSync(terminalPath(f,r)),prior);assert.equal(f.store.inventory().closedCount,2);
});

test('two distinct jobs work on same journal while stale operation/job replays cannot poison the next known operation',()=>{
 const f=fixture(),first=begin(f),seal=anchor(f.store);close(f,first,seal);assert.throws(()=>close(f,first,seal),/TERMINAL_TRANSITION_CONSUMED/);
 const second=begin(f,request(2)),b=anchor(f.store);assert.throws(()=>close(f,{...second,nativeJobId:first.nativeJobId},b),/TERMINAL_TRANSITION_CONSUMED/);close(f,second,b);
 assert.equal(f.store.inventory().closedCount,2);const fresh=createNativeExecutorJournal({root:f.root});assert.throws(()=>appendNativeExecutorTerminalAnchored(fresh,first,encode(evidence()),anchor(fresh)),/TERMINAL_PREDECESSOR_MISMATCH/);
});

test('wrong root or stale census refuses before any terminal publication and makes unknown attempt sticky',()=>{
 for(const field of ['rootId','inventorySHA256']){const f=fixture(),b=begin(f),seal=JSON.parse(anchor(f.store));seal[field]=field==='rootId'?'9:9':'f'.repeat(64);assert.throws(()=>close(f,b,encode(seal)),/PREDECESSOR_NOT_SEALED/);assert.equal(fs.existsSync(path.dirname(terminalPath(f))),false);assertHeld(f);assert.equal(f.store.inventory().unresolvedCount,1);}
});

test('pure invalid byte/binding snapshots reject without getters, filesystem writes or poisoning valid input',()=>{
 const f=fixture(),b=begin(f),seal=anchor(f.store);let called=0;const getter={...b};Object.defineProperty(getter,'workerLifetime',{enumerable:true,get(){called++;throw Error('getter');}});
 for(const bad of [getter,new Proxy(b,{ownKeys(){assert.fail('proxy');}})])assert.throws(()=>appendNativeExecutorTerminalAnchored(f.store,bad,encode(evidence()),seal),/INVALID_BINDING/);
 for(const bad of [Buffer.from('{'),Buffer.concat([Buffer.from([239,187,191]),encode(evidence())]),new Uint8Array(new SharedArrayBuffer(20)),new Proxy(encode(evidence()),{})])assert.throws(()=>appendNativeExecutorTerminalAnchored(f.store,b,bad,seal),/INVALID_TERMINAL/);
 for(const bad of [Buffer.from('{}'),Buffer.concat([Buffer.from([239,187,191]),seal]),new Uint8Array(new SharedArrayBuffer(20)),new Proxy(seal,{})])assert.throws(()=>close(f,b,bad),/INVALID_ANCHOR/);
 const legacy={...evidence(),schema:'native-executor-terminal-evidence/1',outcome:'committed_adopted_closed'};delete legacy.ownershipHoldObservationSHA256;legacy.releaseObservationSHA256='5'.repeat(64);assert.throws(()=>appendNativeExecutorTerminalAnchored(f.store,b,encode(legacy),seal),/INVALID_TERMINAL/);
 assert.equal(called,0);assert.equal(fs.existsSync(path.dirname(terminalPath(f))),false);close(f,b,seal);
});

test('inputs detach before first filesystem callback and cannot change the reserved operation',()=>{
 const f=fixture(),b=begin(f),ev=encode(evidence()),seal=anchor(f.store),expected=b.operationId;let armed=true;
 const result=withFS('lstatSync',(original,...args)=>{if(armed){armed=false;b.operationId=request(9).operationId;ev.fill(0);seal.fill(0);}return original(...args);},()=>appendNativeExecutorTerminalAnchored(f.store,b,ev,seal));
 assert.equal(result.operationId,expected);assert.equal(ev.every(v=>v===0),true);assert.equal(seal.every(v=>v===0),true);
});

test('one matching pending row is mandatory, including exact lifetime and no extra unresolved operation',()=>{
 for(const mode of ['binding','extra','alreadyClosed']){const f=fixture(),b=begin(f);if(mode==='extra')begin(f,request(2));if(mode==='alreadyClosed')f.store.appendTerminal(b,encode(evidence()));const seal=anchor(f.store);assert.throws(()=>close(f,mode==='binding'?{...b,workerLifetime:'worker_'+hex(3)}:b,seal),/TERMINAL_PREDECESSOR_MISMATCH/);assertHeld(f);}
});

test('self-consistent raw rewrite of any prior intent, job or terminal cannot be blessed by a new census',()=>{
 for(const type of ['intent','job','terminal']){const f=fixture(),old=request(1),first=begin(f,old);f.store.appendTerminal(first,encode(evidence()));const next=request(2),b=begin(f,next),seal=anchor(f.store);
 const file=type==='intent'?path.join(f.root,'operations',old.operationId,'intent.json'):type==='job'?path.join(f.root,'jobs',old.nativeJobId,'binding.json'):terminalPath(f,old);
 let published=false,rootReads=0,changed=false;const link=fs.linkSync,open=fs.opendirSync;
 fs.linkSync=(from,to,...args)=>{const value=link(from,to,...args);if(String(to)===terminalPath(f,next))published=true;return value;};
 fs.opendirSync=(dir,...args)=>{if(published&&String(dir)===f.root&&++rootReads===3){changed=true;const value=JSON.parse(fs.readFileSync(file));fs.writeFileSync(file,JSON.stringify(Object.fromEntries(Object.entries(value).reverse()))+'\n');}return open(dir,...args);};
 try{assert.throws(()=>close(f,b,seal),/TERMINAL_TRANSITION_CHANGED/);}finally{fs.linkSync=link;fs.opendirSync=open;}assert(changed);
 assertHeld(f);const seen=createNativeExecutorJournal({root:f.root}).inventory({expectedRootId:JSON.parse(seal).rootId,expectedInventorySHA256:JSON.parse(seal).inventorySHA256});assert.equal(seen.historySealVerified,false);assert.equal(seen.complete,true);assert.equal(seen.closedCount,2);
 }
});

test('concurrent addition from another actual journal instance and unexpected index additions remain held',()=>{
 for(const mode of ['operation','index']){const f=fixture(),r=request(),b=begin(f),seal=anchor(f.store);
 onTerminalDir(f,r,()=>assert.throws(()=>close(f,b,seal),/NATIVE_EXECUTOR_/),()=>{if(mode==='operation'){const other=createNativeExecutorJournal({root:f.root}),extra=request(3);other.begin(encode(extra),binding(extra).workerLifetime,packet);}else fs.mkdirSync(path.join(f.root,'unexpected'));});assertHeld(f);
 }
});

test('the new target terminal must retain the exact bytes published by this writer',()=>{
 const f=fixture(),b=begin(f),seal=anchor(f.store);let published=false,rootReads=0,changed=false;const link=fs.linkSync,open=fs.opendirSync;
 fs.linkSync=(from,to,...args)=>{const value=link(from,to,...args);if(String(to)===terminalPath(f))published=true;return value;};
 fs.opendirSync=(dir,...args)=>{if(published&&String(dir)===f.root&&++rootReads===3){changed=true;const value=JSON.parse(fs.readFileSync(terminalPath(f)));fs.writeFileSync(terminalPath(f),JSON.stringify(Object.fromEntries(Object.entries(value).reverse()))+'\n');}return open(dir,...args);};
 try{assert.throws(()=>close(f,b,seal),/TERMINAL_TRANSITION_CHANGED/);}finally{fs.linkSync=link;fs.opendirSync=open;}assert(changed);assertHeld(f);assert.equal(createNativeExecutorJournal({root:f.root}).inventory().complete,true);
});

test('wrong target terminal and partial publication cannot be retried even with the fresh observed census',()=>{
 for(const name of ['writeFileSync','fsyncSync','linkSync','unlinkSync']){const f=fixture(),b=begin(f),seal=anchor(f.store);let fired=false;
 withFS(name,(original,...args)=>{if(!fired){fired=true;throw Error('own injected terminal fault');}return original(...args);},()=>assert.throws(()=>close(f,b,seal),/NATIVE_EXECUTOR_/));assert(fired);assertHeld(f);assert.equal(fs.existsSync(path.join(f.root,'operations',b.operationId,'intent.json')),true);assert.equal(fs.existsSync(path.join(f.root,'jobs',b.nativeJobId,'binding.json')),true);
 }
 const f=fixture(),b=begin(f),seal=anchor(f.store);onTerminalDir(f,request(),()=>assert.throws(()=>close(f,b,seal),/NATIVE_EXECUTOR_/),()=>{fs.mkdirSync(path.dirname(terminalPath(f)));const value={schema:'wrong'};fs.writeFileSync(terminalPath(f),encode(value));});assertHeld(f);
});

test('reentrant module helper poisons outer attempt even when the callback catches its refusal',()=>{
 const f=fixture(),r=request(),b=begin(f),seal=anchor(f.store);let seen=false;
 withFS('lstatSync',(original,...args)=>{if(!seen){seen=true;assert.throws(()=>close(f,b,seal),/TERMINAL_TRANSITION_BUSY/);}return original(...args);},()=>assert.throws(()=>close(f,b,seal),/TERMINAL_TRANSITION_HELD/));assert(seen);assertHeld(f);assert.equal(fs.existsSync(path.dirname(terminalPath(f))),false);
});

test('public writers cannot use the private anchored token or create history during its active window',()=>{
 for(const operation of ['begin','reservePending','appendTerminal','provision']){const f=fixture(),b=begin(f),seal=anchor(f.store),extra=request(2);let seen=false;
 withFS('lstatSync',(original,...args)=>{if(!seen){seen=true;assert.throws(()=>operation==='begin'?f.store.begin(encode(extra),binding(extra).workerLifetime,packet):operation==='reservePending'?f.store.reservePending(encode(extra),binding(extra).workerLifetime,packet,seal):operation==='appendTerminal'?f.store.appendTerminal(b,encode(evidence()),{}):f.store.provision(),/TERMINAL_TRANSITION_BUSY/);}return original(...args);},()=>assert.throws(()=>close(f,b,seal),/TERMINAL_TRANSITION_HELD/));assert(seen);assertHeld(f);assert.equal(fs.existsSync(path.join(f.root,'operations',extra.operationId)),false);
 }
});

test('anchored entry cannot interrupt an already active public writer and claim a clean B to C transition',()=>{
 const f=fixture(),b=begin(f),seal=anchor(f.store),extra=request(2);let seen=false;
 withFS('lstatSync',(original,...args)=>{if(!seen){seen=true;assert.throws(()=>close(f,b,seal),/TERMINAL_TRANSITION_BUSY/);}return original(...args);},()=>{try{f.store.begin(encode(extra),binding(extra).workerLifetime,packet);}catch(error){assert.match(error.message,/NATIVE_EXECUTOR_/);}});assert(seen);assertHeld(f);assert.equal(fs.existsSync(terminalPath(f)),false);
});
