import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';
import{fileURLToPath}from'node:url';import{createHash}from'node:crypto';import{makeTrackedObservation}from'./native-renderer-registration-release.test.mjs';
const HERE=path.dirname(fileURLToPath(import.meta.url)),packet=path.join(HERE,'native-patches/vortex-persistence-2.9.1'),sha=b=>createHash('sha256').update(b).digest('hex');
const tick=()=>new Promise(r=>setImmediate(r));export const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
let helperModule;
async function helpers(){
 if(helperModule)return helperModule;
 const url=new URL('./native-renderer-executor-admission.test.mjs',import.meta.url);let text=fs.readFileSync(url,'utf8').replaceAll('\r\n','\n');
 const replace=(a,b)=>{assert.equal(text.split(a).length,2,a);text=text.replace(a,b);};
 replace('const source=applyExact(base.source,patch,m.upstreamPath);assert.equal(sha(source),m.outputSHA256);',`let source=applyExact(base.source,patch,m.upstreamPath);assert.equal(sha(source),m.outputSHA256);
 for(const name of['native-renderer-executor-transport','native-renderer-executor-continuation','native-renderer-executor-completion']){const next=stage(name);assert.equal(sha(source),next.m.inputSHA256);source=applyExact(source,next.patch,next.m.upstreamPath);assert.equal(sha(source),next.m.outputSHA256);}`);
 replace("profiles:{p:{gameId:'game'},q:{gameId:'game'}}", "profiles:{[options.profileId??'p']:{gameId:options.gameId??'game'},q:{gameId:options.gameId??'game'}}");
 replace("activeProfileId:'p'}}});\n  f.manager", "activeProfileId:options.profileId??'p'}}});\n  f.manager");
 replace('getApi:transport=>{','archiveRows:options.archiveRows,getApi:transport=>{');
 replace('/Native|nativeExecutor|nativeManagerExport|mNative|getApi|getExtensionInitFunc/', '/Native|nativeTransport|nativeExecutor|nativeManagerExport|mNative|getApi|getExtensionInitFunc/');
 replace('...f.api,...f.middleware,nativeReadinessTypes,nativeReadinessClock,setTimeout,clearTimeout}', '...f.api,...f.middleware,nativeReadinessTypes,nativeReadinessClock,setTimeout,clearTimeout,nativeExecutorTransportHash:createHash,nativeExecutorAdopt:f.api.adoptNativeRendererTarget,window:options.transportWindow}');
 text=text.replace(/from '(\.\/[^']+)'/g,(_,p)=>'from '+JSON.stringify(new URL(p,url).href)).replaceAll('import.meta.url',JSON.stringify(url.href));
 helperModule=await import('data:text/javascript;base64,'+Buffer.from(text).toString('base64'));return helperModule;
}
/** Actual ExtensionManager, Redux/root/middleware/InstallManager native methods.
 * Controlled preload/Main execution facade only; no actual Main fixture/worker. */
export async function createRendererCompletionFixture(options={}){
 const prepareGate=deferred(),executeGate=deferred();let prepareReceiver,executionReceiver,prepareRegistrations=0,executionRegistrations=0;
 const invalidations=[],executed=[],prepareCalls=[];
 const persist={prepareNativeExecutor(r,a){prepareCalls.push({r:new Uint8Array(r),a:new Uint8Array(a)});return options.prepareInvoke?.(r,a)??prepareGate.promise;},
 onExecutorChallenge(fn){prepareRegistrations++;prepareReceiver=fn;options.prepareRegister?.(fn);return()=>{};},executeNativeExecutor(id){executed.push(id);return options.executeInvoke?.(id)??executeGate.promise;},
 onExecutorExecutionChallenge(fn){executionRegistrations++;executionReceiver=fn;options.register?.(fn);return()=>{};},
 invalidateNativeExecutorExecution(value){invalidations.push(structuredClone(value));options.invalidate?.(value);}};
 const window={api:{persist}},module=await helpers(),f=module.createExecutorAdmissionFixture({...options,transportWindow:window});
 const request=Buffer.from(options.requestBytes??'{"own":"request"}'),archive=Buffer.from(options.archiveBytes??'{"own":"archive"}');
 const binding=()=>({operationId:'op_'+'2'.repeat(32),nativeJobId:'exec_'+'3'.repeat(32),requestSHA256:'a'.repeat(64),requestBytesSHA256:sha(request),archiveBytesSHA256:sha(archive),gameId:options.gameId??'game',modId:options.modId??'new',profileId:options.profileId??'p',managerScope:'manager-fixture-1',rendererGeneration:f.manager.getNativeInstallExclusion().rendererGeneration});
 const transportId='transport_'+'1'.repeat(32),executionId='execution_'+'5'.repeat(32);
 const observed=()=>JSON.parse(options.observedJSON??makeTrackedObservation({operation:'2',job:'3',request:'a'}));
 const release=()=>{const o=observed();return{schema:'native-registration-release-observed/1',operationId:o.operationId,nativeJobId:o.nativeJobId,requestSHA256:o.requestSHA256,recordSHA256:o.recordSHA256,fullRecordSHA256:o.fullRecordSHA256,released:true,consumedIDsRetained:true,durableConsumedIDsVerified:false,effectsAllowed:false,installationPermit:false,trackedInstallComplete:false};};
 const stages=['check-preparation-before-start','check-preparation-after-copy','adopt','check-adoption-before-close','check-adoption-after-close','check-adoption-before-release','finalize','hold'];
 const challenge=(sequence,change={})=>({schema:'native-executor-execution-challenge/1',transportId,executionId,challengeId:'challenge_'+['9','a','b','c','d','e','f','8'][sequence-1].repeat(32),sequence,stage:stages[sequence-1],payloadJSON:sequence===3?JSON.stringify(observed()):sequence===7?JSON.stringify(release()):null,...binding(),...change});
 const preparation=()=>({schema:'native-executor-transport-preparation/1',transportId,...Object.fromEntries(Object.entries(binding()).filter(([k])=>!['gameId','modId','profileId','managerScope','rendererGeneration'].includes(k))),rootId:'1:2',inventorySHA256:'b'.repeat(64),effectsAllowed:false,installationPermit:false,nativeAdmission:false,powerLossPersistenceVerified:false});
 const result=()=>{const o=observed();return{schema:'native-executor-execution-result/1',transportId,executionId,...Object.fromEntries(Object.entries(binding()).filter(([k])=>!['gameId','modId','profileId','managerScope','rendererGeneration'].includes(k))),recordSHA256:o.recordSHA256,fullRecordSHA256:o.fullRecordSHA256,mainReleased:true,rendererReleased:true,effectsAllowed:false,installationPermit:false,nativeAdmission:false,trackedInstallComplete:false,powerLossPersistenceVerified:false};};
 return{...f,window,persist,request,archive,transportId,executionId,prepareGate,executeGate,invalidations,executed,prepareCalls,challenge,release,result,binding,
  registrations:()=>({prepare:prepareRegistrations,execution:executionRegistrations}),receive:c=>executionReceiver(c),
  async prepared(){await f.ready();const p=f.ext.prepareNativeExecutor(request,archive);for(const round of[1,2,3])assert.equal((await prepareReceiver({schema:'native-executor-challenge/1',transportId,challengeId:'challenge_'+String(round).repeat(32),round,stage:round===1?'acquire':'check',...binding()})).state,round===1?'acquired':'checked');prepareGate.resolve(preparation());await p;return this;},
  execute:()=>f.ext.executeNativeExecutor(),finalize:bytes=>f.ext.finalizeNativeExecutorTransportAdoption(transportId,bytes??Buffer.from(JSON.stringify(release())))};
}
const repo=process.env.VORTEX_EXTENSION_ADMISSION_REPO,deps=process.env.VORTEX_EXTENSION_ADMISSION_DEPS;
const integration=(name,fn)=>test(name,{timeout:15000,skip:repo&&deps?false:'Set VORTEX_EXTENSION_ADMISSION_REPO and VORTEX_EXTENSION_ADMISSION_DEPS'},fn);
function held(f){assert.equal(f.manager.getNativeInstallExclusion().exclusiveHeld,true);assert.notEqual(f.rootApi.getNativeRendererTargetStatus().phase,'not_reserved');f.fire();assert.equal(f.sent.length,0);}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 test('renderer completion pins frozen continuation and source-only flags',()=>{const m=JSON.parse(fs.readFileSync(path.join(packet,'native-renderer-executor-completion.json'))),p=fs.readFileSync(path.join(packet,'native-renderer-executor-completion.patch')),parent=JSON.parse(fs.readFileSync(path.join(packet,'native-renderer-executor-continuation.json')));assert.equal(m.inputSHA256,parent.outputSHA256);assert.equal(m.prerequisitePatchSHA256,parent.patchSHA256);assert.equal(sha(p),m.patchSHA256);const preload=JSON.parse(fs.readFileSync(path.join(packet,'native-executor-completion-preload.json')));assert.equal(m.requiredCompanionPatchSHA256,preload.patchSHA256);assert.equal(m.requiredCompanionOutputSHA256,preload.outputSHA256);for(const k of['installed','nativeAcceptanceVerified','installationPermit','effectsAllowed','nativeAdmission','powerLossPersistenceVerified'])assert.equal(m[k],false);});
 integration('all seven execution stages finalize exact owners synchronously and flush only unrelated buffered writes',async()=>{
  const f=await createRendererCompletionFixture();await f.prepared();assert.deepEqual(f.registrations(),{prepare:1,execution:1});f.store.dispatch({type:'SETTING',payload:{key:'buffered',value:7}});const p=f.execute();
  for(const n of[1,2,3,4,5,6])assert.equal((await f.receive(f.challenge(n))).state,n===3?'adopted':'checked');held(f);
  const out=await f.receive(f.challenge(7));assert.equal(out.state,'finalized');assert.equal(Object.keys(out.observation).length,11);assert.equal(out.observation.released,true);assert.equal(f.rootApi.getNativeRendererTargetStatus().phase,'not_reserved');assert.equal(f.manager.getNativeInstallExclusion().exclusiveHeld,false);
  f.executeGate.resolve(f.result());const result=await p;assert(Object.isFrozen(result));assert.equal(Object.keys(result).length,17);assert.equal(result.mainReleased,true);assert.equal(result.rendererReleased,true);assert.equal(result.installationPermit,false);
  f.fire();assert.equal(f.sent.some(b=>b.hive==='settings'&&b.operations.some(o=>o.path.includes('buffered'))),true);assert.equal(f.sent.some(b=>b.operations.some(o=>o.path.includes('mods')||o.path.includes('installed'))),false);
 });
 integration('profile ABA during COPY emits one negative notification without waiting for a challenge',async()=>{
  const f=await createRendererCompletionFixture();await f.prepared();const p=f.execute();p.catch(()=>{});assert.equal((await f.receive(f.challenge(1))).state,'checked');f.store.dispatch({type:'SETTING',payload:{key:'profiles',value:{activeProfileId:'q'}}});f.store.dispatch({type:'SETTING',payload:{key:'profiles',value:{activeProfileId:'p'}}});await tick();assert.equal(f.invalidations.length,1);assert.equal(Object.keys(f.invalidations[0]).length,9);assert.equal(f.invalidations[0].executionId,f.executionId);assert.equal((await f.receive(f.challenge(2))).state,'failed');f.executeGate.reject(Error('Main held'));await assert.rejects(p);held(f);
 });
 integration('method drift before Main ACK cannot call a substituted finalizer or open any renderer owner',async()=>{
  const f=await createRendererCompletionFixture();await f.prepared();const p=f.execute();p.catch(()=>{});for(const n of[1,2,3,4,5,6])await f.receive(f.challenge(n));let calls=0;f.Manager.prototype.finalizeNativeRegistrationRelease=()=>{calls++;};assert.equal((await f.receive(f.challenge(7))).state,'failed');assert.equal(calls,0);f.executeGate.reject(Error('Main already released'));await assert.rejects(p);held(f);
 });
 integration('wrong or malformed Main release receipt cannot finalize retained owners',async()=>{
  for(const mutate of[r=>r.requestSHA256='f'.repeat(64),r=>r.fullRecordSHA256='f'.repeat(64),r=>r.released=false,r=>r.extra=true]){const f=await createRendererCompletionFixture();await f.prepared();const p=f.execute();p.catch(()=>{});for(const n of[1,2,3,4,5,6])await f.receive(f.challenge(n));const r=f.release();mutate(r);assert.equal((await f.receive(f.challenge(7,{payloadJSON:JSON.stringify(r)}))).state,'failed');f.executeGate.reject(Error('Main released'));await assert.rejects(p);held(f);}
 });
 integration('context change after Main release and before renderer finalize retains truthful renderer hold',async()=>{
  const f=await createRendererCompletionFixture();await f.prepared();const p=f.execute();p.catch(()=>{});for(const n of[1,2,3,4,5,6])await f.receive(f.challenge(n));const receipt=f.release();assert.equal(receipt.released,true);f.store.dispatch({type:'SETTING',payload:{key:'profiles',value:{activeProfileId:'q'}}});assert.equal((await f.receive(f.challenge(7,{payloadJSON:JSON.stringify(receipt)}))).state,'failed');f.executeGate.reject(Error('Main released / renderer held'));await assert.rejects(p);held(f);
 });

 integration('unsubscribe primary null/undefined is preserved locally and happens before any owner opens',async()=>{
  for(const primary of[null,undefined]){const f=await createRendererCompletionFixture(),subscribe=f.store.subscribe;let calls=0;
   f.store.subscribe=function(listener){const off=subscribe.call(this,listener);return()=>{calls++;off();throw primary;};};
   await f.prepared();const p=f.execute();p.catch(()=>{});for(const n of[1,2,3,4,5,6])await f.receive(f.challenge(n));assert.equal((await f.receive(f.challenge(7))).state,'failed');assert.equal(calls,1);f.executeGate.reject(Error('sanitized Main reply'));let caught=false;try{await p;}catch(e){caught=true;assert.equal(e,primary);}assert.equal(caught,true);held(f);
  }
 });
 integration('unsubscribe reentry is sticky even when its callback swallows the nested exception',async()=>{
  const f=await createRendererCompletionFixture(),subscribe=f.store.subscribe;let nested=false;
  f.store.subscribe=function(listener){const off=subscribe.call(this,listener);return()=>{off();nested=true;assert.throws(()=>f.finalize());};};
  await f.prepared();const p=f.execute();p.catch(()=>{});for(const n of[1,2,3,4,5,6])await f.receive(f.challenge(n));assert.equal((await f.receive(f.challenge(7))).state,'failed');assert.equal(nested,true);f.executeGate.reject(Error('partial Main release'));await assert.rejects(p);held(f);
 });
 integration('ordinary dispatch inside unsubscribe cannot open gates over an altered state snapshot',async()=>{
  const f=await createRendererCompletionFixture(),subscribe=f.store.subscribe;
  f.store.subscribe=function(listener){const off=subscribe.call(this,listener);return()=>{off();f.store.dispatch({type:'SETTING',payload:{key:'reentered',value:9}});};};
  await f.prepared();const p=f.execute();p.catch(()=>{});for(const n of[1,2,3,4,5,6])await f.receive(f.challenge(n));assert.equal((await f.receive(f.challenge(7))).state,'failed');assert.equal(f.store.getState().settings.reentered,9);f.executeGate.reject(Error('held'));await assert.rejects(p);held(f);
 });
 integration('foreign execution binding is inert but genuine duplicate or stale preparation nonce holds execution',async()=>{
  const f=await createRendererCompletionFixture();await f.prepared();const p=f.execute();p.catch(()=>{});
  assert.equal((await f.receive(f.challenge(1,{requestBytesSHA256:'f'.repeat(64)}))).state,'failed');assert.equal(f.invalidations.length,0);
  assert.equal((await f.receive(f.challenge(1))).state,'checked');assert.equal((await f.receive(f.challenge(2,{executionId:'execution_'+'f'.repeat(32)}))).state,'failed');assert.equal(f.invalidations.length,0);
  assert.equal((await f.receive(f.challenge(2,{challengeId:'challenge_'+'1'.repeat(32)}))).state,'failed');assert.equal(f.invalidations.length,1);f.executeGate.reject(Error('nonce held'));await assert.rejects(p);held(f);
 });
 integration('execution rejects preparation schema, swapped sequence/stage, accessors and thenables without callbacks',async()=>{
  const f=await createRendererCompletionFixture();await f.prepared();const p=f.execute();p.catch(()=>{});let getters=0;
  const bad=f.challenge(1);Object.defineProperty(bad,'stage',{enumerable:true,get(){getters++;throw Error('getter');}});
  await assert.rejects(f.receive(bad));await assert.rejects(f.receive({...f.challenge(1),schema:'native-executor-challenge/1'}));await assert.rejects(f.receive(f.challenge(1,{stage:'adopt'})));assert.equal(getters,0);
  assert.equal((await f.receive(f.challenge(1))).state,'checked');assert.equal((await f.receive(f.challenge(1))).state,'failed');f.executeGate.reject(Error('held'));await assert.rejects(p);held(f);
  const g=await createRendererCompletionFixture({executeInvoke:()=>({get then(){getters++;throw Error('then getter');}})});await g.prepared();await assert.rejects(g.execute());assert.equal(getters,0);held(g);
 });
 integration('a known held execution sends one negative and late valid work cannot restore it',async()=>{
  const f=await createRendererCompletionFixture();await f.prepared();const p=f.execute();p.catch(()=>{});await f.receive(f.challenge(1));assert.equal((await f.receive(f.challenge(8))).state,'held');assert.equal(f.invalidations.length,1);assert.equal((await f.receive(f.challenge(8,{challengeId:'challenge_'+'0'.repeat(32)}))).state,'failed');assert.equal(f.invalidations.length,1);f.executeGate.resolve(f.result());await assert.rejects(p);held(f);await assert.rejects(f.execute());assert.equal(f.executed.length,1);
 });
 integration('known completion remains immutable across late notifications and cannot rearm an operation',async()=>{
  const f=await createRendererCompletionFixture();await f.prepared();const p=f.execute();for(const n of[1,2,3,4,5,6,7])await f.receive(f.challenge(n));
  assert.equal((await f.receive(f.challenge(8))).state,'failed');f.store.dispatch({type:'SETTING',payload:{key:'profiles',value:{activeProfileId:'q'}}});await tick();assert.equal(f.invalidations.length,0);f.executeGate.resolve(f.result());const result=await p;
  await assert.rejects(f.execute());assert.throws(()=>f.finalize());assert.equal(result.rendererReleased,true);assert.equal(result.mainReleased,true);assert.equal(f.executed.length,1);assert.equal(f.manager.getNativeInstallExclusion().exclusiveHeld,false);
 });
 integration('final release bytes have strict canonical closed shape before source finalization',async()=>{
  for(const make of[r=>Buffer.concat([Buffer.from([239,187,191]),Buffer.from(JSON.stringify(r))]),r=>Buffer.from(JSON.stringify(r).replace('{','{"released":false,')),r=>Buffer.from(JSON.stringify(Object.fromEntries(Object.entries(r).reverse()))),()=>Buffer.alloc(8193)]){
   const f=await createRendererCompletionFixture();await f.prepared();const p=f.execute();p.catch(()=>{});for(const n of[1,2,3,4,5,6])await f.receive(f.challenge(n));assert.throws(()=>f.finalize(make(f.release())));f.executeGate.reject(Error('Main released'));await assert.rejects(p);held(f);
  }
 });
}
