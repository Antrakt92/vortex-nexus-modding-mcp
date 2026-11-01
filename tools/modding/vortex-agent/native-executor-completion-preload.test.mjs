import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {types} from 'node:util';
import {stripTypeScriptTypes} from 'node:module';
import {fileURLToPath} from 'node:url';
import {repo,original,stage,sha,tick,deferred} from './native-query-source-admission.test.mjs';
import {applyExact} from './native-patch-test-fixture.mjs';
import {transportChallenge} from './native-executor-transport-preload.test.mjs';
const HERE=path.dirname(fileURLToPath(import.meta.url));
export function completionSource(name){
 const {m,patch}=stage(name),graph=JSON.parse(fs.readFileSync(path.join(HERE,'native-source-series.json')));
 let source=original(m.upstreamPath).toString();
 for(const row of graph.patches.filter(row=>row.path===m.upstreamPath)){
  if(sha(source)===m.inputSHA256)break;
  const dir=row.packet==='lifecycle'?'vortex-2.9.1':'vortex-persistence-2.9.1';
  source=applyExact(source,fs.readFileSync(path.join(HERE,'native-patches',dir,row.name+'.patch'),'utf8'),m.upstreamPath);
  assert.equal(sha(source),row.outputSHA256);
 }
 assert.equal(sha(source),m.inputSHA256);assert.equal(sha(patch),m.patchSHA256);
 source=applyExact(source,patch,m.upstreamPath);assert.equal(sha(source),m.outputSHA256);return source;
}
export const executionStages=['check-preparation-before-start','check-preparation-after-copy','adopt','check-adoption-before-close','check-adoption-after-close','check-adoption-before-release','finalize','hold'];
export function executionChallenge(sequence=1,extra={}){
 const {schema,round,stage,...b}=transportChallenge();
 return {schema:'native-executor-execution-challenge/1',...b,executionId:'execution_'+'9'.repeat(32),sequence,stage:executionStages[sequence-1],payloadJSON:sequence===3?'{}':sequence===7?'{}':null,...extra};
}
export function executionObservation(c){
 if(c.sequence<=2)return{schema:'native-renderer-executor-admission/1',gameId:c.gameId,modId:c.modId,profileId:c.profileId,managerScopeId:c.managerScope,rendererGeneration:c.rendererGeneration,effectsAllowed:false,installationPermit:false};
 return{schema:c.sequence===7?'native-executor-renderer-completion/1':'native-executor-renderer-adoption/1',transportId:c.transportId,operationId:c.operationId,nativeJobId:c.nativeJobId,requestSHA256:c.requestSHA256,recordSHA256:'a'.repeat(64),fullRecordSHA256:'b'.repeat(64),effectsAllowed:false,installationPermit:false,...(c.sequence===7?{released:true,trackedInstallComplete:false}:{})};
}
export function executionResponse(c,extra={}){return{schema:'native-executor-execution-response/1',transportId:c.transportId,executionId:c.executionId,challengeId:c.challengeId,sequence:c.sequence,stage:c.stage,requestSHA256:c.requestSHA256,requestBytesSHA256:c.requestBytesSHA256,archiveBytesSHA256:c.archiveBytesSHA256,state:c.sequence===8?'held':c.sequence===7?'finalized':c.sequence===3?'adopted':'checked',observation:c.sequence===8?null:executionObservation(c),errorCode:null,...extra};}
export function createCompletionPreloadFixture(options={}){
 const text=stripTypeScriptTypes(completionSource('native-executor-completion-preload'),{mode:'transform'}),start=text.indexOf('let nativeExecutorReceiverBound'),end=text.indexOf('try {\n    expose(',start),p=text.indexOf('persist: {'),q=text.indexOf('extensions: {',p);
 assert(start>=0&&end>start&&q>p);const listeners=new Map(),sent=[],invoked=[];
 const persist=vm.runInNewContext(text.slice(start,end)+'\n({'+text.slice(p,q)+'}).persist;',{
  Buffer,nativeExecutorPreloadTypes:types,betterIpcRenderer:{invoke:(...args)=>{invoked.push(args);return options.invoke?.(...args)??Promise.resolve({});},
   on:(name,fn)=>{listeners.set(name,fn);options.on?.(name,fn);},off:(name,fn)=>{if(listeners.get(name)===fn)listeners.delete(name);},send:(channel,value)=>{sent.push({channel,value});options.send?.(channel,value);}},
 });
 return{persist,listeners,sent,invoked,deliver:c=>listeners.get('persist:native-executor-execution-challenge')?.(undefined,c)};
}
const integration=(name,fn)=>test(name,{skip:repo?false:'Set VORTEX_EXTENSION_ADMISSION_REPO',timeout:10000},fn);
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 test('completion types/preload artifacts pin fixed predecessors and chained companions',()=>{
  for(const name of ['native-executor-completion-shared-ipc','native-executor-completion-shared-preload','native-executor-completion-preload']){
   const {m,patch}=stage(name),parent=stage(m.prerequisitePatch.slice(0,-6)).m;assert.equal(sha(patch),m.patchSHA256);assert.equal(m.inputSHA256,parent.outputSHA256);
   if(m.requiredCompanionPatch){const c=stage(m.requiredCompanionPatch.slice(0,-6)).m;assert.equal(m.requiredCompanionPatchSHA256,c.patchSHA256);assert.equal(m.requiredCompanionOutputSHA256,c.outputSHA256);}
   assert.equal(m.installed,false);assert.equal(m.nativeAdmission,false);
  }
 });
 integration('actual fixed invoke has only prepared transport ID and separate execution channel',async()=>{
  const f=createCompletionPreloadFixture();await f.persist.executeNativeExecutor('transport_'+'1'.repeat(32),'ignored');assert.deepEqual(f.invoked,[['persist:native-executor-execute','transport_'+'1'.repeat(32)]]);
 });
 integration('all eight stages preserve closed 17/12 field envelopes with detached frozen observations',async()=>{
  const f=createCompletionPreloadFixture();let seen;f.persist.onExecutorExecutionChallenge(async c=>{seen=c;return executionResponse(c);});
  for(let sequence=1;sequence<=8;sequence++){const c=executionChallenge(sequence);f.deliver(c);c.modId='changed';await tick();const r=f.sent.at(-1);assert.equal(r.channel,'persist:native-executor-execution-response');assert.equal(Object.keys(r.value).length,12);assert.equal(r.value.state,sequence===8?'held':sequence===7?'finalized':sequence===3?'adopted':'checked');assert.equal(Object.keys(seen).length,17);assert.equal(seen.modId,'Own');assert(Object.isFrozen(seen));if(r.value.observation)assert(Object.isFrozen(r.value.observation));}
 });
 integration('old preparation schema, malformed stages, oversized payloads, proxies and getter challenges never invoke handler',async()=>{
  const f=createCompletionPreloadFixture();let calls=0,getters=0;f.persist.onExecutorExecutionChallenge(async c=>{calls++;return executionResponse(c);});
  const getter=executionChallenge();Object.defineProperty(getter,'sequence',{get(){getters++;return 1;}});
  for(const c of [transportChallenge(),executionChallenge(1,{stage:'adopt'}),executionChallenge(3,{payloadJSON:'x'.repeat(32769)}),executionChallenge(7,{payloadJSON:'x'.repeat(8193)}),getter,new Proxy(executionChallenge(),{ownKeys(){getters++;return[];}})])f.deliver(c);
  await tick();assert.equal(calls,0);assert.equal(getters,0);assert.equal(f.sent.length,0);
 });
 integration('reply substitutions and nested accessors yield only fixed failed responses',async()=>{
  for(const mutate of [r=>r.executionId='execution_'+'f'.repeat(32),r=>r.sequence=2,r=>r.observation.installationPermit=true,r=>r.extra='secret',r=>Object.defineProperty(r.observation,'recordSHA256',{get(){throw Error('must not invoke');}})]){
   const f=createCompletionPreloadFixture();f.persist.onExecutorExecutionChallenge(async c=>{const r=executionResponse(c);mutate(r);return r;});f.deliver(executionChallenge(3));await tick();assert.equal(f.sent[0].value.state,'failed');assert.equal(f.sent[0].value.observation,null);assert.equal(f.sent[0].value.errorCode,'NATIVE_EXECUTOR_RENDERER_FAILED');
  }
 });
 integration('thenables and proxy promises cannot execute then getters and late rejection is observed',async()=>{
  let gets=0;
  for(const handler of [()=>({get then(){gets++;throw Error('private');}}),()=>new Proxy(Promise.resolve(),{get(){gets++;throw Error('private');}}),()=>{throw null;},async()=>{throw undefined;}]){
   const f=createCompletionPreloadFixture();f.persist.onExecutorExecutionChallenge(handler);f.deliver(executionChallenge());await tick();assert.equal(f.sent[0].value.state,'failed');
  }assert.equal(gets,0);
  const gate=deferred(),f=createCompletionPreloadFixture();f.persist.onExecutorExecutionChallenge(()=>gate.promise);f.deliver(executionChallenge());gate.reject(Error('secret'));await tick();assert.equal(f.sent[0].value.state,'failed');assert(!JSON.stringify(f.sent).includes('secret'));
 });
 integration('one receiver is sticky even after disposal or uncertain registration failure',()=>{
  const f=createCompletionPreloadFixture(),off=f.persist.onExecutorExecutionChallenge(async c=>executionResponse(c));off();assert.throws(()=>f.persist.onExecutorExecutionChallenge(async c=>executionResponse(c)));
  const g=createCompletionPreloadFixture({on(){throw Error('uncertain');}});assert.throws(()=>g.persist.onExecutorExecutionChallenge(async c=>executionResponse(c)));assert.throws(()=>g.persist.onExecutorExecutionChallenge(async c=>executionResponse(c)));
 });
 integration('negative invalidation is exact nine-field detached data and never a generic send',()=>{
  const c=executionChallenge(),value={schema:'native-executor-execution-invalidated/1',transportId:c.transportId,executionId:c.executionId,operationId:c.operationId,nativeJobId:c.nativeJobId,requestSHA256:c.requestSHA256,requestBytesSHA256:c.requestBytesSHA256,archiveBytesSHA256:c.archiveBytesSHA256,reasonCode:'NATIVE_EXECUTOR_RENDERER_FAILED'},f=createCompletionPreloadFixture();f.persist.invalidateNativeExecutorExecution(value);value.reasonCode='changed';assert.equal(f.sent[0].channel,'persist:native-executor-execution-invalidated');assert.equal(f.sent[0].value.reasonCode,'NATIVE_EXECUTOR_RENDERER_FAILED');assert(Object.isFrozen(f.sent[0].value));assert.throws(()=>f.persist.invalidateNativeExecutorExecution({...value,extra:true}));
 });
}
