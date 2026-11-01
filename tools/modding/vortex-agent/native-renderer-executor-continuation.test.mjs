import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {createReleaseFixture,releaseRequest} from './native-registration-release.test.mjs';
import {makeTrackedObservation} from './native-renderer-registration-release.test.mjs';
const HERE=path.dirname(fileURLToPath(import.meta.url)),packet=path.join(HERE,'native-patches/vortex-persistence-2.9.1');
const sha=x=>createHash('sha256').update(x).digest('hex');
let modulePromise;
async function fixtureModule(){
 if(modulePromise)return modulePromise;
 const url=new URL('./native-renderer-executor-transport.test.mjs',import.meta.url);
 let text=fs.readFileSync(url,'utf8').replaceAll('\r\n','\n');
 const replace=(a,b)=>{assert.equal(text.split(a).length,2,a);text=text.replace(a,b);};
 const old="const next=stage('native-renderer-executor-transport');assert.equal(sha(source),next.m.inputSHA256);source=applyExact(source,next.patch,next.m.upstreamPath);assert.equal(sha(source),next.m.outputSHA256);";
 replace(old,old+"\n const continuation=stage('native-renderer-executor-continuation');assert.equal(sha(source),continuation.m.inputSHA256);source=applyExact(source,continuation.patch,continuation.m.upstreamPath);assert.equal(sha(source),continuation.m.outputSHA256);");
 replace('nativeExecutorTransportHash:createHash,window:options.transportWindow','nativeExecutorTransportHash:createHash,nativeExecutorAdopt:f.api.adoptNativeRendererTarget,window:options.transportWindow');
 text=text.replace(' text=text.replace(/from ', ' replace("getApi:transport=>{","archiveRows:options.archiveRows,getApi:transport=>{");\n text=text.replace(/from ');
 text=text.replace(/from '(\.\/[^']+)'/g,(_,p)=>'from '+JSON.stringify(new URL(p,url).href));
 text=text.replaceAll("'import.meta.url'","'__NATIVE_IMPORT_META_LITERAL__'").replaceAll('import.meta.url',JSON.stringify(url.href)).replaceAll('__NATIVE_IMPORT_META_LITERAL__','import.meta.url');
 modulePromise=import('data:text/javascript;base64,'+Buffer.from(text).toString('base64'));return modulePromise;
}
/** Actual composed ExtensionManager, real Redux/root/middleware and manager
 * source methods; full host constructors/Main transport remain facades. */
export async function createRendererContinuationFixture(options={}){
 const{createRendererTransportFixture}=await fixtureModule(),f=await createRendererTransportFixture(options),transportId=f.challenge(1).transportId;
 return{...f,transportId,
  async prepared(){await f.ready();const pending=f.prepare();for(const r of[1,2,3])assert.equal((await f.receive(f.challenge(r))).state,r===1?'acquired':'checked');f.gate.resolve(f.result());await pending;return f;},
  adopt(bytes=Buffer.from(makeTrackedObservation({operation:'2',job:'3',request:'a'}))){return f.ext.prepareNativeExecutorTransportAdoption(transportId,bytes);},
  check(){return f.ext.checkNativeExecutorTransportAdoption(transportId);}};
}
const repo=process.env.VORTEX_EXTENSION_ADMISSION_REPO,deps=process.env.VORTEX_EXTENSION_ADMISSION_DEPS;
const integration=(name,fn)=>test(name,{timeout:15000,skip:repo&&deps?false:'Set VORTEX_EXTENSION_ADMISSION_REPO and VORTEX_EXTENSION_ADMISSION_DEPS'},fn);
const encode=value=>Buffer.from(JSON.stringify(value));
const observation=()=>JSON.parse(makeTrackedObservation({operation:'2',job:'3',request:'a'}));
function retained(f){assert.equal(f.manager.getNativeInstallExclusion().exclusiveHeld,true);assert.notEqual(f.rootApi.getNativeRendererTargetStatus().phase,'not_reserved');f.fire();assert.equal(f.sent.length,0);}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 test('renderer continuation pins exact transport predecessor and has no finalization or effect authority',()=>{
  const m=JSON.parse(fs.readFileSync(path.join(packet,'native-renderer-executor-continuation.json'))),p=fs.readFileSync(path.join(packet,'native-renderer-executor-continuation.patch')),parent=JSON.parse(fs.readFileSync(path.join(packet,'native-renderer-executor-transport.json')));
  assert.equal(m.inputSHA256,parent.outputSHA256);assert.equal(m.prerequisitePatchSHA256,parent.patchSHA256);assert.equal(sha(p),m.patchSHA256);for(const k of['installed','nativeAcceptanceVerified','effectsAllowed','installationPermit','nativeAdmission','releaseSupported','powerLossPersistenceVerified'])assert.equal(m[k],false);
 });
 integration('actual prepared owners atomically adopt mod+installed association and retain real release preparation',async()=>{
  const f=await createRendererContinuationFixture();await f.prepared();f.store.dispatch({type:'SETTING',payload:{key:'beforeAdoption',value:7}});
  const result=f.adopt();assert(Object.isFrozen(result));assert.deepEqual(Object.keys(result),['schema','transportId','operationId','nativeJobId','requestSHA256','recordSHA256','fullRecordSHA256','effectsAllowed','installationPermit']);
  assert.equal(result.schema,'native-executor-renderer-adoption/1');assert.strictEqual(f.check(),result);assert.equal(result.effectsAllowed,false);assert.equal(result.installationPermit,false);
  const state=f.store.getState();assert.equal(state.persistent.mods.game.new.id,'new');assert.equal(state.persistent.mods.game.new.archiveId,'archive');assert.deepEqual(state.persistent.downloads.files.archive.installed,{gameId:'game',modId:'new'});
  assert.equal(state.persistent.profiles.p.modState,undefined);assert.equal(state.settings.beforeAdoption,7);assert.equal(f.rootApi.getNativeRendererTargetStatus().phase,'committed_protected');retained(f);
  f.store.dispatch({type:'SETTING',payload:{key:'afterAdoption',value:8}});assert.equal(f.store.getState().settings.afterAdoption,8);f.check();retained(f);
 });
 integration('actual Main committed observed2 flows into renderer without pretending adoption can undo the commit',async t=>{
  const f=await createRendererContinuationFixture();await f.prepared();
  const archive={id:'archive',state:'finished',game:['game'],localPath:'own.zip',size:12,fileMD5:'a'.repeat(32),archiveSHA256:'b'.repeat(64)};
  const main=await createReleaseFixture(t,{downloads:[archive]}),request=releaseRequest(1,{operationId:'op_'+'2'.repeat(32),nativeJobId:'exec_'+'3'.repeat(32),requestSHA256:'a'.repeat(64),archive});
  const owner=await main.reserve('game','new'),observed=await main.register(owner,request);assert.equal(observed.commitObserved,true);
  const rowCount=main.committed.size,result=f.adopt(encode(observed));assert.equal(result.fullRecordSHA256,observed.fullRecordSHA256);main.main.checkNativeNewModRegistration(owner);assert.equal(main.committed.size,rowCount);retained(f);
 });
 integration('Main commit remains committed if the actual renderer source download metadata refuses adoption',async t=>{
  const f=await createRendererContinuationFixture();await f.prepared();
  const archive={id:'archive',state:'finished',game:['game'],localPath:'own.zip',size:12,fileMD5:'a'.repeat(32),archiveSHA256:'b'.repeat(64)};
  const main=await createReleaseFixture(t,{downloads:[archive]}),request=releaseRequest(1,{operationId:'op_'+'2'.repeat(32),nativeJobId:'exec_'+'3'.repeat(32),requestSHA256:'a'.repeat(64),archive});
  const owner=await main.reserve('game','new'),observed=await main.register(owner,request),count=main.committed.size;
  f.store.dispatch({type:'DOWNLOAD',payload:{key:'localPath',value:'other.zip'}});assert.throws(()=>f.adopt(encode(observed)));assert.equal(main.committed.size,count);assert.equal(main.calls.some(c=>c.sql==='ROLLBACK'),false);main.main.checkNativeNewModRegistration(owner);retained(f);
 });
 integration('round3 alone is insufficient until the actual preparation invoke result has been validated',async()=>{
  const f=await createRendererContinuationFixture();await f.ready();const p=f.prepare();p.catch(()=>{});for(const r of[1,2,3])await f.receive(f.challenge(r));assert.throws(()=>f.adopt());assert.equal(f.store.getState().persistent.mods.game.new,undefined);f.gate.resolve(f.result());await assert.rejects(p);retained(f);
 });
 integration('foreign transport labels refuse inertly while same-owner duplicate adoption permanently holds',async()=>{
  const f=await createRendererContinuationFixture();await f.prepared();assert.throws(()=>f.ext.prepareNativeExecutorTransportAdoption('transport_'+'f'.repeat(32),encode(observation())));assert.throws(()=>f.ext.checkNativeExecutorTransportAdoption('transport_'+'f'.repeat(32)));
  f.adopt();f.check();assert.throws(()=>f.adopt());assert.throws(()=>f.check());retained(f);
 });
 integration('tuple/base/full hash or marker mismatch refuses before any reducer adoption and never retries',async()=>{
  const mutations=[o=>o.operationId='op_'+'f'.repeat(32),o=>o.nativeJobId='exec_'+'f'.repeat(32),o=>o.requestSHA256='f'.repeat(64),o=>o.fullRecordSHA256='f'.repeat(64),o=>o.recordSHA256='f'.repeat(64),o=>{const r=JSON.parse(o.recordJSON);r.attributes.__nmtNativeRegistration.operationId='op_'+'f'.repeat(32);o.recordJSON=JSON.stringify(r);o.fullRecordSHA256=sha(o.recordJSON);},o=>o.extra=true];
  for(const change of mutations){const f=await createRendererContinuationFixture();await f.prepared();const o=observation();change(o);assert.throws(()=>f.adopt(encode(o)));assert.equal(f.store.getState().persistent.mods.game.new,undefined);assert.throws(()=>f.adopt());retained(f);}
 });
 integration('byte bounds, proxies, shared buffers, duplicate keys, BOM and malformed UTF8 refuse before callbacks',async()=>{
  const raw=Buffer.from(makeTrackedObservation({operation:'2',job:'3',request:'a'}));
  const values=[new Uint8Array(),new Uint8Array(32769),new Uint8Array(new SharedArrayBuffer(raw.length)),new Proxy(raw,{get(){assert.fail('byte proxy getter');}}),Buffer.concat([Buffer.from([239,187,191]),raw]),Buffer.from(raw.toString().replace('{','{"schema":"duplicate",')),Buffer.from('{"bad":"\xff"}','latin1')];
  for(const bytes of values){const f=await createRendererContinuationFixture();await f.prepared();assert.throws(()=>f.adopt(bytes));assert.equal(f.store.getState().persistent.mods.game.new,undefined);retained(f);}
 });
 integration('current profile ABA, store or captured manager release method drift prevents adoption or invalidates retained preparation',async()=>{
  for(const mode of['profile','store','method']){const f=await createRendererContinuationFixture();await f.prepared();f.adopt();
   if(mode==='profile'){f.store.dispatch({type:'SETTING',payload:{key:'profiles',value:{activeProfileId:'q'}}});f.store.dispatch({type:'SETTING',payload:{key:'profiles',value:{activeProfileId:'p'}}});}
   if(mode==='store')f.api.store={...f.store};
   if(mode==='method')f.manager.prepareNativeRegistrationRelease=()=>assert.fail('shadow callback');
   assert.throws(()=>f.check());retained(f);
  }
 });
 integration('subscriber reentry during actual adoption cannot be swallowed into a successful release preparation',async()=>{
  const f=await createRendererContinuationFixture();await f.prepared();let called=false;f.store.subscribe(()=>{if(!called){called=true;assert.throws(()=>f.adopt());}});assert.throws(()=>f.adopt());assert.equal(called,true);assert.throws(()=>f.check());retained(f);
 });
 integration('subscriber primary and null/undefined errors remain primary while committed Main work is never rolled back',async()=>{
  for(const primary of[null,undefined]){const f=await createRendererContinuationFixture();await f.prepared();f.store.subscribe(()=>{throw primary;});let threw=false;try{f.adopt();}catch(e){threw=true;assert.equal(e,primary);}assert.equal(threw,true);assert.throws(()=>f.check());retained(f);}
 });

 integration('fresh preparation checks expose only real labels before adoption and refuse foreign labels inertly',async()=>{
  const f=await createRendererContinuationFixture();await f.prepared();assert.throws(()=>f.ext.checkNativeExecutorTransportPreparation('transport_'+'f'.repeat(32)));
  const result=f.ext.checkNativeExecutorTransportPreparation(f.transportId);assert.equal(result.schema,'native-renderer-executor-admission/1');assert.equal(result.gameId,'game');assert.equal(result.profileId,'p');assert.equal(result.effectsAllowed,false);assert.equal(Object.hasOwn(result,'owner'),false);
  f.store.dispatch({type:'SETTING',payload:{key:'unrelated',value:9}});f.ext.checkNativeExecutorTransportPreparation(f.transportId);f.adopt();assert.throws(()=>f.ext.checkNativeExecutorTransportPreparation(f.transportId));f.check();retained(f);
 });
 integration('fresh preparation check detects actual profile ABA before copy or registration',async()=>{
  const f=await createRendererContinuationFixture();await f.prepared();f.store.dispatch({type:'SETTING',payload:{key:'profiles',value:{activeProfileId:'q'}}});f.store.dispatch({type:'SETTING',payload:{key:'profiles',value:{activeProfileId:'p'}}});assert.throws(()=>f.ext.checkNativeExecutorTransportPreparation(f.transportId));assert.throws(()=>f.adopt());retained(f);
 });
 integration('captured release method getters are refused without invocation before actual adoption',async()=>{
  const f=await createRendererContinuationFixture();await f.prepared();let calls=0;Object.defineProperty(f.manager,'prepareNativeRegistrationRelease',{get(){calls++;return()=>{};}});assert.throws(()=>f.adopt());assert.equal(calls,0);assert.equal(f.store.getState().persistent.mods.game.new,undefined);retained(f);
 });
 integration('exact observed2 outer and nested key order must match actual Main canonical output',async()=>{
  for(const mode of['outer','record','marker']){const f=await createRendererContinuationFixture();await f.prepared();let o=observation();
   if(mode==='outer')o=Object.fromEntries(Object.entries(o).reverse());
   else{let r=JSON.parse(o.recordJSON);if(mode==='record')r=Object.fromEntries(Object.entries(r).reverse());else r.attributes.__nmtNativeRegistration=Object.fromEntries(Object.entries(r.attributes.__nmtNativeRegistration).reverse());o.recordJSON=JSON.stringify(r);o.fullRecordSHA256=sha(o.recordJSON);}
   assert.throws(()=>f.adopt(encode(o)));assert.equal(f.store.getState().persistent.mods.game.new,undefined);retained(f);
  }
 });

 integration('release methods replaced after actual prepared admission refuse before any substitute or adoption',async()=>{
  for(const mode of['both','prepare','check','descriptor']){const f=await createRendererContinuationFixture();await f.prepared();let calls=0;
   const prototype=f.Manager.prototype;
   if(mode==='both'||mode==='prepare')prototype.prepareNativeRegistrationRelease=function(){calls++;return Object.freeze({});};
   if(mode==='both'||mode==='check')prototype.checkNativeRegistrationRelease=function(){calls++;};
   if(mode==='descriptor'){const d=Object.getOwnPropertyDescriptor(prototype,'prepareNativeRegistrationRelease');Object.defineProperty(prototype,'prepareNativeRegistrationRelease',{...d,writable:!d.writable});}
   assert.throws(()=>f.adopt());assert.equal(calls,0);assert.equal(f.store.getState().persistent.mods.game.new,undefined);assert.equal(f.manager.mNativeRegistrationRelease,undefined);assert.throws(()=>f.check());retained(f);
  }
 });
}
