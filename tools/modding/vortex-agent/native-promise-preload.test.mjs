// Root-only source VM tests. Actual pinned Preload AST + actual Zone0.15.1.
// Electron IPC is a controlled in-memory collaborator; no app/Main/SDK loaded.
import test from 'node:test';import assert from 'node:assert/strict';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';import {types} from 'node:util';
import {nativePromiseFixturesAvailable,nativePromiseFixtureReason,nativePromiseSourceFixture} from './native-promise-source-fixture.mjs';
if(!nativePromiseFixturesAvailable){test('native preload Promise source/Zone acceptance inputs',{skip:nativePromiseFixtureReason},()=>{});}else{
const {preload:source,ts,zone}=nativePromiseSourceFixture();
const sf=ts.createSourceFile('actual-preload.ts',source,ts.ScriptTarget.Latest,true),selected=sf.statements.filter(n=>ts.isFunctionDeclaration(n)&&/^native(?:Executor|Execution|Cancellation)/.test(n.name?.text??'')||ts.isVariableStatement(n)&&n.declarationList.declarations.some(d=>/^native(?:Executor|Execution|Cancellation)/.test(d.name.getText(sf))));
assert(selected.some(n=>n.getText(sf).includes('function nativeExecutorRegisterReceiver')));assert(selected.some(n=>n.getText(sf).includes('function nativeExecutionRegisterReceiver')));assert(selected.some(n=>n.getText(sf).includes('function nativeCancellationRegisterReceiver')));
const actual=stripTypeScriptTypes(selected.map(n=>n.getText(sf)).join('\n'),{mode:'transform'});
const tick=()=>new Promise(r=>setImmediate(r));
const names={prepare:['nativeExecutorRegisterReceiver','persist:native-executor-challenge','persist:native-executor-response','acquired'],execute:['nativeExecutionRegisterReceiver','persist:native-executor-execution-challenge','persist:native-executor-execution-response','checked'],cancel:['nativeCancellationRegisterReceiver','persist:native-executor-cancellation-challenge','persist:native-executor-cancellation-response','prepared']};
function challenge(kind){
 const b={transportId:'transport_'+'1'.repeat(32),challengeId:'challenge_'+'2'.repeat(32),requestSHA256:'3'.repeat(64),requestBytesSHA256:'4'.repeat(64),archiveBytesSHA256:'5'.repeat(64),operationId:'op_'+'6'.repeat(32),nativeJobId:'exec_'+'7'.repeat(32),gameId:'cyberpunk2077',modId:'fixture-one',profileId:'fixture-profile',managerScope:'manager-fixture-1',rendererGeneration:'renderer_'+'8'.repeat(32)};
 if(kind==='prepare')return{schema:'native-executor-challenge/1',...b,round:1,stage:'acquire'};
 if(kind==='execute')return{schema:'native-executor-execution-challenge/1',...b,executionId:'execution_'+'9'.repeat(32),sequence:1,stage:'check-preparation-before-start',payloadJSON:null};
 return{schema:'native-executor-cancellation-challenge/1',...b,cancellationId:'cancellation_'+'9'.repeat(32),sequence:1,stage:'prepare-inert-release',payloadJSON:null};
}
function response(kind,c){
 const b={transportId:c.transportId,challengeId:c.challengeId,stage:c.stage,requestSHA256:c.requestSHA256,requestBytesSHA256:c.requestBytesSHA256,archiveBytesSHA256:c.archiveBytesSHA256,state:names[kind][3],errorCode:null};
 const admission={schema:'native-renderer-executor-admission/1',gameId:c.gameId,modId:c.modId,profileId:c.profileId,managerScopeId:c.managerScope,rendererGeneration:c.rendererGeneration,effectsAllowed:false,installationPermit:false};
 if(kind==='prepare')return{schema:'native-executor-response/1',...b,round:c.round,observation:admission};
 if(kind==='execute')return{schema:'native-executor-execution-response/1',...b,executionId:c.executionId,sequence:c.sequence,observation:admission};
 return{schema:'native-executor-cancellation-response/1',...b,cancellationId:c.cancellationId,sequence:c.sequence,observation:{schema:'native-executor-renderer-cancellation/1',transportId:c.transportId,cancellationId:c.cancellationId,operationId:c.operationId,nativeJobId:c.nativeJobId,requestSHA256:c.requestSHA256,state:'prepared',targetAbsent:true,effectsAllowed:false,installationPermit:false,nativeAdmission:false}};
}
function fixture(kind,{withZone=true,mode='native',mutate,sendThrows=false,reentrant=false}={}){
 const replies=[],listeners=new Map(),c=challenge(kind),r=response(kind,c);mutate?.(r);
 const context=vm.createContext({Buffer,nativeExecutorPreloadTypes:types,betterIpcRenderer:{on:(n,f)=>listeners.set(n,f),off:(n,f)=>{assert.equal(listeners.get(n),f);listeners.delete(n)},send:(n,v)=>{if(sendThrows)throw Error('OWN_SEND');replies.push({channel:n,value:v})}},console:{error(){},warn(){},log(){}},setTimeout,clearTimeout,setInterval,clearInterval,queueMicrotask,challenge:c,response:r,mode,reentrant});
 vm.runInContext(actual+`\nglobalThis.NativeBeforeZone=Promise;globalThis.calls=0;globalThis.settled=false;globalThis.thenCalls=0;
 globalThis.barrier=new NativeBeforeZone((resolve,reject)=>{globalThis.resolveBarrier=resolve;globalThis.rejectBarrier=reject});
 globalThis.asyncHandler=async()=>{calls++;if(reentrant){try{${names[kind][0]}(handler)}catch(e){globalThis.reentryCode=e.message}}await barrier;settled=true;return response};
 globalThis.handler=mode==='thenable'?()=>({then(){thenCalls++}}):mode==='proxy'?()=>new Proxy(asyncHandler(),{}):asyncHandler;
 globalThis.off=${names[kind][0]}(handler);`,context);
 if(withZone)vm.runInContext(zone,context,{filename:'actual-zone.umd.js'});
 return{context,replies,c,r,send(value=c){listeners.get(names[kind][1])({},value)},resolve(){context.resolveBarrier()},reject(v){context.rejectBarrier(v)},registerAgain(){return vm.runInContext(`${names[kind][0]}(handler)`,context)},off(){context.off()},listeners};
}
for(const kind of Object.keys(names)){
 test(`${kind}: ordinary native global path retains async response behavior`,async()=>{
  const f=fixture(kind,{withZone:false});f.send();assert.equal(f.replies.length,0);f.resolve();await tick();assert.equal(f.replies.length,1);assert.equal(f.replies[0].value.state,names[kind][3]);
 });
 test(`${kind}: actual receiver waits for native async after actual Zone replacement`,async()=>{
  const f=fixture(kind);assert.equal(vm.runInContext('Promise===NativeBeforeZone',f.context),false);f.send();await tick();assert.equal(f.replies.length,0,'no false failure before source work settles');assert.equal(f.context.settled,false);
  f.resolve();await tick();assert.equal(f.context.settled,true);assert.equal(f.replies.length,1);assert.equal(f.replies[0].channel,names[kind][2]);assert.equal(f.replies[0].value.state,names[kind][3]);assert.equal(f.replies[0].value.errorCode,null);
 });
 test(`${kind}: rejected native async null/undefined remains fixed failed wire under Zone`,async()=>{
  for(const primary of[null,undefined]){const f=fixture(kind);f.send();f.reject(primary);await tick();assert.equal(f.replies.length,1);assert.equal(f.replies[0].value.state,'failed');assert.equal(f.replies[0].value.errorCode,'NATIVE_EXECUTOR_RENDERER_FAILED');}
 });
 test(`${kind}: thenables/proxy flights refuse without then execution; callback failures observed`,async()=>{
  for(const mode of['thenable','proxy']){const f=fixture(kind,{mode});f.send();await tick();assert.equal(f.replies.length,1);assert.equal(f.replies[0].value.state,'failed');assert.equal(f.context.thenCalls,0);f.resolve();await tick();}
  const f=fixture(kind,{sendThrows:true});f.send();f.resolve();await tick();assert.equal(f.context.settled,true);assert.equal(f.replies.length,0);
 });
 test(`${kind}: malformed/getter/proxy challenge is inert and one receiver stays consumed`,async()=>{
  let gets=0;const f=fixture(kind);const bad={...f.c,extra:true};f.send(bad);const getter={...f.c};Object.defineProperty(getter,'schema',{get(){gets++;throw Error('GETTER')}});f.send(getter);f.send(new Proxy(f.c,{get(){gets++;throw Error('PROXY')}}));assert.equal(gets,0);assert.equal(f.context.calls,0);assert.equal(f.replies.length,0);
  assert.throws(()=>f.registerAgain(),/RECEIVER_REFUSED/);f.off();assert.throws(()=>f.registerAgain(),/RECEIVER_REFUSED/);
 });
 test(`${kind}: response tuple mismatch and reentrant registration cannot fabricate success`,async()=>{
  const f=fixture(kind,{mutate(r){r.requestSHA256='f'.repeat(64)}});f.send();assert.throws(()=>f.registerAgain(),/RECEIVER_REFUSED/);f.resolve();await tick();assert.equal(f.replies.length,1);assert.equal(f.replies[0].value.state,'failed');
 });
 test(`${kind}: actual handler reentry refuses a new receiver while original async work settles once`,async()=>{
  const f=fixture(kind,{reentrant:true});f.send();assert.match(f.context.reentryCode,/RECEIVER_REFUSED/);assert.equal(f.context.calls,1);f.resolve();await tick();assert.equal(f.replies.length,1);assert.equal(f.replies[0].value.state,names[kind][3]);
 });
}

}
