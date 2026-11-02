// Real own-filesystem journals only. No DB, worker, process or installed state.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import dispatch from './native-dispatch-contract.cjs';
import intake from './native-tracked-intake-contract.cjs';
import job from './install-job-contract.cjs';
import {createNativeExecutorJournal,lookupNativeTrackedRequest,appendNativeExecutorTerminalAnchored} from './native-executor-journal.mjs';
import {createNativeIntentJournal} from './native-intent-journal.mjs';

const HERE=path.dirname(fileURLToPath(import.meta.url));
const REPO=path.resolve(HERE,'../../..');
const LOCAL_STATE=path.join(REPO,'local-state');
const SCRATCH=path.join(LOCAL_STATE,'native-tracked-request-tests');
const bytes=value=>Buffer.from(JSON.stringify(value));
const h='a'.repeat(64),packet='b'.repeat(64),worker='worker_'+'4'.repeat(32);
const publicId='request_0001';
function request(requestId=publicId,revision=0,generation=1){
  const plan={schema:'install-job-plan/1',family:'tracked-new-disabled',contractId:job.CONTRACT_ID,
    context:{gameId:'cyberpunk2077',profileId:'fixture',gamePath:'F:/Fixture/Game',stagingPath:'F:/Fixture/Stage',
      downloadPath:'D:/Fixture/Downloads',filesystemIds:{gamePath:'1:2',stagingPath:'1:3',downloadPath:'2:4'}},
    package:{downloadId:'tracked',fileName:revision?'OwnChanged.zip':'Own.zip',expectedModId:revision?'OwnChanged':'Own',expectedType:'',bytes:200,
      sha256:h,md5:'c'.repeat(32),expectedUncompressedBytes:10,payload:{'r6/scripts/own.reds':h}},
    evidence:{buildSHA256:h,sourceSHA256:h,nativeAdmissionSHA256:h},options:{enabled:false,deploy:false}};
  return {schema:'native-dispatch-request/1',contractId:dispatch.CONTRACT_ID,
    ...dispatch.deriveNativeTrackedRequestIds(requestId),planId:job.installPlanId(plan),
    managerScope:'manager-fixture-'+generation,rendererGeneration:'renderer_'+generation.toString(16).padStart(32,'0'),
    admissionSHA256:h,plan};
}
function fixture(){
  assert.equal(path.relative(REPO,HERE),path.join('tools','modding','vortex-agent'),
    'run the public test from its canonical tools location, not a private proposal copy');
  assert.equal(path.dirname(LOCAL_STATE),REPO);assert.equal(path.dirname(SCRATCH),LOCAL_STATE);
  const canonical=value=>process.platform==='win32'?path.resolve(value).toLowerCase():path.resolve(value);
  const ordinary=directory=>{
    const stat=fs.lstatSync(directory,{bigint:true});
    assert(stat.isDirectory()&&!stat.isSymbolicLink(),'ordinary directory required');
    assert.equal(canonical(fs.realpathSync.native(directory)),canonical(directory),'redirected directory refused');
    return `${stat.dev}:${stat.ino}`;
  };
  const pins=new Map();
  for(let parent=HERE;;parent=path.dirname(parent)){
    pins.set(parent,ordinary(parent));
    if(parent===path.dirname(parent))break;
  }
  const check=()=>{for(const [directory,id]of pins)assert.equal(ordinary(directory),id,'ancestor identity drift');};
  for(const directory of [LOCAL_STATE,SCRATCH]){
    check();
    try{ordinary(directory);}catch(error){
      if(error.code!=='ENOENT')throw error;
      check();
      try{fs.mkdirSync(directory,{mode:0o700});}catch(createError){if(createError.code!=='EEXIST')throw createError;}
    }
    pins.set(directory,ordinary(directory));check();
  }
  check();
  const workspace=fs.mkdtempSync(path.join(SCRATCH,'run-')),root=path.join(workspace,'executor');
  assert.equal(path.dirname(workspace),SCRATCH);ordinary(workspace);check();
  return {workspace,root,store:createNativeExecutorJournal({root})};
}
const anchor=transition=>bytes({schema:'native-executor-anchor/1',rootId:transition.rootId,
  inventorySHA256:transition.inventorySHA256});
function observedFixtureAnchor(store){
  // Only fixture setup uses its own observed inventory as the trusted input;
  // production must use the separately acknowledged Main anchor, never this.
  const snapshot=store.inventory();assert(snapshot.complete);
  return bytes({schema:'native-executor-anchor/1',rootId:snapshot.observedRootId,
    inventorySHA256:snapshot.observedInventorySHA256});
}
function pending(f,r=request()){
  const A=bytes(f.store.provision().anchor);
  const result=f.store.reservePending(bytes(r),worker,packet,A);
  return {A,B:anchor(result.transition),r};
}
function closed(f,r=request()){
  const p=pending(f,r);
  const binding={operationId:r.operationId,nativeJobId:r.nativeJobId,
    requestSHA256:dispatch.dispatchRequestDigest(bytes(r)),packetSHA256:packet,workerLifetime:worker};
  const evidence={schema:'native-executor-terminal-evidence/3',outcome:'prepared_no_start_cancelled_worker_closed',
    inertCancelObservationSHA256:'1'.repeat(64),workerClosureObservationSHA256:'2'.repeat(64),ownershipHoldObservationSHA256:'3'.repeat(64)};
  const transition=appendNativeExecutorTerminalAnchored(f.store,binding,bytes(evidence),p.B);
  return {...p,C:anchor(transition)};
}
function snapshot(root){
  if(!fs.existsSync(root))return [];
  const result=[];
  const visit=(dir,prefix='')=>{for(const name of fs.readdirSync(dir).sort()){
    const file=path.join(dir,name),relative=prefix+name,stat=fs.lstatSync(file);
    assert(!stat.isSymbolicLink());
    if(stat.isDirectory()){result.push([relative+'/']);visit(file,relative+'/');}
    else result.push([relative,crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')]);
  }};
  visit(root);return result;
}
function noPermit(value){
  for(const key of ['canReplay','effectsAllowed','installationPermit','nativeAdmission','powerLossPersistenceVerified'])assert.equal(value[key],false,key);
  assert.equal(value.historicalOnly,true);assert.equal(value.reconcileRequired,true);
}
const lookup=(f,expectedAnchor,r=request())=>lookupNativeTrackedRequest(f.store,publicId,r.planId,expectedAnchor);

test('request ID owner is dispatch; intake delegates the same stable domain-separated function',()=>{
  assert.equal(intake.deriveNativeTrackedRequestIds,dispatch.deriveNativeTrackedRequestIds);
  const ids=dispatch.deriveNativeTrackedRequestIds(publicId);
  assert(Object.isFrozen(ids));assert.deepEqual(Object.keys(ids),['operationId','nativeJobId']);
  const expected=message=>crypto.createHash('sha256').update(message).digest('hex').slice(0,32);
  assert.equal(ids.operationId,'op_'+expected('["native-tracked-request-operation/1","request_0001"]'));
  assert.equal(ids.nativeJobId,'exec_'+expected('["native-tracked-request-job/1","request_0001"]'));
  assert.notEqual(ids.operationId.slice(3),ids.nativeJobId.slice(5));
  assert.deepEqual(request(publicId,0,1).operationId,request(publicId,1,9).operationId);
  assert.equal(request(publicId,0,1).nativeJobId,request(publicId,1,9).nativeJobId);
  assert.notDeepEqual(ids,dispatch.deriveNativeTrackedRequestIds('REQUEST_0001'));
});

test('invalid ID primitives/proxies cannot invoke coercion or accept an unused salt',()=>{
  let calls=0;
  const proxy=new Proxy({},{get(){calls++;throw Error('COERCION');}});
  for(const value of [proxy,null,123,'short','a'.repeat(81),'request_0001\n','request/0001','request_é001'])
    assert.throws(()=>dispatch.deriveNativeTrackedRequestIds(value),/NATIVE_DISPATCH_INVALID_REQUEST_ID/);
  assert.throws(()=>dispatch.deriveNativeTrackedRequestIds(publicId,'salt'),/NATIVE_DISPATCH_INVALID_REQUEST_ID/);
  assert.equal(calls,0);
  for(const requestId of ['________','--------','0'.repeat(80)])assert.match(dispatch.deriveNativeTrackedRequestIds(requestId).operationId,/^op_[a-f0-9]{32}$/);
  const r=request();assert.throws(()=>intake.validateTrackedIntake({schema:intake.SCHEMA,requestId:'bad\n',plan:r.plan}),/NATIVE_TRACKED_INTAKE_INVALID/);
});

test('null anchor on a missing root returns inert metadata and creates no path',()=>{
  const f=fixture(),result=lookup(f,null);noPermit(result);
  assert.equal(result.state,'not_observed');assert.equal(result.historySealVerified,false);
  assert.equal(result.startupHoldRequired,true);assert.equal(fs.existsSync(f.root),false);
  assert.deepEqual(Object.keys(f.store),['begin','read','appendTerminal','inventory','reservePending','provision']);
});

test('existing empty root requires its exact independently supplied fixture anchor',()=>{
  const f=fixture(),A=bytes(f.store.provision().anchor),before=snapshot(f.root);
  assert.equal(lookup(f,null).state,'held');
  const found=lookup(f,A);assert.equal(found.state,'not_observed');assert.equal(found.historySealVerified,true);noPermit(found);
  assert.deepEqual(snapshot(f.root),before);
  for(const patch of [{rootId:'1:2'},{inventorySHA256:'0'.repeat(64)}]){
    const bad=bytes({...JSON.parse(A),...patch}),result=lookup(f,bad);assert.equal(result.state,'held');assert.equal(result.historySealVerified,false);noPermit(result);
  }
});

test('pending lookup after lost consumer reply uses stored runtime hashes and never reserves again',()=>{
  const f=fixture(),r=request(),{A,B}=pending(f,r),before=snapshot(f.root);
  const restarted={...f,store:createNativeExecutorJournal({root:f.root})};
  assert.equal(lookup(restarted,A).state,'held','old acknowledged anchor cannot bless the new inventory');
  const later=request(publicId,0,9),found=lookup(restarted,B,later);
  assert.equal(found.state,'reserved');assert.equal(found.startupHoldRequired,true);noPermit(found);
  assert.equal(found.requestSHA256,dispatch.dispatchRequestDigest(bytes(r)));
  assert.notEqual(found.requestSHA256,dispatch.dispatchRequestDigest(bytes(later)));
  assert.deepEqual(snapshot(f.root),before);
});

test('restarted closed operation returns historical metadata; changed plan conflicts on the SAME IDs',()=>{
  const f=fixture(),{C,r}=closed(f),before=snapshot(f.root);
  const restarted={...f,store:createNativeExecutorJournal({root:f.root})};
  const same=lookup(restarted,C,request(publicId,0,8));noPermit(same);
  assert.equal(same.state,'historical_closed');assert.equal(same.planId,r.planId);assert.equal(same.historySealVerified,true);
  const conflict=lookup(restarted,C,request(publicId,1,8));noPermit(conflict);
  assert.equal(conflict.state,'conflict');assert.equal(conflict.planId,r.planId);
  assert.equal(conflict.operationId,same.operationId);assert.equal(conflict.nativeJobId,same.nativeJobId);
  assert.deepEqual(snapshot(f.root),before);
});

test('intent-only and reservation-only remain held, without allocating replacement IDs',()=>{
  const f=fixture(),r=request();f.store.provision();
  createNativeIntentJournal({root:path.join(f.root,'operations')}).begin(bytes(r));
  let found=lookup(f,observedFixtureAnchor(f.store));assert.equal(found.state,'held');assert.equal(found.code,'NATIVE_EXECUTOR_LOOKUP_PARTIAL');noPermit(found);
  const g=fixture();pending(g,r);
  // Preserve the intentionally removed index outside this synthetic executor.
  fs.renameSync(path.join(g.root,'operations',r.operationId),path.join(g.workspace,'retained-intent-index'));
  const restarted={...g,store:createNativeExecutorJournal({root:g.root})};
  found=lookup(restarted,observedFixtureAnchor(restarted.store));assert.equal(found.state,'held');noPermit(found);
  assert.equal(found.operationId,r.operationId);assert.equal(found.nativeJobId,r.nativeJobId);
});

test('empty partial publication and corrupt record cannot become not_observed',()=>{
  const f=fixture(),r=request(),{B}=pending(f,r);
  fs.renameSync(path.join(f.root,'jobs',r.nativeJobId,'binding.json'),path.join(f.workspace,'retained-binding.json'));
  const restarted={...f,store:createNativeExecutorJournal({root:f.root})};
  const found=lookup(restarted,B);assert.equal(found.state,'held');assert.equal(found.historySealVerified,false);noPermit(found);
  const g=fixture(),{C}=closed(g);
  fs.writeFileSync(path.join(g.root,'operations',r.operationId,'intent.json'),'{broken fixture');
  const corrupt=lookup(g,C);assert.equal(corrupt.state,'held');noPermit(corrupt);
});

test('different real journal clients cannot overwrite an existing operation with another plan',()=>{
  const f=fixture(),{B}=pending(f),before=snapshot(f.root),other=createNativeExecutorJournal({root:f.root});
  assert.throws(()=>other.begin(bytes(request(publicId,1,2)),worker,packet),/NATIVE_EXECUTOR_/);
  const found=lookupNativeTrackedRequest(other,publicId,request(publicId,1,2).planId,B);
  assert.equal(found.state,'conflict');noPermit(found);assert.deepEqual(snapshot(f.root),before);
});

test('lost publication close reply retains the intent hold instead of refunding deterministic IDs',()=>{
  const f=fixture(),r=request(),A=bytes(f.store.provision().anchor);
  const open=fs.openSync,close=fs.closeSync,pendingFDs=new Set();let interrupted=false;
  fs.openSync=function(name,...args){const fd=open.call(this,name,...args);if(String(name).includes('.intent.json.pending-'))pendingFDs.add(fd);return fd;};
  fs.closeSync=function(fd){const result=close.call(this,fd);if(pendingFDs.delete(fd)&&!interrupted){interrupted=true;throw Error('MODEL_CLOSE_REPLY_LOST');}return result;};
  try{assert.throws(()=>f.store.begin(bytes(r),worker,packet),/NATIVE_EXECUTOR_/);}finally{fs.openSync=open;fs.closeSync=close;}
  assert(interrupted);assert(fs.existsSync(path.join(f.root,'operations',r.operationId,'intent.json')));
  const restarted={...f,store:createNativeExecutorJournal({root:f.root})};
  assert.equal(lookup(restarted,A).state,'held');
  const found=lookup(restarted,observedFixtureAnchor(restarted.store));
  assert.equal(found.state,'held');assert.equal(found.code,'NATIVE_EXECUTOR_LOOKUP_PARTIAL');noPermit(found);
  assert.equal(found.operationId,r.operationId);assert.equal(found.nativeJobId,r.nativeJobId);
});

test('an existing operation ID bound to another job cannot be adopted as this public request',()=>{
  const f=fixture(),r=request('other_request');r.operationId=request().operationId;
  const {B}=pending(f,r),found=lookup(f,B);
  assert.equal(found.state,'held');assert.equal(found.code,'NATIVE_EXECUTOR_LOOKUP_ID_CONFLICT');noPermit(found);
});

test('foreign journal and malformed bytes fail before reading any filesystem or invoking getters',()=>{
  let calls=0;
  const foreign=Object.defineProperty({},'inventory',{get(){calls++;throw Error('GETTER');}});
  const proxy=new Proxy(foreign,{get(){calls++;throw Error('TRAP');}});
  for(const journal of [foreign,proxy])assert.throws(()=>lookupNativeTrackedRequest(journal,publicId,request().planId,null),/INVALID_JOURNAL/);
  assert.equal(calls,0);
  const f=fixture();assert.throws(()=>lookupNativeTrackedRequest(f.store,publicId,request().planId),/INVALID_ARGUMENTS/);
  assert.throws(()=>lookup(f,Buffer.from('{}')),/INVALID_ANCHOR/);
  assert.equal(fs.existsSync(f.root),false);
});

test('caller anchor bytes are detached before the first filesystem collaborator',()=>{
  const f=fixture(),{C}=closed(f),copy=Buffer.from(C),stat=fs.lstatSync;
  let changed=false;
  fs.lstatSync=function(...args){if(!changed){changed=true;copy.fill(0);}return stat.apply(this,args);};
  let found;try{found=lookup(f,copy);}finally{fs.lstatSync=stat;}
  assert(changed);assert.equal(found.state,'historical_closed');assert.equal(found.historySealVerified,true);
});

test('namespace mutation after the stored request read is caught by the second anchored census',()=>{
  const f=fixture(),{C,r}=closed(f);
  const files=new Map([[path.join(f.root,'jobs',r.nativeJobId,'binding.json'),'binding'],
    [path.join(f.root,'operations',r.operationId,'intent.json'),'intent'],
    [path.join(f.root,'terminals',r.operationId,'terminal.json'),'terminal']]);
  const open=fs.openSync,close=fs.closeSync,opendir=fs.opendirSync,tracked=new Map();
  const counts={binding:0,intent:0,terminal:0},trace=[];let storedBindingClosed=false,mutated=false;
  fs.openSync=function(name,...args){const fd=open.call(this,name,...args),kind=files.get(name);
    if(kind){const label=kind+':'+(++counts[kind]);tracked.set(fd,label);trace.push('open:'+label);}return fd;};
  fs.closeSync=function(fd){const result=close.call(this,fd),label=tracked.get(fd);
    if(label){tracked.delete(fd);trace.push('close:'+label);if(label==='binding:3')storedBindingClosed=true;}return result;};
  fs.opendirSync=function(name,...args){
    if(name===f.root&&storedBindingClosed&&!mutated){
      // The first census reads each record twice. read() then opens intent and
      // binding a third time. It never enumerates the ROOT: the next root
      // enumeration is therefore the second anchored census after read returns.
      assert.deepEqual(counts,{binding:3,intent:3,terminal:2});
      for(const kind of ['binding','intent','terminal'])assert(trace.includes('close:'+kind+':2'));
      assert(trace.indexOf('open:intent:3')>trace.indexOf('close:terminal:2'));
      assert(trace.indexOf('open:binding:3')>trace.indexOf('close:intent:3'));
      trace.push('second-census-root-enumeration');
      fs.writeFileSync(path.join(f.root,'Unexpected.fixture'),'own mutation');mutated=true;
    }
    return opendir.call(this,name,...args);
  };
  let found;try{found=lookup(f,C);}finally{fs.openSync=open;fs.closeSync=close;fs.opendirSync=opendir;}
  assert(mutated);assert.equal(trace.at(-1),'second-census-root-enumeration');
  assert.equal(found.code,'NATIVE_EXECUTOR_LOOKUP_CHANGED');
  assert.equal(found.state,'held');assert.equal(found.historySealVerified,false);noPermit(found);
});

test('reentrant read-only lookup cannot replace outer lookup or alter immutable records',()=>{
  const f=fixture(),{C}=closed(f),before=snapshot(f.root),stat=fs.lstatSync;
  let nested,once=false;
  fs.lstatSync=function(...args){if(!once){once=true;nested=lookup(f,C);}return stat.apply(this,args);};
  let found;try{found=lookup(f,C);}finally{fs.lstatSync=stat;}
  assert.equal(nested.state,'held');assert.equal(nested.code,'NATIVE_EXECUTOR_LOOKUP_BUSY');
  assert.equal(found.state,'historical_closed');assert.deepEqual(snapshot(f.root),before);
});

test('lookup during actual journal writes returns busy without poisoning the outer writer',()=>{
  for(const stage of ['provision','begin','reservePending','appendTerminal']){
    const f=fixture(),r=request();let selected=null;
    if(stage!=='provision')selected=bytes(f.store.provision().anchor);
    if(stage==='appendTerminal')selected=anchor(f.store.reservePending(bytes(r),worker,packet,selected).transition);
    const stat=fs.lstatSync;let nested,once=false;
    fs.lstatSync=function(...args){
      if(!once){once=true;nested=lookupNativeTrackedRequest(f.store,publicId,r.planId,selected);}
      return stat.apply(this,args);
    };
    let result;
    try{
      if(stage==='provision')result=f.store.provision();
      else if(stage==='begin')result=f.store.begin(bytes(r),worker,packet);
      else if(stage==='reservePending')result=f.store.reservePending(bytes(r),worker,packet,selected);
      else result=appendNativeExecutorTerminalAnchored(f.store,{operationId:r.operationId,nativeJobId:r.nativeJobId,
        requestSHA256:dispatch.dispatchRequestDigest(bytes(r)),packetSHA256:packet,workerLifetime:worker},
        bytes({schema:'native-executor-terminal-evidence/3',outcome:'prepared_no_start_cancelled_worker_closed',
          inertCancelObservationSHA256:'1'.repeat(64),workerClosureObservationSHA256:'2'.repeat(64),
          ownershipHoldObservationSHA256:'3'.repeat(64)}),selected);
    }finally{fs.lstatSync=stat;}
    assert(once,stage);assert(result,stage);noPermit(nested);
    assert.equal(nested.state,'held',stage);assert.equal(nested.code,'NATIVE_EXECUTOR_LOOKUP_BUSY',stage);
    assert.equal(nested.historySealVerified,false,stage);
    const actual=f.store.inventory();assert.equal(actual.complete,true,stage);
    assert.equal(actual.records.length,stage==='provision'?0:1,stage);
    if(stage==='appendTerminal')assert.equal(actual.records[0].state,'historical_closed');
    else if(stage!=='provision')assert.equal(actual.records[0].reason,'terminal_missing');
  }
});
