import {applyRendererCancellationStage} from './native-cancellation-source-fixture.mjs';
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
import {createRendererInertReleaseFixture as createRendererRegistrationReleaseFixture} from './native-cancellation-renderer-release-fixture.mjs';
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
export function createCoordinatorAdmissionFixture(options={}){
  const f=createRendererRegistrationReleaseFixture({profiles:{p:{gameId:options.gameId??'game'},q:{gameId:options.gameId??'game'}},archiveRows:options.archiveRows,getApi:transport=>{
    options.getApi?.();
    return{...transport,sendDiffAcknowledged:async batches=>{await transport.sendDiffAcknowledged(batches);await options.ack?.(batches);}};
  }});
  f.store.dispatch({type:'SETTING',payload:{key:'profiles',value:{activeProfileId:'p'}}});
  f.manager.mNativeInstallScopeId='manager-fixture-1';
  const {m,patch}=stage('native-renderer-executor-admission'),base=composed(m.upstreamPath,m.inputSHA256);
  assert.equal(sha(base.source),m.inputSHA256);let source=applyExact(base.source,patch,m.upstreamPath);assert.equal(sha(source),m.outputSHA256);
  for(const name of ['native-renderer-executor-transport','native-renderer-executor-continuation','native-renderer-executor-completion','native-renderer-executor-successor']){const next=stage(name);assert.equal(sha(next.patch),next.m.patchSHA256);assert.equal(sha(source),next.m.inputSHA256);source=applyExact(source,next.patch,next.m.upstreamPath);assert.equal(sha(source),next.m.outputSHA256);}
  source=applyRendererCancellationStage(source,'native-renderer-executor-cancellation');
  const sf=text=>f.ts.createSourceFile('input.ts',text,f.ts.ScriptTarget.Latest,true);
  function node(text,predicate){const results=[];function walk(n){if(predicate(n))results.push(n.getText());f.ts.forEachChild(n,walk);}walk(sf(text));assert.equal(results.length,1);return results[0];}
  const variable=(text,name)=>node(text,n=>f.ts.isVariableStatement(n)&&n.declarationList.declarations.some(d=>d.name.getText()===name));
  const fn=(text,name)=>node(text,n=>f.ts.isFunctionDeclaration(n)&&n.name?.text===name);
  const cls=(text,name)=>node(text,n=>f.ts.isClassDeclaration(n)&&n.name?.text===name);
  const evaluate=(text,result,context={})=>new Function(...Object.keys(context),stripTypeScriptTypes(text.replace(/^export /gm,''),{mode:'transform'})+'\nreturn '+result+';')(...Object.values(context));
  const c=sf(source).statements.find(n=>f.ts.isClassDeclaration(n)&&n.name?.text==='ExtensionManager');
  const members=c.members.filter(n=>/Native|nativeCancellation|nativeSuccessor|nativeTransport|nativeExecutor|nativeManagerExport|mNative|getApi|getExtensionInitFunc/.test(n.name?.getText()??''));
  const Class=evaluate('class ExtensionManager{\n'+members.map(n=>n.getText()).join('\n')+'\n}','ExtensionManager',{
    ...f.api,...f.middleware,nativeReadinessTypes,nativeReadinessClock,setTimeout,clearTimeout,nativeExecutorTransportHash:createHash,nativeExecutorAdopt:f.api.adoptNativeRendererTarget,window:options.transportWindow});
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
