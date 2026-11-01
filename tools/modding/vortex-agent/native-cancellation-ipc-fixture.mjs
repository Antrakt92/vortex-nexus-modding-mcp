import {applyRendererCancellationStage} from './native-cancellation-source-fixture.mjs';
// Actual complete candidate IPC source. Electron/Main work are explicit facades.
// Import starts no actor/process; Root alone calls this factory in serial tests.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {types} from 'node:util';
import {EventEmitter} from 'node:events';
import {execute} from './native-query-source-admission.test.mjs';
import {completionSource,executionResponse} from './native-executor-completion-preload.test.mjs';
import {transportBinding} from './native-executor-transport-ipc.test.mjs';
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
export const cancellationReply=(c,extra={})=>({schema:'native-executor-cancellation-response/1',transportId:c.transportId,cancellationId:c.cancellationId,
 challengeId:c.challengeId,sequence:c.sequence,stage:c.stage,requestSHA256:c.requestSHA256,requestBytesSHA256:c.requestBytesSHA256,archiveBytesSHA256:c.archiveBytesSHA256,
 state:c.sequence===1?'prepared':c.sequence===4?'finalized':'checked',observation:{schema:'native-executor-renderer-cancellation/1',transportId:c.transportId,cancellationId:c.cancellationId,
  operationId:c.operationId,nativeJobId:c.nativeJobId,requestSHA256:c.requestSHA256,state:c.sequence===1?'prepared':c.sequence===4?'finalized':'checked',targetAbsent:true,effectsAllowed:false,installationPermit:false,nativeAdmission:false},errorCode:null,...extra});
export function createCancellationIPCFixture(options={}){
 const baseline=completionSource('native-executor-successor-ipc');
 const candidate=applyRendererCancellationStage(baseline,'native-cancellation-ipc');
 const handlers=new Map(),listeners=new Map(),timers=new Map(),calls=[],messages=[],rows=[];
 const owner=new EventEmitter();Object.assign(owner,{id:91,mainFrame:{processId:17,routingId:22},rendererPID:8123,dead:false,
  isDestroyed(){return this.dead;},getOSProcessId(){options.getOSPID?.(f);return this.rendererPID;}});
 const event={sender:owner,senderFrame:owner.mainFrame},persistor=options.persistor??{async flushPersistenceAcknowledged(){}},mainOwner=options.readyOwner??Object.freeze({});
 const state={now:0,current:persistor};let current,nonce=0,timerId=0;
 const rowFor=t=>{assert(current&&current.ticket===t,'genuine current model Main ticket');return current;};
 const main={
  preflightNativeExecutorTransport(_ready,request,archive){
   const n=rows.length+1,b={...transportBinding(),operationId:'op_'+n.toString(16).padStart(32,'0'),nativeJobId:'exec_'+n.toString(16).padStart(32,'0'),
    requestSHA256:sha(Buffer.concat([Buffer.from(request),Buffer.from(archive)])),requestBytesSHA256:sha(request),archiveBytesSHA256:sha(archive)};
   const row={ticket:Object.freeze({}),binding:Object.freeze(b),held:false,released:false,B:sha(Buffer.from('pending'+n)),C:sha(Buffer.from('closed'+n)),outcome:null};
   current=row;rows.push(row);calls.push('preflight');return row.ticket;
  },getNativeExecutorTransportBinding(t){return rowFor(t).binding;},
  checkNativeExecutorTransport(t){const r=rowFor(t);if(r.held&&!r.released)throw Error('MODEL_MAIN_HELD');options.check?.(f,r);},
  holdNativeExecutorTransport(t){const r=rowFor(t);r.held=true;calls.push('hold-main');options.hold?.(f,r);},
  async reserveNativeExecutorTransport(t){rowFor(t);calls.push('reserve');},
  async prepareNativeExecutorTransportPending(t){const r=rowFor(t),b=r.binding;calls.push('pending');return{schema:'native-executor-pending-preparation/1',operationId:b.operationId,nativeJobId:b.nativeJobId,requestSHA256:b.requestSHA256,
   rootId:'1:2',inventorySHA256:r.B,effectsAllowed:false,installationPermit:false,nativeAdmission:false,powerLossPersistenceVerified:false};},
  async cancelNativeExecutorTransportPrepared(t){const r=rowFor(t),b=r.binding;calls.push('cancel');await options.cancel?.(f,r);
   r.closed={schema:'native-executor-inert-cancel-closed/1',operationId:b.operationId,nativeJobId:b.nativeJobId,requestSHA256:b.requestSHA256,packetSHA256:'c'.repeat(64),workerLifetime:'worker_'+'4'.repeat(32),inertCancelObservationSHA256:'d'.repeat(64),effectsAllowed:false,installationPermit:false,nativeAdmission:false};return r.closed;},
  async sealNativeExecutorTransportCancellation(t){const r=rowFor(t),b=r.binding;calls.push('cancel-seal');await options.cancelSeal?.(f,r);return{schema:'native-executor-terminal-transition/1',rootId:'1:2',previousInventorySHA256:r.B,inventorySHA256:r.C,
   operationId:b.operationId,nativeJobId:b.nativeJobId,requestSHA256:b.requestSHA256,packetSHA256:r.closed.packetSHA256,workerLifetime:r.closed.workerLifetime,evidenceSHA256:'e'.repeat(64)};},
  releaseNativeExecutorTransportCancellation(t){const r=rowFor(t),b=r.binding;calls.push('cancel-release');options.cancelRelease?.(f,r);
   r.release={schema:'native-executor-cancellation-release/1',operationId:b.operationId,nativeJobId:b.nativeJobId,requestSHA256:b.requestSHA256,rootId:'1:2',inventorySHA256:r.C,released:true,effectsAllowed:false,installationPermit:false,nativeAdmission:false};r.released=true;r.outcome='cancelled';options.afterCancelRelease?.(f,r);return r.release;},
  getNativeExecutorTransportCancellationRelease(t){const r=rowFor(t);calls.push('get-cancel-release');return r.outcome==='cancelled'?r.release:null;},
  async copyNativeExecutorTransport(t){rowFor(t);calls.push('copy');await options.copy?.(f,current);return{};},
  async registerNativeExecutorTransportCopied(t){const r=rowFor(t),b=r.binding;calls.push('register');r.observed={schema:'native-tracked-mod-registration-observed/2',operationId:b.operationId,nativeJobId:b.nativeJobId,requestSHA256:b.requestSHA256,recordSHA256:'a'.repeat(64),recordJSON:'{}',fullRecordSHA256:'b'.repeat(64),commitObserved:true,readbackVerified:true,trackedAssociationVerified:true,trackedInstallComplete:false,effectsAllowed:false,installationPermit:false,powerLossPersistenceVerified:false};return r.observed;},
  async closeNativeExecutorTransportWorker(t){rowFor(t);calls.push('close');return{};},async sealNativeExecutorTransportTerminal(t){rowFor(t);calls.push('seal');return{};},
  releaseNativeExecutorTransport(t){const r=rowFor(t),b=r.binding,o=r.observed;calls.push('release');r.release={schema:'native-registration-release-observed/1',operationId:b.operationId,nativeJobId:b.nativeJobId,requestSHA256:b.requestSHA256,recordSHA256:o.recordSHA256,fullRecordSHA256:o.fullRecordSHA256,released:true,consumedIDsRetained:true,durableConsumedIDsVerified:false,effectsAllowed:false,installationPermit:false,trackedInstallComplete:false};r.released=true;r.outcome='installed';return r.release;},
  getNativeExecutorTransportMainRelease(t){const r=rowFor(t);return r.outcome==='installed'?r.release:null;},
  prepareNativeExecutorCancellationSuccessor(t){const r=rowFor(t);assert.equal(r.outcome,'cancelled');calls.push('prepare-cancel-retire');return Object.freeze(()=>{options.retire?.(f,r);calls.push('cancel-retired');});},
  prepareNativeExecutorSuccessor(t){const r=rowFor(t);assert.equal(r.outcome,'installed');calls.push('prepare-success-retire');return Object.freeze(()=>{options.retire?.(f,r);calls.push('success-retired');});}
 };
 const context={nativeSuccessorHash:crypto.createHash,nativeTransportTypes:types,nativeTransportRandom(n){assert.equal(n,16);const b=Buffer.alloc(16);b.writeUInt32BE(++nonce,12);return b;},performance:{now:()=>state.now},process:{pid:process.pid},
  betterIpcMain:{handle:(name,fn)=>handlers.set(name,fn),on(){},send(target,channel,value){assert.equal(target,owner);messages.push({channel,value});
   if(channel==='persist:native-executor-challenge'){options.prepareChallenge?.(value,f);if(options.autoPrepare!==false&&value.stage!=='hold')queueMicrotask(()=>f.respondPrepare(value));}
   else if(channel==='persist:native-executor-execution-challenge'){calls.push('execution-round'+value.sequence);options.executionChallenge?.(value,f);if(options.autoExecution!==false&&value.sequence!==8)queueMicrotask(()=>f.respondExecution(value));}
   else{assert.equal(channel,'persist:native-executor-cancellation-challenge');calls.push('cancel-round'+value.sequence);options.cancelChallenge?.(value,f);if(options.autoCancel!==false&&value.sequence!==5)queueMicrotask(()=>f.respondCancel(value));}
  }},ipcMain:{on(name,fn){if(name.startsWith('persist:native-executor-'))assert(!listeners.has(name));listeners.set(name,fn);}},
  log(){},registerAllPersistedHives:async()=>({}),getMainPersistor:()=>state.current,waitForNativeMainPersistenceReady:()=>Promise.resolve(mainOwner),checkNativeMainPersistenceReady:o=>assert.equal(o,mainOwner),
  setTimeout(fn,ms){const id=++timerId;timers.set(id,{fn,ms});return id;},clearTimeout:id=>timers.delete(id),...main,...options.context};
 const api=execute(candidate,'({setupPersistenceIPC,bindPersistenceAcknowledgementSender,checkNativeExecutorFrame,holdNativeExecutorFrame,reserveNativeExecutorFrame,testOnlyCancellation:()=>nativeCancellationAttempt===undefined?null:({phase:nativeCancellationAttempt.phase,mainReleased:nativeCancellationAttempt.mainReleased,result:nativeCancellationAttempt.result??null}),testOnlyHistorySize:()=>nativeSuccessorHistory.size})',context);
 const f={api,handlers,listeners,timers,calls,messages,rows,state,owner,event,persistor,get current(){return current;},
  prepare:(r=Uint8Array.of(1),a=Uint8Array.of(2),e=event)=>handlers.get('persist:native-executor-prepare')(e,r,a),
  cancel:(id,e=event,...extra)=>handlers.get('persist:native-executor-cancel')(e,id,...extra),
  execute:(id,e=event,...extra)=>handlers.get('persist:native-executor-execute')(e,id,...extra),
  cancelHandoff:(id,c,e=event)=>handlers.get('persist:native-executor-cancellation-successor')(e,id,c),
  successHandoff:(id,c,e=event)=>handlers.get('persist:native-executor-successor')(e,id,c),
  respondPrepare(c,extra={},e=event){const b=current.binding;listeners.get('persist:native-executor-response')(e,{schema:'native-executor-response/1',transportId:c.transportId,challengeId:c.challengeId,round:c.round,stage:c.stage,requestSHA256:c.requestSHA256,requestBytesSHA256:c.requestBytesSHA256,archiveBytesSHA256:c.archiveBytesSHA256,state:c.round===1?'acquired':'checked',observation:{schema:'native-renderer-executor-admission/1',gameId:b.gameId,modId:b.modId,profileId:b.profileId,managerScopeId:b.managerScope,rendererGeneration:b.rendererGeneration,effectsAllowed:false,installationPermit:false},errorCode:null,...extra});},
  respondExecution:(c,extra={},e=event)=>listeners.get('persist:native-executor-execution-response')(e,executionResponse(c,extra)),
  respondCancel:(c,extra={},e=event)=>listeners.get('persist:native-executor-cancellation-response')(e,cancellationReply(c,extra)),
  invalidateCancel(c,e=event,extra={}){listeners.get('persist:native-executor-cancellation-invalidated')(e,{schema:'native-executor-cancellation-invalidated/1',transportId:c.transportId,cancellationId:c.cancellationId,operationId:c.operationId,nativeJobId:c.nativeJobId,requestSHA256:c.requestSHA256,requestBytesSHA256:c.requestBytesSHA256,archiveBytesSHA256:c.archiveBytesSHA256,reasonCode:'NATIVE_EXECUTOR_RENDERER_FAILED',...extra});},
  cancelChallenges:()=>messages.filter(x=>x.channel==='persist:native-executor-cancellation-challenge').map(x=>x.value),
  timeout(){state.now=120001;for(const{fn}of [...timers.values()])fn();}
 };
 api.setupPersistenceIPC(persistor);api.bindPersistenceAcknowledgementSender(owner);return f;
}
