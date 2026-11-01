// Actual Main/Renderer/Preload/IPC and captured SDK; transactional SQL, Electron
// delivery and process facts are explicit facades. Never starts an installed app.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createTwoOperationMainFixture} from './native-successor-main-fixture.mjs';
import {createRendererSuccessorFixture} from './native-renderer-successor-fixture.mjs';
import {secondArchiveRows} from './native-successor-fixture-inputs.mjs';
import {createSuccessorPreloadFixture} from './native-executor-successor-preload.test.mjs';
import {successorIPCFixture} from './native-executor-successor-ipc.test.mjs';
import {deferred} from './native-query-source-admission.test.mjs';

const ready=process.env.VORTEX_EXTENSION_ADMISSION_REPO&&process.env.VORTEX_EXTENSION_ADMISSION_DEPS&&process.env.VORTEX_CAPSULE_BUILD_SOURCE;
const integration=(name,body)=>test(name,{timeout:30000,skip:ready?false:'Set reviewed source/dependency and capsule compiler inputs'},body);

export async function createSuccessorComposition(t,options={}){
  let ipc,all;
  const preload=createSuccessorPreloadFixture({invoke:(channel,...args)=>Promise.resolve().then(async()=>{
    const result=await ipc.handlers.get(channel)(ipc.event,...args);
    return options.invoke?options.invoke(channel,args,result,all):result;
  }),send:(channel,value)=>ipc.listeners.get(channel)(ipc.event,value)});
  const renderer=await createRendererSuccessorFixture({gameId:'cyberpunk2077',modId:'own',profileId:'p',
    archiveRows:{'own-download':{state:'finished',game:['cyberpunk2077'],localPath:'own.zip',size:32,fileMD5:'b'.repeat(32)},...secondArchiveRows()},
    prepareInvoke:(r,a)=>preload.persist.prepareNativeExecutor(r,a),executeInvoke:id=>preload.persist.executeNativeExecutor(id),
    handoffInvoke:(transportId,executionId)=>preload.persist.handoffNativeExecutorSuccessor(transportId,executionId),
    prepareRegister:fn=>preload.persist.onExecutorChallenge(fn),register:fn=>preload.persist.onExecutorExecutionChallenge(fn),
    invalidate:value=>preload.persist.invalidateNativeExecutorExecution(value)});
  await renderer.ready();const labels=renderer.manager.getNativeInstallExclusion();
  const main=await createTwoOperationMainFixture(t,{...options.main,
    frameAPI:{checkNativeExecutorFrame:owner=>ipc.api.checkNativeExecutorFrame(owner),holdNativeExecutorFrame:owner=>ipc.api.holdNativeExecutorFrame(owner)},
    configureInputs:args=>{const request=args.request;request.plan.context.profileId='p';request.managerScope='manager-fixture-1';
      request.rendererGeneration=labels.rendererGeneration;options.main?.configureInputs?.(args);}});
  const names=['copyNativeExecutorTransport','registerNativeExecutorTransportCopied','closeNativeExecutorTransportWorker',
    'sealNativeExecutorTransportTerminal','releaseNativeExecutorTransport','getNativeExecutorTransportMainRelease','prepareNativeExecutorSuccessor'];
  const exports=Object.fromEntries(names.map(name=>[name,main.wiring[name]]));
  ipc=successorIPCFixture({persistor:main.main,readyOwner:main.mainOwner,context:{...main.mainReadyContext,...main.mainAPI,...exports},auto:false,
    onPrepareChallenge:c=>preload.listeners.get('persist:native-executor-challenge')({},c),
    onChallenge:c=>{options.challenge?.(c,all);preload.listeners.get('persist:native-executor-execution-challenge')({},c);}});
  all={main,renderer,preload,ipc,execute:()=>renderer.ext.executeNativeExecutor(),handoff:()=>renderer.ext.handoffNativeExecutorSuccessor(),
    prepareNext:()=>{const next=main.nextInputs();return renderer.ext.prepareNativeExecutor(next.requestBytes,next.archiveBytes);}};
  all.prepared=await renderer.ext.prepareNativeExecutor(main.requestBytes,main.archiveBytes);
  return all;
}

integration('one actual composed lifetime retains two distinct mods and archives through one capsule',async t=>{
  const f=await createSuccessorComposition(t),{main,renderer}=f;
  const first=f.prepared,completed=await f.execute(),anchor1=main.committed.get('nativeExecutorAnchorV1');
  const ack=await f.handoff();assert.equal(ack.transportId,first.transportId);
  renderer.store.dispatch({type:'SETTING',payload:{key:'betweenOperations',value:7}});renderer.fire();
  for(const batch of renderer.sent){assert.equal(batch.hive,'settings');await main.main.applyDiffOperationsAcknowledged(batch.hive,batch.operations);}
  assert.equal(main.committed.get('settings###betweenOperations'),'7');
  const second=await f.prepareNext();assert.notEqual(second.transportId,first.transportId);assert.notEqual(second.operationId,first.operationId);
  assert.equal(main.census().closedCount,1);assert.equal(main.census().unresolvedCount,1);
  assert.notEqual(main.committed.get('nativeExecutorAnchorV1'),anchor1);
  const result=await f.execute();assert.equal(result.mainReleased,true);assert.equal(result.rendererReleased,true);
  assert.notEqual(result.executionId,completed.executionId);
  assert.equal(main.census().closedCount,2);assert.equal(main.census().unresolvedCount,0);
  assert.notEqual(main.committed.get('nativeExecutorAnchorV1'),anchor1);
  const state=renderer.store.getState();assert.equal(state.persistent.mods.cyberpunk2077.own.archiveId,'own-download');
  assert.equal(state.persistent.mods.cyberpunk2077['second-own'].archiveId,'second-download');assert.deepEqual(state.persistent.profiles.p.modState??{},{});
  assert.equal(state.persistent.downloads.files['own-download'].installed.modId,'own');
  assert.equal(state.persistent.downloads.files['second-download'].installed.modId,'second-own');
  for(const [modId,downloadId,archiveSHA]of [['own','own-download',main.request.plan.package.sha256],
    ['second-own','second-download',main.nextInputs().request.plan.package.sha256]]){
    const mod='persistent###mods###cyberpunk2077###'+modId,download='persistent###downloads###files###'+downloadId;
    assert.equal(JSON.parse(main.committed.get(mod+'###id')),modId);assert.equal(JSON.parse(main.committed.get(mod+'###archiveId')),downloadId);
    assert.equal(JSON.parse(main.committed.get(mod+'###attributes###__nmtNativeRegistration')).archiveSHA256,archiveSHA);
    assert.equal(JSON.parse(main.committed.get(download+'###installed###gameId')),'cyberpunk2077');
    assert.equal(JSON.parse(main.committed.get(download+'###installed###modId')),modId);
    for(const profile of Object.values(state.persistent.profiles))assert.notEqual(profile.modState?.[modId]?.enabled,true);
  }
  assert.equal(main.relayCalls.filter(c=>c==='start').length,2);assert.equal(main.relayCalls.filter(c=>c==='release').length,2);
  assert.deepEqual(renderer.registrations(),{prepare:1,execution:1});main.assertSameLifetime();
});

integration('lost actual successor ACK reconciles history without replaying any installation stage',async t=>{
  let acknowledgements=0;
  const f=await createSuccessorComposition(t,{invoke:(channel,args,result)=>{
    if(channel==='persist:native-executor-successor'&&++acknowledgements===1)throw undefined;return result;
  }});
  const result=await f.execute(),anchor=f.main.committed.get('nativeExecutorAnchorV1');
  const stages=[...f.main.relayCalls];await assert.rejects(f.handoff(),error=>error===undefined);
  assert.equal(result.rendererReleased,true);assert.deepEqual(f.main.relayCalls,stages);
  const ack=await f.handoff();assert.equal(ack.transportId,result.transportId);assert.equal(acknowledgements,2);
  assert.deepEqual(f.main.relayCalls,stages);assert.equal(f.main.committed.get('nativeExecutorAnchorV1'),anchor);
  await f.prepareNext();await f.execute();assert.equal(f.main.census().closedCount,2);f.main.assertSameLifetime();
});

integration('late retired invocations and historical ACK cannot hold the next actual COPY',async t=>{
  const entered=deferred(),gate=deferred();let second=false;
  const f=await createSuccessorComposition(t,{main:{start:()=>{if(second){entered.resolve();return gate.promise;}}}});
  const result=await f.execute();await f.handoff();await f.prepareNext();second=true;
  const pending=f.execute();void pending.catch(()=>{});await entered.promise;
  try{
    await assert.rejects(f.preload.persist.executeNativeExecutor(result.transportId));
    await assert.rejects(f.preload.persist.prepareNativeExecutor(f.main.requestBytes,f.main.archiveBytes));
    const old=await f.preload.persist.handoffNativeExecutorSuccessor(result.transportId,result.executionId);
    assert.equal(old.transportId,result.transportId);assert.equal(f.main.main.getNativeModPersistenceReservation().phase,'reserved');
  }finally{gate.resolve();}
  assert.equal((await pending).rendererReleased,true);assert.equal(f.main.census().closedCount,2);f.main.assertSameLifetime();
});

integration('unknown terminal COMMIT keeps handoff unavailable and preserves the unresolved ownership gate',async t=>{
  let commits=0;const primary=Error('owned lost terminal COMMIT reply');
  const f=await createSuccessorComposition(t,{main:{afterRun:sql=>{if(sql==='COMMIT'&&++commits===4)throw primary;}}});
  await assert.rejects(f.execute(),error=>error===primary);await assert.rejects(f.handoff());
  assert.equal(f.main.census().closedCount,1);assert.equal(f.main.main.getNativeModPersistenceReservation().phase,'held');
  assert.equal(f.renderer.manager.getNativeInstallExclusion().exclusiveHeld,true);assert.equal(f.main.relayCalls.filter(c=>c==='start').length,1);
});

integration('Main released but Renderer refused remains a truthful split and cannot admit successor work',async t=>{
  const f=await createSuccessorComposition(t,{challenge:(c,current)=>{
    if(c.sequence===7)current.renderer.store.dispatch({type:'SETTING',payload:{key:'profiles',value:{activeProfileId:'q'}}});
  }});
  await assert.rejects(f.execute());await assert.rejects(f.handoff());
  assert.equal(f.main.main.getNativeModPersistenceReservation().phase,'not_reserved');assert.equal(f.main.census().closedCount,1);
  assert.equal(f.renderer.manager.getNativeInstallExclusion().exclusiveHeld,true);assert.equal(f.main.relayCalls.filter(c=>c==='start').length,1);
});
