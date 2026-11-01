import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createMainCompletionFixture} from './native-main-executor-completion.test.mjs';
import {createRendererCompletionFixture} from './native-renderer-executor-completion.test.mjs';
import {createCompletionPreloadFixture} from './native-executor-completion-preload.test.mjs';
import {completionIPCFixture} from './native-executor-completion-ipc.test.mjs';
import {deferred,tick} from './native-query-source-admission.test.mjs';

const ready=process.env.VORTEX_EXTENSION_ADMISSION_REPO&&process.env.VORTEX_EXTENSION_ADMISSION_DEPS;
const integration=(name,fn)=>test(name,{timeout:20000,skip:ready?false:'Set reviewed source/dependency inputs'},fn);

// All four patched actors execute the actual fixed preparation/execution route.
// Electron delivery, transactional SQL and physical process facts are facades.
// This test does not start Vortex, a game, a worker or a native database.
async function composed(t,options={}){
  let ipc,all;
  const preload=createCompletionPreloadFixture({
    invoke(channel,...args){
      if(channel==='persist:native-executor-prepare')return ipc.prepare(...args);
      assert.equal(channel,'persist:native-executor-execute');return ipc.execute(...args);
    },send(channel,value){const listener=ipc.listeners.get(channel);assert.equal(typeof listener,'function');listener(ipc.event,value);}});
  const renderer=await createRendererCompletionFixture({gameId:'cyberpunk2077',modId:'own',profileId:'p',
    archiveRows:{'own-download':{state:'finished',game:['cyberpunk2077'],localPath:'own.zip',size:32,fileMD5:'b'.repeat(32)}},
    prepareInvoke:(r,a)=>preload.persist.prepareNativeExecutor(r,a),executeInvoke:id=>preload.persist.executeNativeExecutor(id),
    prepareRegister:fn=>preload.persist.onExecutorChallenge(fn),register:fn=>preload.persist.onExecutorExecutionChallenge(fn),
    invalidate:value=>preload.persist.invalidateNativeExecutorExecution(value)});
  await renderer.ready();const labels=renderer.manager.getNativeInstallExclusion();
  const main=await createMainCompletionFixture(t,{...options.main,
    frameAPI:{checkNativeExecutorFrame:owner=>ipc.api.checkNativeExecutorFrame(owner),holdNativeExecutorFrame:owner=>ipc.api.holdNativeExecutorFrame(owner)},
    configureInputs:({request})=>{request.plan.context.profileId='p';request.managerScope='manager-fixture-1';request.rendererGeneration=labels.rendererGeneration;}});
  const exports=Object.fromEntries(['copyNativeExecutorTransport','registerNativeExecutorTransportCopied','closeNativeExecutorTransportWorker',
    'sealNativeExecutorTransportTerminal','releaseNativeExecutorTransport','getNativeExecutorTransportMainRelease'].map(k=>[k,main.wiring[k]]));
  ipc=completionIPCFixture({persistor:main.main,readyOwner:main.mainOwner,context:{...main.mainReadyContext,...main.mainAPI,...exports},auto:false,
    onPrepareChallenge:c=>preload.listeners.get('persist:native-executor-challenge')({},c),
    onChallenge:c=>{options.challenge?.(c,all);preload.listeners.get('persist:native-executor-execution-challenge')({},c);}});
  const prepared=await renderer.ext.prepareNativeExecutor(main.requestBytes,main.archiveBytes);
  all={main,renderer,preload,ipc,prepared,execute:()=>renderer.ext.executeNativeExecutor()};return all;
}

integration('actual renderer/preload/IPC/Main completes all seven stages and releases only the matching committed operation',async t=>{
  const f=await composed(t);assert.equal(f.main.relayCalls.length,0);assert.equal(f.main.census().unresolvedCount,1);
  f.renderer.store.dispatch({type:'SETTING',payload:{key:'ordinaryBuffered',value:7}});
  const result=await f.execute();assert.equal(result.schema,'native-executor-execution-result/1');assert.equal(Object.keys(result).length,17);
  assert.equal(result.transportId,f.prepared.transportId);assert.equal(result.operationId,f.main.request.operationId);
  assert.equal(result.mainReleased,true);assert.equal(result.rendererReleased,true);assert.equal(result.installationPermit,false);assert.equal(result.trackedInstallComplete,false);
  assert.deepEqual(f.ipc.executionChallenges().map(c=>c.sequence),[1,2,3,4,5,6,7]);
  assert.deepEqual(f.main.relayCalls,['start','wait:extracted','handoff','proof','proof','release']);
  const census=f.main.census();assert.equal(census.closedCount,1);assert.equal(census.historySealVerified,true);assert.equal(census.startupHoldRequired,false);
  assert.equal(f.main.main.getNativeModPersistenceReservation().phase,'not_reserved');assert.equal(f.main.pool.getNativeSQLConnectionStatus().phase,'not_reserved');
  assert.equal(f.renderer.manager.getNativeInstallExclusion().exclusiveHeld,false);assert.equal(f.renderer.rootApi.getNativeRendererTargetStatus().phase,'not_reserved');
  const state=f.renderer.store.getState();assert.equal(state.persistent.mods.cyberpunk2077.own.archiveId,'own-download');assert.deepEqual(state.persistent.profiles.p.modState??{},{});
  assert.deepEqual(state.persistent.downloads.files['own-download'].installed,{gameId:'cyberpunk2077',modId:'own'});
  assert.equal(f.main.calls.filter(c=>c.sql==='COMMIT').length,4);
  f.renderer.fire();assert(f.renderer.sent.length>0);
  for(const batch of f.renderer.sent){assert.equal(batch.hive,'settings');await f.main.main.applyDiffOperationsAcknowledged(batch.hive,batch.operations);}
  assert.equal(f.main.committed.get('settings###ordinaryBuffered'),'7');assert.equal(f.main.calls.filter(c=>c.sql==='COMMIT').length,4+f.renderer.sent.length);
  assert.equal(JSON.stringify(state).includes('execution_'),false);await assert.rejects(f.execute());
});

integration('actual profile ABA during COPY delivers a negative notification and prevents registration despite late worker fulfillment',async t=>{
  const entered=deferred(),gate=deferred(),f=await composed(t,{main:{start:()=>{entered.resolve();return gate.promise;}}});
  const pending=f.execute();void pending.catch(()=>{});await entered.promise;
  f.renderer.store.dispatch({type:'SETTING',payload:{key:'profiles',value:{activeProfileId:'q'}}});
  f.renderer.store.dispatch({type:'SETTING',payload:{key:'profiles',value:{activeProfileId:'p'}}});
  await assert.rejects(pending);gate.resolve();await tick();await tick();
  assert.equal(f.renderer.invalidations.length,1);assert.equal(f.main.committed.has('persistent###mods###cyberpunk2077###own###id'),false);
  assert.equal(f.main.main.getNativeModPersistenceReservation().phase,'held');assert.equal(f.renderer.manager.getNativeInstallExclusion().exclusiveHeld,true);
  assert.equal(fs.existsSync(path.join(f.main.root,'terminals')),false);assert.equal(f.main.relayCalls.filter(c=>c==='start').length,1);
  assert.equal(f.main.relayCalls.includes('handoff'),false);await assert.rejects(f.execute());
});

integration('an actual lost terminal anchor COMMIT reply never delivers a renderer finalization challenge',async t=>{
  let commits=0;const primary=Error('owned lost terminal anchor acknowledgement');
  const f=await composed(t,{main:{afterRun:sql=>{if(sql==='COMMIT'&&++commits===4)throw primary;}}});
  await assert.rejects(f.execute(),error=>error===primary);assert.equal(commits,4);
  assert.equal(f.main.census().closedCount,1);assert.equal(f.main.main.getNativeModPersistenceReservation().phase,'held');
  assert.equal(f.renderer.manager.getNativeInstallExclusion().exclusiveHeld,true);assert.equal(f.renderer.rootApi.getNativeRendererTargetStatus().phase,'committed_protected');
  assert.equal(f.ipc.executionChallenges().some(c=>c.sequence===7),false);assert.equal(f.main.relayCalls.filter(c=>c==='release').length,1);
  assert.equal(f.main.calls.some(c=>c.sql==='ROLLBACK'),false);await assert.rejects(f.execute());assert.equal(commits,4);
});

integration('renderer refusal after actual Main release preserves the truthful split without re-lock or release replay',async t=>{
  let substituted=0;
  const f=await composed(t,{challenge:(c,state)=>{if(c.sequence===7)state.renderer.Manager.prototype.finalizeNativeRegistrationRelease=()=>{substituted++;};}});
  await assert.rejects(f.execute());assert.equal(substituted,0);assert.equal(f.main.census().closedCount,1);
  assert.equal(f.main.main.getNativeModPersistenceReservation().phase,'not_reserved');assert.equal(f.main.level.getNativeBackendWriteStatus().phase,'not_reserved');
  assert.equal(f.main.pool.getNativeSQLConnectionStatus().phase,'not_reserved');assert.equal(f.renderer.manager.getNativeInstallExclusion().exclusiveHeld,true);
  assert.equal(f.renderer.rootApi.getNativeRendererTargetStatus().phase,'committed_protected');assert.equal(f.main.relayCalls.filter(c=>c==='release').length,1);
  await assert.rejects(f.execute());assert.equal(f.main.relayCalls.filter(c=>c==='start').length,1);
});

integration('a sibling-frame execute cannot consume or poison the actual prepared operation',async t=>{
  const f=await composed(t),foreign={sender:{id:f.ipc.owner.id},senderFrame:{...f.ipc.owner.mainFrame}};
  await assert.rejects(f.ipc.execute(f.prepared.transportId,foreign));assert.equal(f.main.relayCalls.length,0);
  assert.equal((await f.execute()).rendererReleased,true);assert.equal(f.main.relayCalls.filter(c=>c==='start').length,1);
});
