import test from 'node:test';
import assert from 'node:assert/strict';
import {createContinuationFixture} from './native-main-executor-continuation.test.mjs';
import {createRendererContinuationFixture} from './native-renderer-executor-continuation.test.mjs';
import {createNativeExecutorJournal} from './native-executor-journal.mjs';

const available=process.env.VORTEX_EXTENSION_ADMISSION_REPO&&process.env.VORTEX_EXTENSION_ADMISSION_DEPS;
const integration=(name,fn)=>test(name,{timeout:15000,skip:available?false:'Set reviewed source and dependency inputs'},fn);
const transportId='transport_'+'1'.repeat(32);

// Direct source-method composition. The new continuation is not wired through
// IPC here. SQL and physical relay remain explicit fixtures; no child is started.
async function composed(t,options={}){
  const renderer=await createRendererContinuationFixture({gameId:'cyberpunk2077',modId:'own',profileId:'p',
    archiveRows:{'own-download':{state:'finished',game:['cyberpunk2077'],localPath:'own.zip',size:32,fileMD5:'b'.repeat(32)}}});
  await renderer.ready();
  const labels=renderer.manager.getNativeInstallExclusion();
  const main=await createContinuationFixture(t,{...options,configureInputs:({request})=>{
    request.plan.context.profileId='p';request.managerScope='manager-fixture-1';request.rendererGeneration=labels.rendererGeneration;
  }});
  const pending=renderer.ext.prepareNativeExecutor(main.requestBytes,main.archiveBytes);void pending.catch(()=>{});
  const ticket=main.preflight(),binding=main.wiring.getNativeExecutorTransportBinding(ticket);
  const challenge=round=>({schema:'native-executor-challenge/1',transportId,
    challengeId:'challenge_'+String(round).repeat(32),round,stage:round===1?'acquire':'check',...binding});
  assert.equal((await renderer.receive(challenge(1))).state,'acquired');
  await main.wiring.reserveNativeExecutorTransport(ticket);
  assert.equal((await renderer.receive(challenge(2))).state,'checked');
  const prepared=await main.wiring.prepareNativeExecutorTransportPending(ticket,main.frameOwner);
  assert.equal((await renderer.receive(challenge(3))).state,'checked');
  renderer.gate.resolve({schema:'native-executor-transport-preparation/1',transportId,
    operationId:binding.operationId,nativeJobId:binding.nativeJobId,requestSHA256:binding.requestSHA256,
    requestBytesSHA256:binding.requestBytesSHA256,archiveBytesSHA256:binding.archiveBytesSHA256,
    rootId:prepared.rootId,inventorySHA256:prepared.inventorySHA256,effectsAllowed:false,
    installationPermit:false,nativeAdmission:false,powerLossPersistenceVerified:false});
  await pending;
  const check=()=>renderer.ext.checkNativeExecutorTransportPreparation(transportId);
  return{main,renderer,ticket,binding,check,
    async copy(){check();return main.copy(ticket);},
    async register(){check();return main.register(ticket);},
    adopt(observed){return renderer.ext.prepareNativeExecutorTransportAdoption(transportId,Buffer.from(JSON.stringify(observed)));}};
}

integration('actual prepared source owners copy, register and adopt the same result while all completion barriers remain held',async t=>{
  const f=await composed(t);f.renderer.store.dispatch({type:'SETTING',payload:{key:'retainedBeforeCopy',value:7}});
  const copied=await f.copy();assert.equal(copied.operationId,f.binding.operationId);
  const observed=await f.register(),adopted=f.adopt(observed),state=f.renderer.store.getState();
  assert.equal(adopted.fullRecordSHA256,observed.fullRecordSHA256);assert.equal(adopted.requestSHA256,f.binding.requestSHA256);
  assert.equal(JSON.stringify(state.persistent.mods.cyberpunk2077.own),observed.recordJSON);
  assert.deepEqual(state.persistent.downloads.files['own-download'].installed,{gameId:'cyberpunk2077',modId:'own'});
  assert.deepEqual(state.persistent.profiles.p.modState??{},{});assert.equal(state.settings.retainedBeforeCopy,7);
  f.renderer.store.dispatch({type:'SETTING',payload:{key:'retainedAfterAdoption',value:8}});
  assert.strictEqual(f.renderer.ext.checkNativeExecutorTransportAdoption(transportId),adopted);
  f.renderer.fire();assert.equal(f.renderer.sent.length,0);
  assert.equal(f.renderer.manager.getNativeInstallExclusion().exclusiveHeld,true);
  assert.equal(f.main.main.getNativeModPersistenceReservation().phase,'reserved');f.main.wiring.checkNativeExecutorTransport(f.ticket);
  assert.deepEqual(f.main.relayCalls,['start','wait:extracted','handoff','proof','proof']);
  const anchor=JSON.parse(f.main.committed.get('nativeExecutorAnchorV1'));
  const inventory=createNativeExecutorJournal({root:f.main.root}).inventory({expectedRootId:anchor.rootId,expectedInventorySHA256:anchor.inventorySHA256});
  assert.equal(inventory.historySealVerified,true);assert.equal(inventory.unresolvedCount,1);assert.equal(inventory.startupHoldRequired,true);
});

integration('profile ABA after copy is refused by the real retained renderer before Main registration',async t=>{
  const f=await composed(t);await f.copy();
  f.renderer.store.dispatch({type:'SETTING',payload:{key:'profiles',value:{activeProfileId:'q'}}});
  f.renderer.store.dispatch({type:'SETTING',payload:{key:'profiles',value:{activeProfileId:'p'}}});
  await assert.rejects(f.register());f.main.wiring.holdNativeExecutorTransport(f.ticket);
  assert.equal(f.main.committed.has('persistent###mods###cyberpunk2077###own###id'),false);
  assert.equal(f.main.main.getNativeModPersistenceReservation().phase,'held');
  assert.equal(f.renderer.manager.getNativeInstallExclusion().exclusiveHeld,true);
  assert.equal(f.main.relayCalls.filter(c=>c==='start').length,1);
});

integration('an unknown actual Main commit cannot produce renderer adoption or replay',async t=>{
  let commits=0;const primary=Error('owned lost COMMIT reply');
  const f=await composed(t,{afterRun:sql=>{if(sql==='COMMIT'&&++commits===3)throw primary;}});await f.copy();
  await assert.rejects(f.register(),error=>error===primary);
  assert.equal(f.main.committed.has('persistent###mods###cyberpunk2077###own###id'),true);
  assert.equal(f.renderer.store.getState().persistent.mods.cyberpunk2077?.own,undefined);
  assert.equal(f.main.main.getNativeModPersistenceReservation().phase,'held');
  await assert.rejects(f.register());assert.equal(f.main.relayCalls.filter(c=>c==='start').length,1);
});

integration('failed actual renderer adoption preserves the Main commit and cannot release either side',async t=>{
  const f=await composed(t);await f.copy();const observed=await f.register(),count=f.main.committed.size;
  f.renderer.store.getState().persistent.downloads.files['own-download'].localPath='other.zip';
  assert.throws(()=>f.adopt(observed));f.main.wiring.holdNativeExecutorTransport(f.ticket);
  assert.equal(f.main.committed.size,count);assert.equal(f.main.committed.has('persistent###mods###cyberpunk2077###own###id'),true);
  assert.equal(f.main.calls.some(c=>c.sql==='ROLLBACK'),false);
  assert.equal(f.main.main.getNativeModPersistenceReservation().phase,'held');
  assert.equal(f.renderer.manager.getNativeInstallExclusion().exclusiveHeld,true);
  assert.throws(()=>f.renderer.ext.checkNativeExecutorTransportAdoption(transportId));
  assert.equal(f.main.relayCalls.filter(c=>c==='start').length,1);
});

integration('worker closure during the registration commit cannot return an adoptable result',async t=>{
  let commits=0,f;
  f=await composed(t,{afterRun:sql=>{
    if(sql==='COMMIT'&&++commits===3)f.main.context().sdk.workerTerminal.closeObserved=true;
  }});
  await f.copy();await assert.rejects(f.register());
  assert.equal(f.main.committed.has('persistent###mods###cyberpunk2077###own###id'),true);
  assert.equal(f.renderer.store.getState().persistent.mods.cyberpunk2077?.own,undefined);
  assert.equal(f.main.main.getNativeModPersistenceReservation().phase,'held');
  assert.equal(f.main.calls.some(c=>c.sql==='ROLLBACK'),false);
  await assert.rejects(f.register());assert.equal(f.main.relayCalls.filter(c=>c==='start').length,1);
});
