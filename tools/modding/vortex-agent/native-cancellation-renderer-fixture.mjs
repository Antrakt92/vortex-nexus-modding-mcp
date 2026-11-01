// Actual ExtensionManager + actual inert Root/flush/manager and real Redux.
// Main/preload wire is an explicit facade: no Main, SQL, SDK or child process.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createCoordinatorAdmissionFixture} from './native-cancellation-renderer-admission-fixture.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
export const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
export const tick=()=>new Promise(resolve=>setImmediate(resolve));
export async function createCancellationFixture(options={}){
 const prepareGate=deferred(),cancelGate=deferred(),handoffGate=deferred();
 let prepareReceiver,cancelReceiver;const calls=[],invalidations=[],registrations={prepare:0,execution:0,cancellation:0};
 const persist={
  prepareNativeExecutor(r,a){calls.push(['prepare']);return prepareGate.promise;},
  onExecutorChallenge(fn){registrations.prepare++;prepareReceiver=fn;return()=>{};},
  executeNativeExecutor(){calls.push(['execute']);return Promise.reject(Error('Execution outside cancellation fixture'));},
  onExecutorExecutionChallenge(){registrations.execution++;return()=>{};},invalidateNativeExecutorExecution(){},
  handoffNativeExecutorSuccessor(){calls.push(['success-handoff']);return Promise.reject(Error('Success handoff outside cancellation fixture'));},
  cancelNativeExecutorPrepared(id){calls.push(['cancel',id]);return options.cancelInvoke?options.cancelInvoke(id):cancelGate.promise;},
  onExecutorCancellationChallenge(fn){registrations.cancellation++;cancelReceiver=fn;return()=>{};},
  invalidateNativeExecutorCancellation(v){invalidations.push(structuredClone(v));options.invalidate?.(v);},
  handoffNativeExecutorCancellationSuccessor(t,c){calls.push(['cancel-handoff',t,c]);return options.handoffInvoke?options.handoffInvoke(t,c):handoffGate.promise;}
 };
 const window={api:{persist}},f=createCoordinatorAdmissionFixture({...options,transportWindow:window});
 const request=Buffer.from('{"own":"cancel-request"}'),archive=Buffer.from('{"own":"cancel-archive"}');
 const transportId='transport_'+'1'.repeat(32),cancellationId='cancellation_'+'5'.repeat(32);
 const binding=()=>({operationId:'op_'+'2'.repeat(32),nativeJobId:'exec_'+'3'.repeat(32),requestSHA256:'a'.repeat(64),requestBytesSHA256:sha(request),archiveBytesSHA256:sha(archive),
  gameId:'game',modId:'new',profileId:'p',managerScope:'manager-fixture-1',rendererGeneration:f.manager.getNativeInstallExclusion().rendererGeneration});
 const compact=()=>Object.fromEntries(Object.entries(binding()).filter(([k])=>!['gameId','modId','profileId','managerScope','rendererGeneration'].includes(k)));
 const release=()=>{const b=binding();return{schema:'native-executor-cancellation-release/1',operationId:b.operationId,nativeJobId:b.nativeJobId,requestSHA256:b.requestSHA256,rootId:'1:2',inventorySHA256:'c'.repeat(64),released:true,effectsAllowed:false,installationPermit:false,nativeAdmission:false};};
 const challenge=(sequence,extra={})=>({schema:'native-executor-cancellation-challenge/1',transportId,cancellationId,challengeId:'challenge_'+String(sequence).repeat(32),sequence,
  stage:['prepare-inert-release','check-inert-after-close','check-inert-before-main-release','finalize-inert-release','hold'][sequence-1],payloadJSON:sequence===4?JSON.stringify(release()):null,...binding(),...extra});
 const result=()=>({schema:'native-executor-cancellation-result/1',transportId,cancellationId,...compact(),rootId:'1:2',inventorySHA256:'c'.repeat(64),outcome:'prepared_no_start_cancelled_worker_closed',
  mainReleased:true,rendererReleased:true,effectsAllowed:false,installationPermit:false,nativeAdmission:false,powerLossPersistenceVerified:false});
 const successor=()=>{const b=binding();return{schema:'native-executor-cancellation-successor/1',transportId,cancellationId,operationId:b.operationId,nativeJobId:b.nativeJobId,requestSHA256:b.requestSHA256,ready:true,effectsAllowed:false,installationPermit:false,nativeAdmission:false};};
 return{...f,persist,window,prepareGate,cancelGate,handoffGate,request,archive,transportId,cancellationId,binding,calls,invalidations,registrations,release,challenge,result,successor,
  receive:c=>cancelReceiver(c),
  async prepared(){await f.ready();const flight=f.ext.prepareNativeExecutor(request,archive);for(const round of[1,2,3])assert.equal((await prepareReceiver({schema:'native-executor-challenge/1',transportId,challengeId:'challenge_'+String(round).repeat(32),round,stage:round===1?'acquire':'check',...binding()})).state,round===1?'acquired':'checked');
   prepareGate.resolve({schema:'native-executor-transport-preparation/1',transportId,...compact(),rootId:'1:2',inventorySHA256:'b'.repeat(64),effectsAllowed:false,installationPermit:false,nativeAdmission:false,powerLossPersistenceVerified:false});await flight;},
  async complete(){const flight=f.ext.cancelNativeExecutorPrepared();for(const n of[1,2,3,4])assert.equal((await cancelReceiver(challenge(n))).state,n===1?'prepared':n===4?'finalized':'checked');cancelGate.resolve(result());return flight;}
 };
}
