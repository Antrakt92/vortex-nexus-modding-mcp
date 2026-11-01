import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {applyExact} from './native-patch-test-fixture.mjs';
const HERE=path.dirname(fileURLToPath(import.meta.url));
const packet=path.join(HERE,'native-patches/vortex-persistence-2.9.1');
const sha=x=>createHash('sha256').update(x).digest('hex');
const tick=()=>new Promise(r=>setImmediate(r));
export const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
const fixtureModules=new Map();
async function helpers(){
 const baseline=false;
 if(fixtureModules.has(baseline))return fixtureModules.get(baseline);
 const originalURL=new URL('./native-renderer-executor-admission.test.mjs',import.meta.url);
 let text=fs.readFileSync(originalURL,'utf8').replaceAll('\r\n','\n');
 const replace=(a,b)=>{assert.equal(text.split(a).length,2,a);text=text.replace(a,b);};
 replace("const source=applyExact(base.source,patch,m.upstreamPath);assert.equal(sha(source),m.outputSHA256);",`let source=applyExact(base.source,patch,m.upstreamPath);assert.equal(sha(source),m.outputSHA256);
 const next=stage('native-renderer-executor-transport');assert.equal(sha(source),next.m.inputSHA256);source=applyExact(source,next.patch,next.m.upstreamPath);assert.equal(sha(source),next.m.outputSHA256);`);
 replace("profiles:{p:{gameId:'game'},q:{gameId:'game'}}", "profiles:{[options.profileId??'p']:{gameId:options.gameId??'game'},q:{gameId:options.gameId??'game'}}");
 replace("activeProfileId:'p'}}});\n  f.manager", "activeProfileId:options.profileId??'p'}}});\n  f.manager");
 replace('/Native|nativeExecutor|nativeManagerExport|mNative|getApi|getExtensionInitFunc/', '/Native|nativeTransport|nativeExecutor|nativeManagerExport|mNative|getApi|getExtensionInitFunc/');
 replace('...f.api,...f.middleware,nativeReadinessTypes,nativeReadinessClock,setTimeout,clearTimeout}', '...f.api,...f.middleware,nativeReadinessTypes,nativeReadinessClock,setTimeout,clearTimeout,nativeExecutorTransportHash:createHash,window:options.transportWindow}');
 text=text.replace(/from '(\.\/[^']+)'/g,(_,p)=>'from '+JSON.stringify(new URL(p,originalURL).href));
 text=text.replaceAll('import.meta.url',JSON.stringify(originalURL.href));
 const module=await import('data:text/javascript;base64,'+Buffer.from(text).toString('base64'));fixtureModules.set(baseline,module);return module;
}
/** Actual composed ExtensionManager native methods + real Redux/root/middleware/
 * manager admission. Preload/Main and host constructors are controlled facades. */
export async function createRendererTransportFixture(options={}){
 let receiver,registrations=0;const calls=[],gate=deferred();
 const persist={prepareNativeExecutor(request,archive){calls.push({request:new Uint8Array(request),archive:new Uint8Array(archive)});return options.invoke?.(request,archive)??gate.promise;},
 onExecutorChallenge(fn){registrations++;receiver=fn;options.register?.(fn);return()=>{};}};
 const window={api:{persist}};
 const {createExecutorAdmissionFixture}=await helpers();
 const f=createExecutorAdmissionFixture({...options,transportWindow:window});
 const request=Buffer.from(options.requestBytes??'{"own":"request bytes remain Main authority"}'),archive=Buffer.from(options.archiveBytes??'{"own":"archive bytes"}');
 const labels=()=>f.manager.getNativeInstallExclusion();
 const binding=()=>({transportId:'transport_'+'1'.repeat(32),requestSHA256:'a'.repeat(64),requestBytesSHA256:sha(request),archiveBytesSHA256:sha(archive),
 operationId:'op_'+'2'.repeat(32),nativeJobId:'exec_'+'3'.repeat(32),gameId:options.gameId??'game',modId:options.modId??'new',profileId:options.profileId??'p',managerScope:'manager-fixture-1',rendererGeneration:labels().rendererGeneration});
 const challenge=(round,change={})=>({schema:'native-executor-challenge/1',...binding(),challengeId:'challenge_'+String(round).repeat(32),round,stage:round===1?'acquire':round===4?'hold':'check',...change});
 const result=()=>({schema:'native-executor-transport-preparation/1',...Object.fromEntries(Object.entries(binding()).filter(([k])=>!['gameId','modId','profileId','managerScope','rendererGeneration'].includes(k))),rootId:'1:2',inventorySHA256:'b'.repeat(64),effectsAllowed:false,installationPermit:false,nativeAdmission:false,powerLossPersistenceVerified:false});
 return{...f,window,persist,calls,gate,request,archive,challenge,result,registrations:()=>registrations,
  prepare:()=>f.ext.prepareNativeExecutor(request,archive),receive:c=>receiver(c)};
}
const repo=process.env.VORTEX_EXTENSION_ADMISSION_REPO,deps=process.env.VORTEX_EXTENSION_ADMISSION_DEPS;
const integration=(name,fn)=>test(name,{timeout:15000,skip:repo&&deps?false:'Set VORTEX_EXTENSION_ADMISSION_REPO and VORTEX_EXTENSION_ADMISSION_DEPS'},fn);
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 test('transport patch pins exact admission source and preserves source-only flags',()=>{const m=JSON.parse(fs.readFileSync(path.join(packet,'native-renderer-executor-transport.json'))),p=fs.readFileSync(path.join(packet,'native-renderer-executor-transport.patch')),parent=JSON.parse(fs.readFileSync(path.join(packet,'native-renderer-executor-admission.json')));assert.equal(sha(p),m.patchSHA256);assert.equal(m.inputSHA256,parent.outputSHA256);assert.equal(m.prerequisitePatchSHA256,parent.patchSHA256);for(const k of ['installed','nativeAcceptanceVerified','installationPermit','nativeAdmission','effectsAllowed','powerLossPersistenceVerified'])assert.equal(m[k],false);});
 integration('one actual load receiver acquires once, drains old ACK, checks same owner and returns only preparation',async()=>{
  const ack=deferred(),f=await createRendererTransportFixture({ack:()=>ack.promise});await f.ready();assert.equal(f.registrations(),1);
  const preparing=f.prepare();preparing.catch(()=>{});assert.equal(f.calls.length,1);
  const acquiring=f.receive(f.challenge(1));let settled=false;acquiring.then(()=>settled=true);await tick();assert.equal(settled,false);assert.equal(f.acks.length,1);
  f.store.dispatch({type:'SETTING',payload:{key:'ordinary',value:7}});f.fire();assert.equal(f.sent.length,0);
  ack.resolve();const a=await acquiring;assert.equal(a.state,'acquired');assert.equal(a.observation.profileId,'p');
  for(const r of [2,3])assert.equal((await f.receive(f.challenge(r))).state,'checked');
  f.gate.resolve(f.result());const out=await preparing;assert(Object.isFrozen(out));assert.equal(out.effectsAllowed,false);assert.equal(f.calls.length,1);assert.equal(f.store.getState().settings.ordinary,7);
 });
 integration('hold4 invalidates a genuinely pending readiness acquisition without a second acquire',async()=>{
  const f=await createRendererTransportFixture(),preparing=f.prepare();preparing.catch(()=>{});const acquiring=f.receive(f.challenge(1));await tick();
  assert.equal(f.manager.getNativeInstallExclusion().exclusiveHeld,false);
  const held=await f.receive(f.challenge(4));assert.equal(held.state,'held');assert.equal((await acquiring).state,'failed');
  await f.ready();f.gate.reject(Error('main held'));await assert.rejects(preparing);assert.equal(f.manager.getNativeInstallExclusion().exclusiveHeld,false);assert.equal(f.acks.length,0);
 });
 integration('hold4 during pending real old ACK retains all already acquired owners',async()=>{
  const gate=deferred(),f=await createRendererTransportFixture({ack:()=>gate.promise});await f.ready();const p=f.prepare();p.catch(()=>{});const a=f.receive(f.challenge(1));await tick();
  assert.equal((await f.receive(f.challenge(4))).state,'held');assert.equal((await a).state,'failed');gate.resolve();await tick();
  f.gate.reject(Error('held'));await assert.rejects(p);assert.equal(f.manager.getNativeInstallExclusion().exclusiveHeld,true);assert.notEqual(f.rootApi.getNativeRendererTargetStatus().phase,'not_reserved');f.fire();assert.equal(f.sent.length,0);
 });
 integration('actual owner failure retains exact null/undefined local primary across sanitized Main failure',async()=>{
  for(const primary of [null,undefined]){const f=await createRendererTransportFixture({ack:()=>Promise.reject(primary)});await f.ready();const p=f.prepare();p.catch(()=>{});assert.equal((await f.receive(f.challenge(1))).state,'failed');f.gate.reject(Error('wire sanitized'));let got=false;try{await p;}catch(error){got=true;assert.equal(error,primary);}assert(got);}
 });
 integration('wrong raw hash or unrelated transport cannot acquire or poison matching genuine request',async()=>{
  const f=await createRendererTransportFixture();await f.ready();const p=f.prepare();p.catch(()=>{});
  assert.equal((await f.receive(f.challenge(1,{requestBytesSHA256:'f'.repeat(64)}))).state,'failed');assert.equal(f.acks.length,0);
  assert.equal((await f.receive(f.challenge(1))).state,'acquired');assert.equal((await f.receive(f.challenge(4,{transportId:'transport_'+'f'.repeat(32)}))).state,'failed');
  for(const r of[2,3])assert.equal((await f.receive(f.challenge(r))).state,'checked');f.gate.resolve(f.result());await p;
 });
 integration('mismatched actual profile/scope/generation holds after acquisition, not a DTO permission',async()=>{
  for(const change of[{profileId:'q'},{managerScope:'foreign'},{rendererGeneration:'renderer_'+'f'.repeat(32)}]){const f=await createRendererTransportFixture();await f.ready();const p=f.prepare();p.catch(()=>{});assert.equal((await f.receive(f.challenge(1,change))).state,'failed');f.gate.reject(Error('failed'));await assert.rejects(p);assert.equal(f.manager.getNativeInstallExclusion().exclusiveHeld,true);}
 });
 integration('duplicate challenge and duplicate source prepare cannot replay ownership or IPC',async()=>{
  const f=await createRendererTransportFixture();await f.ready();const p=f.prepare();p.catch(()=>{});assert.equal((await f.receive(f.challenge(1))).state,'acquired');assert.equal((await f.receive(f.challenge(1))).state,'failed');await assert.rejects(f.prepare());assert.equal(f.calls.length,1);f.gate.reject(Error('held'));await assert.rejects(p);
 });
 integration('caller byte mutation after prepare cannot alter retained IPC arguments or correlation',async()=>{
  const f=await createRendererTransportFixture();await f.ready();const expected=Buffer.from(f.request),p=f.prepare();p.catch(()=>{});f.request.fill(0);assert.deepEqual(Buffer.from(f.calls[0].request),expected);f.gate.reject(Error('stop'));await assert.rejects(p);
 });
 integration('closed challenge descriptor validation never executes hostile getter',async()=>{
  const f=await createRendererTransportFixture();await f.ready();const p=f.prepare();p.catch(()=>{});let calls=0;const c=f.challenge(1);Object.defineProperty(c,'gameId',{enumerable:true,get(){calls++;return'game';}});await assert.rejects(f.receive(c));assert.equal(calls,0);f.gate.reject(Error('stop'));await assert.rejects(p);
 });
 integration('malformed final preparation cannot be accepted after three genuine owner checks',async()=>{
  const f=await createRendererTransportFixture();await f.ready();const p=f.prepare();p.catch(()=>{});for(const r of[1,2,3])await f.receive(f.challenge(r));f.gate.resolve({...f.result(),effectsAllowed:true});await assert.rejects(p);assert.equal(f.sent.length,0);
 });
 integration('boot registration failure holds native load while ordinary source call returns normally',async()=>{
  const f=await createRendererTransportFixture({register(){throw Error('own registration');}});assert.equal(f.registrations(),1);assert.doesNotThrow(()=>f.store.dispatch({type:'NOOP'}));await assert.rejects(f.prepare());
 });

 integration('changed captured preload method refuses before replacement or original callback',async()=>{
  const f=await createRendererTransportFixture();await f.ready();let nested;
  const original=f.persist.prepareNativeExecutor;
  // The receiver captured the original source method. Swapping it must refuse
  // before either replacement or original preload invocation starts.
  f.persist.prepareNativeExecutor=function(){nested=true;return original.apply(this,arguments);};
  await assert.rejects(f.prepare());assert.equal(nested,undefined);assert.equal(f.calls.length,0);
 });
 integration('a second beginLoad cannot register a replacement receiver or revive native preparation',async()=>{
  const f=await createRendererTransportFixture();await f.ready();assert.doesNotThrow(()=>f.ext.beginNativeRendererLoad(f.store));assert.equal(f.registrations(),1);await assert.rejects(f.prepare());assert.doesNotThrow(()=>f.store.dispatch({type:'NOOP'}));
 });
 integration('same source store and profile ABA are checked across the actual delayed ACK',async()=>{
  const ack=deferred(),f=await createRendererTransportFixture({ack:()=>ack.promise});await f.ready();const p=f.prepare();p.catch(()=>{});const a=f.receive(f.challenge(1));await tick();
  f.store.dispatch({type:'SETTING',payload:{key:'profiles',value:{activeProfileId:'q'}}});f.store.dispatch({type:'SETTING',payload:{key:'profiles',value:{activeProfileId:'p'}}});
  assert.equal((await a).state,'failed');ack.resolve();f.gate.reject(Error('source held'));await assert.rejects(p);assert.equal(f.sent.length,0);
 });
 integration('round4 is one-shot even after successful preparation and cannot grow a nonce history',async()=>{
  const f=await createRendererTransportFixture();await f.ready();const p=f.prepare();for(const r of[1,2,3])await f.receive(f.challenge(r));f.gate.resolve(f.result());await p;
  assert.equal((await f.receive(f.challenge(4))).state,'held');assert.equal((await f.receive(f.challenge(4,{challengeId:'challenge_'+'e'.repeat(32)}))).state,'failed');await assert.rejects(f.prepare());assert.equal(f.calls.length,1);
 });
 integration('invalid intrinsic bytes are refused before any preload invocation and never retried',async()=>{
  for(const bytes of[new Uint8Array(),new Uint8Array(new SharedArrayBuffer(8)),new Proxy(new Uint8Array([1]),{})]){const f=await createRendererTransportFixture();await f.ready();await assert.rejects(f.ext.prepareNativeExecutor(bytes,f.archive));assert.equal(f.calls.length,0);await assert.rejects(f.prepare());}
 });

 integration('actual ACK callback reentry cannot restore or duplicate a request after nested prepare refusal',async()=>{
  let current,reentered=false,nested;
  const f=await createRendererTransportFixture({getApi(){if(current&&!reentered){reentered=true;nested=current.prepare();nested.catch(()=>{});}}});
  await f.ready();current=f;const p=f.prepare();p.catch(()=>{});assert.equal((await f.receive(f.challenge(1))).state,'failed');assert.equal(reentered,true);await assert.rejects(nested);assert.equal(f.calls.length,1);f.gate.reject(Error('Main failed'));await assert.rejects(p);f.fire();assert.equal(f.sent.length,0);
 });

 integration('actual source admission independently supports underscore/hyphen active profile identities',async()=>{
  for(const profileId of['_p','-p']){const f=await createRendererTransportFixture({profileId});await f.ready();const owner=await f.acquire();assert.equal(f.ext.getNativeRendererExecutorAdmissionProjection(owner).profileId,profileId);}
 });
 integration('supported underscore/hyphen active profiles complete all three actual source owner checks',async()=>{
  for(const profileId of['_p','-p']){const f=await createRendererTransportFixture({profileId});await f.ready();const p=f.prepare();p.catch(()=>{});for(const round of[1,2,3]){const out=await f.receive(f.challenge(round));assert.equal(out.state,round===1?'acquired':'checked');assert.equal(out.observation.profileId,profileId);}f.gate.resolve(f.result());await p;assert.equal(f.acks.length,1);}
 });
 integration('invalid or different opaque profile never yields a preparation',async()=>{
  for(const profileId of['','bad.profile','bad/profile','constructor','_unknown']){const f=await createRendererTransportFixture();await f.ready();const p=f.prepare();p.catch(()=>{});const c=f.challenge(1,{profileId});if(profileId==='_unknown')assert.equal((await f.receive(c)).state,'failed');else await assert.rejects(f.receive(c));f.gate.reject(Error('Main refuses'));await assert.rejects(p);}
 });
}
