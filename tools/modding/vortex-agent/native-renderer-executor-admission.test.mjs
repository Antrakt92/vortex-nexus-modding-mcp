import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {stripTypeScriptTypes} from 'node:module';
import {types as nativeReadinessTypes} from 'node:util';
import {performance as nativeReadinessClock} from 'node:perf_hooks';
import {EventEmitter} from 'node:events';
import {applyExact} from './native-patch-test-fixture.mjs';
import {createRendererRegistrationReleaseFixture} from './native-renderer-registration-release.test.mjs';
const repo=process.env.VORTEX_EXTENSION_ADMISSION_REPO,deps=process.env.VORTEX_EXTENSION_ADMISSION_DEPS;
const HERE=path.dirname(fileURLToPath(import.meta.url)),packet=path.join(HERE,'native-patches/vortex-persistence-2.9.1');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const integration=(name,fn)=>test(name,{timeout:10000,skip:repo&&deps?false:'Set VORTEX_EXTENSION_ADMISSION_REPO and VORTEX_EXTENSION_ADMISSION_DEPS'},fn);
const stage=(name,folder=packet)=>({m:JSON.parse(fs.readFileSync(path.join(folder,name+'.json'))),patch:fs.readFileSync(path.join(folder,name+'.patch'),'utf8')});
function composed(file,until){
  const graph=JSON.parse(fs.readFileSync(path.join(HERE,'native-source-series.json'))),row=graph.files.find(row=>row.path===file);assert(row);
  let source=execFileSync('git',['-C',repo,'show','c80326367cbe6d96621ad6cf4a5488ef49bac110:'+file],{maxBuffer:2e6}).toString('utf8');
  assert.equal(sha(source),row.originalSHA256);const original=source;
  for(const r of graph.patches.filter(row=>row.path===file)){
    if(until&&sha(source)===until)break;
    const folder=path.join(HERE,'native-patches',r.packet==='lifecycle'?'vortex-2.9.1':'vortex-persistence-2.9.1'),{m,patch}=stage(r.name,folder);
    assert.equal(sha(source),m.inputSHA256);source=applyExact(source,patch,file);assert.equal(sha(source),m.outputSHA256);
  }
  return{source,original};
}
/** Actual reducer/store/middleware/InstallManager source methods; the full host
 * constructors and ordinary module initialization remain controlled facades. */
export function createExecutorAdmissionFixture(options={}){
  const f=createRendererRegistrationReleaseFixture({profiles:{p:{gameId:'game'},q:{gameId:'game'}},getApi:transport=>{
    options.getApi?.();
    return{...transport,sendDiffAcknowledged:async batches=>{await transport.sendDiffAcknowledged(batches);await options.ack?.(batches);}};
  }});
  f.store.dispatch({type:'SETTING',payload:{key:'profiles',value:{activeProfileId:'p'}}});
  f.manager.mNativeInstallScopeId='manager-fixture-1';
  const {m,patch}=stage('native-renderer-executor-admission'),base=composed(m.upstreamPath,m.inputSHA256);
  assert.equal(sha(base.source),m.inputSHA256);const source=applyExact(base.source,patch,m.upstreamPath);assert.equal(sha(source),m.outputSHA256);
  const sf=text=>f.ts.createSourceFile('input.ts',text,f.ts.ScriptTarget.Latest,true);
  function node(text,predicate){const results=[];function walk(n){if(predicate(n))results.push(n.getText());f.ts.forEachChild(n,walk);}walk(sf(text));assert.equal(results.length,1);return results[0];}
  const variable=(text,name)=>node(text,n=>f.ts.isVariableStatement(n)&&n.declarationList.declarations.some(d=>d.name.getText()===name));
  const fn=(text,name)=>node(text,n=>f.ts.isFunctionDeclaration(n)&&n.name?.text===name);
  const cls=(text,name)=>node(text,n=>f.ts.isClassDeclaration(n)&&n.name?.text===name);
  const evaluate=(text,result,context={})=>new Function(...Object.keys(context),stripTypeScriptTypes(text.replace(/^export /gm,''),{mode:'transform'})+'\nreturn '+result+';')(...Object.values(context));
  const c=sf(source).statements.find(n=>f.ts.isClassDeclaration(n)&&n.name?.text==='ExtensionManager');
  const members=c.members.filter(n=>/Native|nativeExecutor|nativeManagerExport|mNative|getApi|getExtensionInitFunc/.test(n.name?.getText()??''));
  const Class=evaluate('class ExtensionManager{\n'+members.map(n=>n.getText()).join('\n')+'\n}','ExtensionManager',{
    ...f.api,...f.middleware,nativeReadinessTypes,nativeReadinessClock,setTimeout,clearTimeout});
  const api={store:f.store,getState:()=>f.store.getState(),ext:{},events:new EventEmitter()};
  const Handler=evaluate(cls(base.original,'APIProxyHandler'),'APIProxyHandler',{ExtEventHandler:class{constructor(events){this.events=events;}}});
  const proxy=new Proxy(api,new Handler({name:'mod_management',namespace:'mod_management'},true,new EventEmitter()));f.manager.mApi=proxy;
  const index=composed('src/renderer/src/extensions/mod_management/index.ts').source;
  const names=['holdNativeManagerStartup','checkNativeManagerStartup','beginNativeManagerStartup','waitForNativeManagerStartupReady','checkNativeManagerStartupReady','getNativeManagerStartupInstance'];
  let run,state;
  const registration=node(index,n=>f.ts.isExpressionStatement(n)&&f.ts.isCallExpression(n.expression)&&n.expression.expression.getText()==='context.once');
  state=evaluate(variable(index,'installManager')+'\n'+variable(index,'nativeManagerStartup')+'\n'+names.map(n=>fn(index,n)).join('\n')+'\n'+registration,
    '({waitForNativeManagerStartupReady,checkNativeManagerStartupReady,getNativeManagerStartupInstance,setManager:value=>installManager=value})',{
      context:{api:proxy,once:cb=>run=cb},once:()=>state.setManager(f.manager),extendApi:()=>({}),history:{init:()=>options.history?.()}});
  const exports={default:()=>{},waitForNativeManagerStartupReady:state.waitForNativeManagerStartupReady,checkNativeManagerStartupReady:state.checkNativeManagerStartupReady,getNativeManagerStartupInstance:state.getNativeManagerStartupInstance};
  const namespace={__esModule:true};for(const key of Object.keys(exports))Object.defineProperty(namespace,key,{enumerable:true,configurable:true,get:()=>exports[key]});
  const ext=new Class();ext.mApi=api;
  const loader=evaluate('function load(){'+variable(source,'staticExtensions')+'\n'+variable(source,'staticExts')+'\nreturn staticExts;}','load',{
    ExtensionManager:Class,path,__dirname:'/owned/renderer',require:name=>{assert.equal(name,'./extensions/mod_management/index.ts');return namespace;}});
  const entry=loader.call(ext).find(row=>row.name==='mod_management');entry.initFunc();
  const loadRaw=deferred(),loadOwner=ext.beginNativeRendererLoad(f.store);ext.observeNativeRendererLoad(loadOwner,loadRaw.promise);
  options.configure?.({f,ext,api,proxy,state,Class});
  return{...f,rootApi:f.api,ext,Class,api,proxy,exports,loadRaw,loadOwner,state,runOnce:()=>run(),
    async ready(){run();loadRaw.resolve();await tick();},acquire:()=>ext.acquireNativeRendererExecutorAdmission('game','new')};
}

if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
test('renderer executor patch pins source and real target/middleware companion without START or IPC',()=>{
  const {m,patch}=stage('native-renderer-executor-admission'),parent=stage('native-static-manager-binding').m,companion=stage('renderer-registration-release').m;
  assert.equal(sha(patch),m.patchSHA256);assert.equal(m.inputSHA256,parent.outputSHA256);assert.equal(m.prerequisitePatchSHA256,parent.patchSHA256);
  assert.equal(m.requiredCompanionPatchSHA256,companion.patchSHA256);assert.equal(m.requiredCompanionOutputSHA256,companion.outputSHA256);
  for(const key of ['installed','nativeAcceptanceVerified','installationPermit','powerLossPersistenceVerified','releaseSupported'])assert.equal(m[key],false);
});
integration('real manager→target→old ACK hold sequence yields only an opaque token and closed actual labels',async()=>{
  const gate=deferred(),f=createExecutorAdmissionFixture({ack:()=>gate.promise});await f.ready();
  const acquiring=f.acquire();let done=false;acquiring.then(()=>{done=true;},()=>{done=true;});await tick();
  assert.equal(done,false);assert.equal(f.manager.getNativeInstallExclusion().exclusiveHeld,true);assert.equal(f.rootApi.getNativeRendererTargetStatus().phase,'reserved');
  assert.equal(f.acks.length,1);assert.equal(f.sent.length,0);
  f.store.dispatch({type:'SETTING',payload:{key:'unrelated',value:7}});f.fire();assert.equal(f.sent.length,0);
  gate.resolve();const token=await acquiring;assert(Object.isFrozen(token));assert.deepEqual(Object.keys(token),[]);
  f.ext.checkNativeRendererExecutorAdmission(token);
  const labels=f.ext.getNativeRendererExecutorAdmissionProjection(token);
  assert.deepEqual(Object.keys(labels),['schema','gameId','modId','profileId','managerScopeId','rendererGeneration','effectsAllowed','installationPermit']);
  assert.equal(labels.profileId,'p');assert.equal(labels.gameId,'game');assert.equal(labels.modId,'new');assert.equal(labels.effectsAllowed,false);assert.equal(labels.installationPermit,false);
  assert.equal(f.store.getState().settings.unrelated,7);assert.equal(f.sent.length,0);
  assert.throws(()=>f.ext.checkNativeRendererExecutorAdmission({}));f.ext.checkNativeRendererExecutorAdmission(token);
});
integration('actual renderer load and once tail must finish before any manager exclusion',async()=>{
  const f=createExecutorAdmissionFixture(),acquiring=f.acquire();await tick();assert.equal(f.manager.getNativeInstallExclusion().exclusiveHeld,false);
  f.runOnce();await tick();assert.equal(f.manager.getNativeInstallExclusion().exclusiveHeld,false);
  f.loadRaw.resolve();const token=await acquiring;f.ext.checkNativeRendererExecutorAdmission(token);
});
integration('old acknowledged flush failure leaves all acquired ownership closed and cannot rearm',async()=>{
  const primary=Error('own old ACK failed'),f=createExecutorAdmissionFixture({ack:()=>Promise.reject(primary)});await f.ready();
  await assert.rejects(f.acquire(),error=>error===primary);assert.equal(f.manager.getNativeInstallExclusion().exclusiveHeld,true);
  assert.equal(f.rootApi.getNativeRendererTargetStatus().phase,'reserved');await assert.rejects(f.acquire());assert.equal(f.sent.length,0);
});
integration('profile ABA during blocked ACK permanently invalidates admission while ordinary dispatch continues',async()=>{
  const gate=deferred(),f=createExecutorAdmissionFixture({ack:()=>gate.promise});await f.ready();const acquiring=f.acquire();acquiring.catch(()=>{});await tick();
  assert.doesNotThrow(()=>f.store.dispatch({type:'SETTING',payload:{key:'profiles',value:{activeProfileId:'q'}}}));
  assert.doesNotThrow(()=>f.store.dispatch({type:'SETTING',payload:{key:'profiles',value:{activeProfileId:'p'}}}));
  gate.resolve();await assert.rejects(acquiring);await assert.rejects(f.acquire());assert.equal(f.manager.getNativeInstallExclusion().exclusiveHeld,true);assert.equal(f.sent.length,0);
});
integration('profile invalidation rejects observer while raw renderer load remains unresolved',async()=>{
  const f=createExecutorAdmissionFixture(),acquiring=f.acquire();let settled=false,granted=false;
  acquiring.then(()=>{settled=true;granted=true;},()=>{settled=true;});await tick();
  try{
    f.store.dispatch({type:'SETTING',payload:{key:'profiles',value:{activeProfileId:'q'}}});
    f.store.dispatch({type:'SETTING',payload:{key:'profiles',value:{activeProfileId:'p'}}});
    await tick();assert.equal(settled,true,'Held observer must reject without waiting for raw load');assert.equal(granted,false);
    assert.equal(f.manager.getNativeInstallExclusion().exclusiveHeld,false);assert.equal(f.acks.length,0);
  }finally{f.runOnce();f.loadRaw.resolve();await acquiring.catch(()=>{});}
  await tick();assert.equal(granted,false);await assert.rejects(f.acquire());
});
integration('profile invalidation rejects observer while old ACK stays pending and late rejection is consumed',async()=>{
  const gate=deferred(),f=createExecutorAdmissionFixture({ack:()=>gate.promise});await f.ready();
  const acquiring=f.acquire();let settled=false,granted=false;
  acquiring.then(()=>{settled=true;granted=true;},()=>{settled=true;});await tick();
  try{
    f.store.dispatch({type:'SETTING',payload:{key:'profiles',value:{activeProfileId:'q'}}});
    f.store.dispatch({type:'SETTING',payload:{key:'profiles',value:{activeProfileId:'p'}}});
    await tick();assert.equal(settled,true,'Held observer must reject without waiting for ACK');assert.equal(granted,false);
    assert.equal(f.manager.getNativeInstallExclusion().exclusiveHeld,true);assert.equal(f.rootApi.getNativeRendererTargetStatus().phase,'reserved');
    assert.equal(f.acks.length,1);assert.equal(f.sent.length,0);
  }finally{gate.reject(Error('own late ACK rejection'));await acquiring.catch(()=>{});}
  await tick();assert.equal(granted,false);assert.equal(f.sent.length,0);await assert.rejects(f.acquire());
});
integration('late renderer-load rejection is observed after admission invalidation without excluding a manager',async()=>{
  const f=createExecutorAdmissionFixture(),acquiring=f.acquire();let settled=false,granted=false;
  acquiring.then(()=>{settled=true;granted=true;},()=>{settled=true;});await tick();
  try{
    f.store.dispatch({type:'SETTING',payload:{key:'profiles',value:{activeProfileId:'q'}}});
    await tick();assert.equal(settled,true);assert.equal(granted,false);
  }finally{f.runOnce();f.loadRaw.reject(Error('own late renderer load failure'));await acquiring.catch(()=>{});}
  await tick();assert.equal(granted,false);assert.equal(f.manager.getNativeInstallExclusion().exclusiveHeld,false);
  assert.equal(f.acks.length,0);await assert.rejects(f.acquire());
});
integration('late ACK fulfillment cannot issue a token or release acquired gates after observer invalidation',async()=>{
  const gate=deferred(),f=createExecutorAdmissionFixture({ack:()=>gate.promise});await f.ready();
  const acquiring=f.acquire();let settled=false,granted=false;
  acquiring.then(()=>{settled=true;granted=true;},()=>{settled=true;});await tick();
  try{
    f.store.dispatch({type:'SETTING',payload:{key:'profiles',value:{activeProfileId:'q'}}});
    f.store.dispatch({type:'SETTING',payload:{key:'retainedAfterInvalidation',value:19}});
    await tick();assert.equal(settled,true);assert.equal(granted,false);
  }finally{gate.resolve();await acquiring.catch(()=>{});}
  await tick();f.fire();assert.equal(granted,false);assert.equal(f.manager.getNativeInstallExclusion().exclusiveHeld,true);
  assert.equal(f.rootApi.getNativeRendererTargetStatus().phase,'reserved');assert.equal(f.store.getState().settings.retainedAfterInvalidation,19);
  assert.equal(f.sent.length,0);await assert.rejects(f.acquire());
});
integration('source getApi reentry cannot overwrite private attempt or release acquired owners',async()=>{
  let f,entered=false,inner;
  f=createExecutorAdmissionFixture({getApi(){if(f&&!entered){entered=true;inner=f.acquire();inner.catch(()=>{});}}});await f.ready();
  await assert.rejects(f.acquire());await assert.rejects(inner);assert(entered);assert.equal(f.manager.getNativeInstallExclusion().exclusiveHeld,true);assert.equal(f.sent.length,0);
});
integration('wrong source store and accessor subscription refuse before callbacks or exclusion',async()=>{
  for(const mode of ['store','subscribe']){
    let callbacks=0;const f=createExecutorAdmissionFixture();await f.ready();
    if(mode==='store')f.api.store={};else Object.defineProperty(f.store,'subscribe',{configurable:true,get(){callbacks++;return()=>{};}});
    await assert.rejects(f.acquire());assert.equal(callbacks,0);assert.equal(f.manager.getNativeInstallExclusion().exclusiveHeld,false);
  }
});
integration('fake reserve result and changed manager method references cannot certify exclusion',async()=>{
  const f=createExecutorAdmissionFixture();await f.ready();const original=f.Manager.prototype.reserveNativeInstallExclusion;
  f.Manager.prototype.reserveNativeInstallExclusion=function(){original.call(this);return undefined;};
  await assert.rejects(f.acquire());assert.equal(f.manager.getNativeInstallExclusion().exclusiveHeld,true);
  const g=createExecutorAdmissionFixture();await g.ready();const token=await g.acquire(),saved=g.Manager.prototype.checkNativeInstallExclusion;
  g.Manager.prototype.checkNativeInstallExclusion=function(){};assert.throws(()=>g.ext.checkNativeRendererExecutorAdmission(token));
  g.Manager.prototype.checkNativeInstallExclusion=saved;assert.throws(()=>g.ext.checkNativeRendererExecutorAdmission(token));
});
integration('private slot brand rejects a prototype-only receiver; malformed IDs have no owner effects',async()=>{
  const f=createExecutorAdmissionFixture();await f.ready();await assert.rejects(f.ext.acquireNativeRendererExecutorAdmission.call(Object.create(f.Class.prototype),'game','new'));
  await assert.rejects(f.ext.acquireNativeRendererExecutorAdmission('game','../new'));assert.equal(f.manager.getNativeInstallExclusion().exclusiveHeld,false);
});
integration('method drift inside actual manager diagnostic getter is caught before target reservation',async()=>{
  const f=createExecutorAdmissionFixture();await f.ready();let changed=false;
  Object.defineProperty(f.manager,'mNativeInstallScopeId',{configurable:true,get(){
    if(!changed){changed=true;f.Manager.prototype.checkNativeInstallExclusion=function(){};}
    return 'manager-fixture-1';
  }});
  await assert.rejects(f.acquire());assert(changed);assert.equal(f.rootApi.getNativeRendererTargetStatus().phase,'not_reserved');
  assert.equal(f.manager.getNativeInstallExclusion().exclusiveHeld,true);
});
integration('swallowed ordinary once failure never becomes native manager readiness',async()=>{
  const primary=Error('own history initialization failed'),f=createExecutorAdmissionFixture({history(){throw primary;}});
  const acquiring=f.acquire();acquiring.catch(()=>{});await tick();
  assert.throws(()=>f.runOnce(),error=>error===primary);f.loadRaw.resolve();
  await assert.rejects(acquiring);assert.equal(f.manager.getNativeInstallExclusion().exclusiveHeld,false);
  assert.equal(f.rootApi.getNativeRendererTargetStatus().phase,'not_reserved');
});
integration('publisher throw preserves primary and private hold; later ordinary dispatch remains ordinary',async()=>{
  const f=createExecutorAdmissionFixture();await f.ready();const original=f.store.subscribe,primary=Error('own subscribe failure');let calls=0;
  f.store.subscribe=function(listener){calls++;original.call(this,listener);throw primary;};
  await assert.rejects(f.acquire(),error=>error===primary);await assert.rejects(f.acquire());assert.equal(calls,1);
  assert.doesNotThrow(()=>f.store.dispatch({type:'SETTING',payload:{key:'ordinaryAfterFailure',value:1}}));
  assert.equal(f.store.getState().settings.ordinaryAfterFailure,1);assert.equal(f.manager.getNativeInstallExclusion().exclusiveHeld,false);
});
integration('existing target refusal keeps manager exclusion and never starts the ACK flush',async()=>{
  const f=createExecutorAdmissionFixture();await f.ready();f.store.dispatch({type:'ADD',payload:{id:'new',state:'installed'}});
  await assert.rejects(f.acquire());assert.equal(f.manager.getNativeInstallExclusion().exclusiveHeld,true);assert.equal(f.acks.length,0);
  assert.equal(f.store.getState().persistent.mods.game.new.state,'installed');
});
}
