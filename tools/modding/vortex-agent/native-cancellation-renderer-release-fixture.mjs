import {applyRendererCancellationStage} from './native-cancellation-source-fixture.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import path from 'node:path';
import {readFileSync,readdirSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createRequire,stripTypeScriptTypes} from 'node:module';
import {createHash,randomBytes} from 'node:crypto';
import {types as nativeTypes} from 'node:util';
import {applyExact,extractClassDeclaration} from './native-patch-test-fixture.mjs';
import {fileURLToPath} from 'node:url';
const base=new URL('./native-patches/vortex-persistence-2.9.1/',import.meta.url);
const m=JSON.parse(readFileSync(new URL('renderer-target-fence.json',base)));
const bm=JSON.parse(readFileSync(new URL('renderer-store-binding.json',base)));
const bp=readFileSync(new URL('renderer-store-binding.patch',base),'utf8');
const im=JSON.parse(readFileSync(new URL('renderer-store-initialization.json',base)));
const am=JSON.parse(readFileSync(new URL('renderer-owned-mod-adoption.json',base))),mm=JSON.parse(readFileSync(new URL('renderer-persistence-adoption.json',base)));
const ap=readFileSync(new URL('renderer-owned-mod-adoption.patch',base),'utf8'),mp=readFileSync(new URL('renderer-persistence-adoption.patch',base),'utf8');
const ip=readFileSync(new URL('renderer-store-initialization.patch',base),'utf8');
const patch=readFileSync(new URL('renderer-target-fence.patch',base),'utf8');
const sha=x=>createHash('sha256').update(x).digest('hex');
const repo=process.env.VORTEX_EXTENSION_ADMISSION_REPO,deps=process.env.VORTEX_EXTENSION_ADMISSION_DEPS;
const integration=(name,fn)=>test(name,{timeout:10000,skip:repo&&deps?false:'Set VORTEX_EXTENSION_ADMISSION_REPO and VORTEX_EXTENSION_ADMISSION_DEPS'},fn);
let cached;
function inputs(){
 if(cached)return cached;
 const req=createRequire(import.meta.url);
 function lib(relative,digest,entry='index.js'){
  const folder=path.join(deps,'.pnpm',relative,'lib'),rows=[];
  function walk(dir){for(const e of readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name<b.name?-1:1)){
   const full=path.join(dir,e.name);if(e.isDirectory())walk(full);else if(e.isFile()&&e.name.endsWith('.js'))rows.push({file:path.relative(folder,full).split(path.sep).join('/'),sha256:sha(readFileSync(full))});else assert.ok(e.isFile());}}
  walk(folder);assert.equal(sha(JSON.stringify(rows)),digest);return req(path.join(folder,entry));
 }
 const redux=lib('redux@4.2.1/node_modules/redux','6bdb7c6337de0a11e1291b3ac3cf34c63468cd845dd98cccd320b44238969b6e','redux.js');
 const act=lib('redux-act@1.8.0/node_modules/redux-act','39ac092d7638d1ea5a7d3d8f3ad52d1aa96b7e2e042fb7431e919cd8bcd82b6d');
 const batching=lib('redux-batched-actions@0.5.0_redux@4.2.1/node_modules/redux-batched-actions','e12ecbaa555ba0f4cc8590f9adadf5b26858aa8b02b739fcd896c91f83af8fc8');
 const tsFile=path.join(deps,'.pnpm/typescript@6.0.3/node_modules/typescript/lib/typescript.js');
 assert.equal(sha(readFileSync(tsFile)),'569177652966bd528c319171c7dd22860dbf72bde116cbc4f644f1d02bb12e39');const ts=req(tsFile);
 function source(file,pin){const s=execFileSync('git',['-C',repo,'show',m.upstreamCommit+':src/renderer/src/'+file],{maxBuffer:2e6}).toString('utf8');assert.equal(sha(s),pin);return s;}
 const raw=source('reducers/index.ts',m.inputSHA256);
 const helper=source('util/storeHelper.ts','f54ab78f17df20db0e53f071fc727364d5a66c3380af271933d7203be3d31a28');
 const deep=source('util/deepMerge.ts','bb84a5c120c392a9fbd082ac318f59e6a031a88f3351d4eaa0390413ce517cf2');
 function named(text,name){const sf=ts.createSourceFile('input.ts',text,ts.ScriptTarget.Latest,true),found=[];function walk(n){if(ts.isFunctionDeclaration(n)&&n.name?.text===name)found.push(n.getText(sf));ts.forEachChild(n,walk);}walk(sf);assert.equal(found.length,1);return found[0];}
 const run=(text,context={})=>new Function(...Object.keys(context),stripTypeScriptTypes(text.replace(/^export /gm,''),{mode:'transform'}).replace(/\n([A-Za-z]+);\s*$/, '\nreturn $1;'))(...Object.values(context));
 const setSafe=run(named(helper,'setSafe')+'\nsetSafe;');
 const deleteOrNop=run(named(helper,'clone')+'\n'+named(helper,'deleteOrNop')+'\ndeleteOrNop;');
 const getSafe=run(named(helper,'getSafe')+'\ngetSafe;');
 const rehydrate=run(named(helper,'merge')+'\n'+named(helper,'rehydrate')+'\nrehydrate;',{getSafe,setSafe});
 const deepMerge=run(named(deep,'pick')+'\n'+named(deep,'deepMerge')+'\ndeepMerge;');
 const out=applyExact(raw,patch,m.upstreamPath);assert.equal(sha(out),m.outputSHA256);
 const bound=applyExact(out,bp,m.upstreamPath);assert.equal(sha(bound),bm.outputSHA256);
 cached={raw,out:bound,redux,act,batching,ts,setSafe,deleteOrNop,deepMerge,getSafe,rehydrate};return cached;
}
export function createRendererInertReleaseFixture({observeArms,timerFailure,timerHook,timerSync=false,managerState,archiveRows,absentGame=false,baseline=false,downloadExtra={},profiles={p:{gameId:'game'}},row={},extra={},getApi,outer}={}) {
 const i=inputs(),empty={reducers:{},defaults:{}},timers=new Map(),sent=[],acks=[],notifications=[];let timer=0;
 function executable(text){const sf=i.ts.createSourceFile('source.ts',text,i.ts.ScriptTarget.Latest,true);for(const n of sf.statements.filter(n=>i.ts.isImportDeclaration(n)||i.ts.isExportDeclaration(n)).reverse())text=text.slice(0,n.pos)+text.slice(n.end);return stripTypeScriptTypes(text.replace(/^export default reducers;/m,'').replace(/^export /gm,''),{mode:'transform'});}
 const rawDiff=execFileSync('git',['-C',repo,'show',m.upstreamCommit+':src/renderer/src/store/stateDiff.ts'],{maxBuffer:2e6}).toString('utf8');assert.equal(sha(rawDiff),'3f7a243baa908f0fc1143d50df4ba1352dde33d445f19c24675bbdf4df6dd7e9');
 const computeStateDiff=new Function(executable(rawDiff)+'\nreturn computeStateDiff;')();
 const fm=JSON.parse(readFileSync(new URL('renderer-acknowledged-flush.json',base))),hm=JSON.parse(readFileSync(new URL('renderer-acknowledged-hold.json',base)));
 const rawMid=execFileSync('git',['-C',repo,'show',m.upstreamCommit+':src/renderer/src/store/persistDiffMiddleware.ts'],{maxBuffer:2e6}).toString('utf8');assert.equal(sha(rawMid),fm.inputSHA256);
 const ack=applyExact(rawMid,readFileSync(new URL('renderer-acknowledged-flush.patch',base),'utf8'),fm.upstreamPath),held=applyExact(ack,readFileSync(new URL('renderer-acknowledged-hold.patch',base),'utf8'),fm.upstreamPath);assert.equal(sha(held),mm.inputSHA256);
 const adopted=applyExact(held,mp,mm.upstreamPath);assert.equal(sha(adopted),mm.outputSHA256);const releaseMid=JSON.parse(readFileSync(new URL('renderer-persistence-release.json',base))),mid=applyExact(adopted,readFileSync(new URL('renderer-persistence-release.patch',base),'utf8'),mm.upstreamPath);assert.equal(sha(mid),releaseMid.outputSHA256);
 const names=['createPersistDiffMiddleware','acquireNativePersistenceFlushHold','checkNativePersistenceFlushHold','releaseNativePersistenceFlushHold'];const helperNames=['prepareNativePersistenceInertRelease','checkNativePersistenceInertRelease','armNativePersistenceInertRelease','failNativePersistenceInertRelease','createNativePersistenceAdoption','consumeNativePersistenceAdoption','finishNativePersistenceAdoption','failNativePersistenceAdoption','failNativePersistenceFlushAdoption','checkNativeAdoptionRecord','checkNativeAdoptionDownload','prepareNativePersistenceRegistrationRelease','checkNativePersistenceRegistrationRelease','armNativePersistenceRegistrationRelease','failNativePersistenceRegistrationRelease'];
 const ctx={nativeAdoptionHash:createHash,nativeAdoptionTypes:nativeTypes,Buffer,TextEncoder,computeStateDiff,getErrorMessageOrDefault:()=> 'fixture',log:()=>{},setTimeout:fn=>{if(timerFailure?.())throw Error('fixture timer');timerHook?.();if(timerSync)fn();timers.set(++timer,fn);return timer;},clearTimeout:id=>timers.delete(id)};
 const middleware=new Function(...Object.keys(ctx),executable(candidate('middleware',mid))+'\nreturn ({'+names.concat(baseline?[]:helperNames).join(',')+'});')(...Object.values(ctx));
 const adoptedRoot=applyExact(i.out,ap,am.upstreamPath);assert.equal(sha(adoptedRoot),am.outputSHA256);const releaseRoot=JSON.parse(readFileSync(new URL('renderer-registration-release.json',base))),root=applyExact(adoptedRoot,readFileSync(new URL('renderer-registration-release.patch',base),'utf8'),am.upstreamPath);assert.equal(sha(root),releaseRoot.outputSHA256);
 const rootContext={...middleware,nativeTypes,combineReducers:i.redux.combineReducers,createReducer:i.act.createReducer,enableBatching:i.batching.enableBatching,
 pick:(obj,keys)=>Object.fromEntries(keys.filter(k=>Object.hasOwn(obj,k)).map(k=>[k,obj[k]])),unknownToError:x=>x,deepMerge:i.deepMerge,setSafe:i.setSafe,deleteOrNop:i.deleteOrNop,getSafe:i.getSafe,rehydrate:i.rehydrate,setImmediate:fn=>notifications.push(fn),log:()=>{},...Object.fromEntries(['appReducer','devToolsReducer','downloadsReducer','loReducer','notificationsReducer','notificationSettingsReducer','sessionReducer','tableReducer','toolbarReducer','userReducer','windowReducer'].map(k=>[k,{reducers:{},defaults:{}}]))};
 // Passive test instrumentation retains ACTUAL returned source finalizers.
 for(const name of ['armNativePersistenceRegistrationRelease','armNativePersistenceInertRelease']){
  rootContext[name]=(...args)=>{const child=middleware[name](...args);observeArms?.(name,child);return child;};
 }
 const api=new Function(...Object.keys(rootContext),executable(candidate('root',root))+'\nreturn ({reducers,reserveNativeRendererTarget,checkNativeRendererTarget,getNativeRendererTargetStatus,bindNativeRendererStore'+',prepareNativeRendererTargetInertRelease,checkNativeRendererTargetInertRelease,armNativeRendererTargetInertRelease,failNativeRendererTargetInertRelease,adoptNativeRendererTarget,prepareNativeRendererTargetRelease,checkNativeRendererTargetRelease,armNativeRendererTargetRelease,failNativeRendererTargetRelease'+'});')(...Object.values(rootContext));
 const archive={state:'finished',game:['game'],localPath:'own.zip',size:12,fileMD5:'a'.repeat(32),other:{preserve:true},...row};
 const exts=[{path:['persistent','mods'],reducer:{defaults:absentGame?{}:{game:{}},reducers:{ADD:(s,p)=>i.setSafe(s,['game',p.id],p),REMOVE:(s,p)=>i.deleteOrNop(s,['game',p.id]),IMPURE:(s,p)=>{s.game.new.state=p;return s;},...extra}}},
 {path:['persistent','profiles'],reducer:{defaults:profiles,reducers:{FLAGS:(s,p)=>i.setSafe(s,[p.profile,'modState',p.id],{enabled:false})}}},
 {path:['persistent','downloads'],reducer:{defaults:{files:archiveRows??{archive,archive2:{...archive,localPath:"own2.zip"}}},reducers:{DOWNLOAD:(s,p)=>i.setSafe(s,['files','archive',p.key],p.value),...downloadExtra}}},
 {path:['settings'],reducer:{defaults:{},reducers:{SETTING:(s,p)=>i.setSafe(s,[p.key],p.value)}}}];
 const transport={sendDiff:(hive,ops)=>sent.push({hive,operations:structuredClone(ops)}),sendDiffAcknowledged:async batches=>{acks.push(structuredClone(batches));}};
 let actualMiddlewareAPI;const factory=middleware.createPersistDiffMiddleware(()=>getApi?getApi(transport):transport),enhancers=[api=>{actualMiddlewareAPI=api;return factory(api);}];if(outer)enhancers.push(outer);
 const store=i.redux.createStore(api.reducers(exts,()=>{}),i.redux.applyMiddleware(...enhancers));assert.equal(api.bindNativeRendererStore(store),true);store.dispatch({type:'NOOP'});
 const fire=()=>{for(const[id,fn]of [...timers]){timers.delete(id);fn();}};
 const life=new URL('./native-patches/vortex-2.9.1/',import.meta.url),managerPath='src/renderer/src/extensions/mod_management/InstallManager.ts';
 const graph=JSON.parse(readFileSync(new URL('./native-source-series.json',import.meta.url))),managerOriginal=graph.files.find(r=>r.path===managerPath);assert.ok(managerOriginal);
 let managerSource=execFileSync('git',['-C',repo,'show',m.upstreamCommit+':'+managerPath],{maxBuffer:2e6}).toString('utf8');assert.equal(sha(managerSource),managerOriginal.originalSHA256);
 for(const row of graph.patches.filter(r=>r.path===managerPath)){
  if(row.name==='native-manager-registration-release')break;
  assert.equal(row.packet,'lifecycle');const manifest=JSON.parse(readFileSync(new URL(row.name+'.json',life)));assert.equal(sha(managerSource),manifest.inputSHA256);managerSource=applyExact(managerSource,readFileSync(new URL(row.name+'.patch',life),'utf8'),managerPath);assert.equal(sha(managerSource),manifest.outputSHA256);
 }
 const rm=JSON.parse(readFileSync(new URL('native-manager-registration-release.json',life)));assert.equal(sha(managerSource),rm.inputSHA256);managerSource=applyExact(managerSource,readFileSync(new URL('native-manager-registration-release.patch',life),'utf8'),managerPath);assert.equal(sha(managerSource),rm.outputSHA256);
 class ProcessCanceled extends Error {}
 const managerGlobals={...api,randomBytes,utilTypes:nativeTypes,ProcessCanceled};
 for(const name of ['armNativeRendererTargetRelease','armNativeRendererTargetInertRelease']){
  managerGlobals[name]=(...args)=>{const child=api[name](...args);observeArms?.(name,child);return child;};
 }
 const Manager=new Function(...Object.keys(managerGlobals),extractClassDeclaration(candidate('manager',managerSource))+'\nreturn InstallManager;')(...Object.values(managerGlobals));
 // Actual source methods on a controlled prototype fixture; no constructor/host.
 const manager=Object.create(Manager.prototype);Object.assign(manager,{mApi:{getState:()=>managerState?managerState(store.getState()):store.getState()},mPendingInstalls:new Map(),mActiveInstalls:new Map(),mNativeInstallActivities:new Map(),mOptionalDownloadsInFlight:new Set(),mDependencyInstalls:{},mNativeRegistrationReleaseDepth:0,mNativeInertReleaseDepth:0});
 return {api,middleware,store,actualMiddlewareAPI,archive,sent,acks,fire,timers,manager,Manager,...i,
  async owners(modId='new'){const managerOwner=manager.reserveNativeInstallExclusion(),flush=await middleware.acquireNativePersistenceFlushHold(),root=api.reserveNativeRendererTarget('game',modId);return{root,flush,manager:managerOwner};},
  adopt(o,response=makeTrackedObservation()){api.adoptNativeRendererTarget(o.root,o.flush,response);},
  prepare(o){return manager.prepareNativeInertRelease(o.manager,o.root,o.flush);},
  check(ticket){manager.checkNativeInertRelease(ticket);},finalize(ticket){manager.finalizeNativeInertRelease(ticket);},
  prepareSuccess(o){return manager.prepareNativeRegistrationRelease(o.manager,o.root,o.flush);},
  finalizeSuccess(ticket){manager.finalizeNativeRegistrationRelease(ticket);}};
}
export function makeTrackedObservation({modId='new',archiveId='archive',operation='1',job='2',request='3',recordChange,markerChange,change,archive={}}={}) {
 const baseRecord={id:modId,state:'installed',type:'',installationPath:modId,archiveId};
 const projection={id:archiveId,state:'finished',game:['game'],localPath:'own.zip',size:12,fileMD5:'a'.repeat(32),archiveSHA256:'b'.repeat(64),...archive};
 const marker={schema:'native-tracked-mod-registration/2',operationId:'op_'+operation.repeat(32),nativeJobId:'exec_'+job.repeat(32),requestSHA256:request.repeat(64),planId:'4'.repeat(64),payloadSHA256:'5'.repeat(64),recordSHA256:sha(JSON.stringify(baseRecord)),archiveId,archiveSHA256:projection.archiveSHA256,downloadProjectionSHA256:sha(JSON.stringify(projection)),...markerChange};
 const record={...baseRecord,attributes:{__nmtNativeRegistration:marker},...recordChange},recordJSON=JSON.stringify(record);
 return JSON.stringify({schema:'native-tracked-mod-registration-observed/2',operationId:marker.operationId,nativeJobId:marker.nativeJobId,requestSHA256:marker.requestSHA256,recordSHA256:marker.recordSHA256,recordJSON,fullRecordSHA256:sha(recordJSON),commitObserved:true,readbackVerified:true,trackedAssociationVerified:true,trackedInstallComplete:false,effectsAllowed:false,installationPermit:false,powerLossPersistenceVerified:false,...change});
}


// Actual source candidates with real pinned Redux/stateDiff and actual manager class methods.
// Constructor/native/API/reducer registry are explicit inherited public-fixture facades.
const INERT_NAMES={middleware:'native-renderer-inert-flush-release',root:'native-renderer-inert-target-release',manager:'native-manager-inert-release'};
function candidate(name,baseline){return applyRendererCancellationStage(baseline,INERT_NAMES[name]);}
