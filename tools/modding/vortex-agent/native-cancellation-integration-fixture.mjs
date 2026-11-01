// Actual Main/Renderer/Preload/IPC candidate composition. SQL/Electron and
// physical relay/observer facts are explicit inherited lower fixture facades.
// Import starts no actors, app, worker or process. Root owns serial invocation.
import assert from 'node:assert/strict';
import {createMainCancellationFixture} from './native-cancellation-main-fixture.mjs';
import {createCancellationIPCFixture} from './native-cancellation-ipc-fixture.mjs';
import {createCancellationPreloadFixture} from './native-cancellation-preload-fixture.mjs';
import {secondArchiveRows} from './native-successor-fixture-inputs.mjs';
export const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
export const tick=()=>new Promise(resolve=>setImmediate(resolve));
import {createCoordinatorAdmissionFixture} from './native-cancellation-renderer-admission-fixture.mjs';
export async function createCancellationComposition(t,options={}){
 let ipc,all;
 const registrations={},invokeFailures=[];
 const preload=createCancellationPreloadFixture({
  invoke:(channel,...args)=>Promise.resolve().then(async()=>{
   let result;
   try{result=await ipc.handlers.get(channel)(ipc.event,...args);}
   catch(primary){
    // Passive actual-handler observation only; simulated lost ACKs below are
    // transport faults and must not be classified as Main/IPC failures.
    invokeFailures.push({channel,primary});
    try{options.invokeFailure?.(channel,primary,all);}catch{}
    throw primary;
   }
   return options.invoke?options.invoke(channel,args,result,all):result;
  }),
  send:(channel,value)=>ipc.listeners.get(channel)(ipc.event,value),
  on:channel=>{registrations[channel]=(registrations[channel]??0)+1;}
 });
 const renderer=createCoordinatorAdmissionFixture({gameId:'cyberpunk2077',
  archiveRows:{'own-download':{state:'finished',game:['cyberpunk2077'],localPath:'own.zip',size:32,fileMD5:'b'.repeat(32)},...secondArchiveRows()},
  transportWindow:{api:{persist:preload.persist}},
  ack:async batches=>{await preload.persist.sendDiffAcknowledged(batches);await options.ack?.(batches,all);},
  ...options.renderer
 });
 options.rendererSetup?.(renderer);
 await renderer.ready();const labels=renderer.manager.getNativeInstallExclusion();
 const main=await createMainCancellationFixture(t,{...options.main,
  frameAPI:{checkNativeExecutorFrame:owner=>ipc.api.checkNativeExecutorFrame(owner),holdNativeExecutorFrame:owner=>ipc.api.holdNativeExecutorFrame(owner)},
  configureInputs:args=>{
   const r=args.request;r.plan.context.profileId='p';r.managerScope='manager-fixture-1';r.rendererGeneration=labels.rendererGeneration;
   options.main?.configureInputs?.(args);
  }
 });
 const names=['copyNativeExecutorTransport','registerNativeExecutorTransportCopied','closeNativeExecutorTransportWorker',
  'sealNativeExecutorTransportTerminal','releaseNativeExecutorTransport','getNativeExecutorTransportMainRelease','prepareNativeExecutorSuccessor',
  'cancelNativeExecutorTransportPrepared','sealNativeExecutorTransportCancellation','releaseNativeExecutorTransportCancellation',
  'getNativeExecutorTransportCancellationRelease','prepareNativeExecutorCancellationSuccessor'];
 const actual=Object.fromEntries(names.map(name=>{assert.equal(typeof main.wiring[name],'function',name);return[name,main.wiring[name]];}));
 ipc=createCancellationIPCFixture({persistor:main.main,readyOwner:main.mainOwner,
  context:{...main.mainReadyContext,...main.mainAPI,...actual},autoPrepare:false,autoExecution:false,autoCancel:false,
  prepareChallenge:c=>preload.listeners.get('persist:native-executor-challenge')({},c),
  executionChallenge:c=>preload.listeners.get('persist:native-executor-execution-challenge')({},c),
  cancelChallenge:c=>{options.challenge?.(c,all);preload.listeners.get('persist:native-executor-cancellation-challenge')({},c);}
 });
 preload.invoked.length=0;
 all={main,renderer,preload,ipc,invokeFailures,
  prepare:(request=main.requestBytes,archive=main.archiveBytes)=>renderer.ext.prepareNativeExecutor(request,archive),
  cancel:()=>renderer.ext.cancelNativeExecutorPrepared(),handoff:()=>renderer.ext.handoffNativeExecutorCancellationSuccessor(),
  prepareNext:()=>{const next=main.nextInputs();return renderer.ext.prepareNativeExecutor(next.requestBytes,next.archiveBytes);},
  registrations:()=>({...registrations}),
  assertNoInstall(){
   assert.equal(main.relayCalls.filter(x=>x==='start').length,0);
   assert(![...main.committed.keys()].some(k=>k.startsWith('persistent###mods###')||k.includes('###installed')));
   const state=renderer.store.getState();for(const rows of Object.values(state.persistent.mods??{}))assert.equal(Object.keys(rows).length,0);
   for(const row of Object.values(state.persistent.downloads.files))assert.equal(row.installed,undefined);
   for(const profile of Object.values(state.persistent.profiles))assert.deepEqual(profile.modState??{},{});
  },
 };
 all.prepared=await all.prepare();return all;
}
