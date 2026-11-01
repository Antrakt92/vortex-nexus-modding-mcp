import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createMainTransportFixture} from './native-main-executor-transport.test.mjs';
import {createRendererTransportFixture,deferred} from './native-renderer-executor-transport.test.mjs';
import {createPreloadTransportFixture} from './native-executor-transport-preload.test.mjs';
import {transportFixture} from './native-executor-transport-ipc.test.mjs';
import {createNativeExecutorJournal} from './native-executor-journal.mjs';

const repo=process.env.VORTEX_EXTENSION_ADMISSION_REPO,deps=process.env.VORTEX_EXTENSION_ADMISSION_DEPS;
const integration=(name,fn)=>test(name,{skip:repo&&deps?false:'Set VORTEX_EXTENSION_ADMISSION_REPO and VORTEX_EXTENSION_ADMISSION_DEPS',timeout:15000},fn);
const tick=()=>new Promise(resolve=>setImmediate(resolve));

// All four patched actors execute. Electron, SQL/host initialization and relay
// preparation are explicit facades; no native child, Vortex or game is started.
async function composed(t,options={}){
  let ipc;
  const preload=createPreloadTransportFixture({invoke:(_channel,r,a)=>ipc.invoke(r,a),
    send:(_channel,response)=>ipc.listeners.get('persist:native-executor-response')(options.responseEvent?.(ipc,response)??ipc.event,response)});
  const renderer=await createRendererTransportFixture({gameId:'cyberpunk2077',modId:'new',profileId:options.profileId??'p',ack:options.ack,
    register:handler=>preload.persist.onExecutorChallenge(handler),invoke:(r,a)=>preload.persist.prepareNativeExecutor(r,a)});
  await renderer.ready();
  const labels=renderer.manager.getNativeInstallExclusion();
  const main=await createMainTransportFixture(t,{frameAPI:{
    checkNativeExecutorFrame:owner=>ipc.api.checkNativeExecutorFrame(owner),holdNativeExecutorFrame:owner=>ipc.api.holdNativeExecutorFrame(owner)},
    configureInputs:({request,archive})=>{
      request.plan.context.profileId=options.profileId??'p';request.plan.package.fileName='new.zip';request.plan.package.expectedModId='new';
      request.managerScope='manager-fixture-1';request.rendererGeneration=labels.rendererGeneration;archive.leaf='new.zip';
    },beforePrepare:options.beforePrepare});
  ipc=transportFixture({persistor:main.main,readyOwner:main.mainOwner,context:main.mainReadyContext,mainAPI:main.mainAPI,
    onChallenge:challenge=>preload.deliver(challenge)});
  return{main,renderer,preload,ipc,prepare:()=>renderer.ext.prepareNativeExecutor(main.requestBytes,main.archiveBytes)};
}

integration('actual renderer/preload/IPC/Main actors wait for old ACK before reserve and acknowledge only pending preparation',async t=>{
  const ack=deferred(),f=await composed(t,{ack:()=>ack.promise}),pending=f.prepare();pending.catch(()=>{});
  await tick();await tick();
  assert.equal(f.renderer.acks.length,1);assert.equal(f.main.main.getNativeModPersistenceReservation().phase,'not_reserved');
  assert.equal(fs.existsSync(f.main.root),false);assert.equal(f.main.committed.has('nativeExecutorAnchorV1'),false);
  assert.deepEqual(f.main.counts(),{relayCreated:0,prepareCalls:0,startCalls:0});
  ack.resolve();const result=await pending;
  assert.equal(result.schema,'native-executor-transport-preparation/1');assert.equal(Object.keys(result).length,13);
  assert.equal(result.operationId,f.main.request.operationId);assert.equal(result.nativeJobId,f.main.request.nativeJobId);
  for(const key of ['effectsAllowed','installationPermit','nativeAdmission','powerLossPersistenceVerified'])assert.equal(result[key],false);
  assert.equal(Object.hasOwn(result,'owner'),false);assert.equal(Object.hasOwn(result,'relay'),false);
  assert.deepEqual(f.ipc.messages.map(c=>c.round),[1,2,3]);assert.deepEqual(f.main.counts(),{relayCreated:1,prepareCalls:1,startCalls:0});
  const anchor=JSON.parse(f.main.committed.get('nativeExecutorAnchorV1'));
  const census=createNativeExecutorJournal({root:f.main.root}).inventory({expectedRootId:anchor.rootId,expectedInventorySHA256:anchor.inventorySHA256});
  assert.equal(census.historySealVerified,true);assert.equal(census.unresolvedCount,1);assert.equal(census.startupHoldRequired,true);
  assert.equal(f.renderer.manager.getNativeInstallExclusion().exclusiveHeld,true);
  assert.equal(f.main.main.getNativeModPersistenceReservation().phase,'reserved');
});

integration('actual profile invalidation during old ACK fails all actors without creating history or a worker',async t=>{
  const ack=deferred(),f=await composed(t,{ack:()=>ack.promise}),pending=f.prepare();pending.catch(()=>{});await tick();await tick();
  f.renderer.store.dispatch({type:'SETTING',payload:{key:'profiles',value:{activeProfileId:'q'}}});
  f.renderer.store.dispatch({type:'SETTING',payload:{key:'profiles',value:{activeProfileId:'p'}}});
  await assert.rejects(pending);ack.resolve();await tick();
  assert.equal(fs.existsSync(f.main.root),false);assert.equal(f.main.committed.has('nativeExecutorAnchorV1'),false);
  assert.deepEqual(f.main.counts(),{relayCreated:0,prepareCalls:0,startCalls:0});
  assert.equal(f.renderer.manager.getNativeInstallExclusion().exclusiveHeld,true);
  await assert.rejects(f.prepare());assert.equal(f.preload.invoked.length,1);
});

integration('an actual preload response from a sibling frame cannot reserve Main or provision history',async t=>{
  const replied=deferred();
  const f=await composed(t,{responseEvent:(ipc,response)=>{replied.resolve(response);return{sender:ipc.owner,senderFrame:{...ipc.owner.mainFrame}};}}),pending=f.prepare();pending.catch(()=>{});
  // Wait for actual acquisition; scheduler turns alone do not establish this stage.
  const response=await replied.promise;
  assert.equal(response.round,1);assert.equal(response.state,'acquired');
  assert.equal(f.renderer.manager.getNativeInstallExclusion().exclusiveHeld,true);
  assert.equal(f.main.main.getNativeModPersistenceReservation().phase,'not_reserved');
  assert.equal(fs.existsSync(f.main.root),false);
  f.ipc.timeout();await assert.rejects(pending);await tick();
  assert.equal(fs.existsSync(f.main.root),false);assert.deepEqual(f.main.counts(),{relayCreated:0,prepareCalls:0,startCalls:0});
  assert.equal(f.renderer.manager.getNativeInstallExclusion().exclusiveHeld,true);
});

integration('a foreign duplicate invoke cannot stop the genuine four-actor preparation',async t=>{
  const ack=deferred(),f=await composed(t,{ack:()=>ack.promise}),pending=f.prepare();pending.catch(()=>{});await tick();await tick();
  const foreign={sender:{id:f.ipc.owner.id},senderFrame:{...f.ipc.owner.mainFrame}};
  await assert.rejects(f.ipc.handlers.get('persist:native-executor-prepare')(foreign,f.main.requestBytes,f.main.archiveBytes));
  assert.equal(f.ipc.messages.some(c=>c.stage==='hold'),false);
  assert.equal(fs.existsSync(f.main.root),false);ack.resolve();
  assert.equal((await pending).schema,'native-executor-transport-preparation/1');
  assert.deepEqual(f.main.counts(),{relayCreated:1,prepareCalls:1,startCalls:0});
});

integration('frame loss during preparation keeps late journal effects unacknowledged and never starts or retries',async t=>{
  const gate=deferred(),f=await composed(t,{beforePrepare:()=>gate.promise}),pending=f.prepare();pending.catch(()=>{});
  for(let i=0;i<20&&f.main.counts().prepareCalls===0;i++)await tick();
  assert.equal(f.main.counts().prepareCalls,1);assert.equal(fs.existsSync(f.main.root),true);
  f.ipc.owner.emit('did-start-navigation',{isMainFrame:true});await assert.rejects(pending);
  const old=JSON.parse(f.main.committed.get('nativeExecutorAnchorV1'));
  gate.resolve();await tick();await tick();
  const census=createNativeExecutorJournal({root:f.main.root}).inventory({expectedRootId:old.rootId,expectedInventorySHA256:old.inventorySHA256});
  assert.equal(census.startupHoldRequired,true);assert.equal(census.historySealVerified,false);
  assert.equal(census.unresolvedCount,1);assert.equal(f.main.counts().startCalls,0);
  await assert.rejects(f.prepare());assert.equal(f.main.counts().prepareCalls,1);
});

integration('supported underscore and hyphen profile identifiers cross the actual four-actor preparation',async t=>{
  for(const profileId of ['_p','-p']){
    const f=await composed(t,{profileId}),result=await f.prepare();
    assert.equal(result.schema,'native-executor-transport-preparation/1');assert.equal(f.main.request.plan.context.profileId,profileId);
    assert.deepEqual(f.ipc.messages.map(c=>c.profileId),[profileId,profileId,profileId]);assert.equal(f.main.counts().startCalls,0);
  }
});
