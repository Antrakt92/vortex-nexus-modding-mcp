import {cancellationSource} from './native-cancellation-source-fixture.mjs';
// Actual candidate preload in a pure Electron transport facade. No app/child/DB.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
import {types} from 'node:util';
import {createHash} from 'node:crypto';
import {stripTypeScriptTypes} from 'node:module';
const sha=b=>createHash('sha256').update(b).digest('hex');
export const tick=()=>new Promise(r=>setImmediate(r));
export const stages=['prepare-inert-release','check-inert-after-close','check-inert-before-main-release','finalize-inert-release','hold'];
export function cancellationChallenge(sequence=1,extra={}) {
 return {schema:'native-executor-cancellation-challenge/1',transportId:'transport_'+'1'.repeat(32),
  cancellationId:'cancellation_'+'9'.repeat(32),challengeId:'challenge_'+String(sequence).repeat(32),sequence,stage:stages[sequence-1],payloadJSON:sequence===4?'{}':null,
  operationId:'op_'+'2'.repeat(32),nativeJobId:'exec_'+'3'.repeat(32),requestSHA256:'a'.repeat(64),requestBytesSHA256:'b'.repeat(64),archiveBytesSHA256:'c'.repeat(64),
  gameId:'cyberpunk2077',modId:'Own',profileId:'_p',managerScope:'manager-own-1',rendererGeneration:'renderer_'+'4'.repeat(32),...extra};
}
export function cancellationObservation(c) {
 return {schema:'native-executor-renderer-cancellation/1',transportId:c.transportId,cancellationId:c.cancellationId,operationId:c.operationId,nativeJobId:c.nativeJobId,
  requestSHA256:c.requestSHA256,state:c.sequence===1?'prepared':c.sequence===4?'finalized':'checked',targetAbsent:true,effectsAllowed:false,installationPermit:false,nativeAdmission:false};
}
export function cancellationResponse(c,extra={}) {
 return {schema:'native-executor-cancellation-response/1',transportId:c.transportId,cancellationId:c.cancellationId,challengeId:c.challengeId,
  sequence:c.sequence,stage:c.stage,requestSHA256:c.requestSHA256,requestBytesSHA256:c.requestBytesSHA256,archiveBytesSHA256:c.archiveBytesSHA256,
  state:c.sequence===5?'held':c.sequence===1?'prepared':c.sequence===4?'finalized':'checked',observation:c.sequence===5?null:cancellationObservation(c),errorCode:null,...extra};
}
export function createCancellationPreloadFixture(options={}) {
 const raw=Buffer.from(cancellationSource('native-cancellation-preload'));
 const text=stripTypeScriptTypes(raw.toString(),{mode:'transform'}),start=text.indexOf('let nativeExecutorReceiverBound'),end=text.indexOf('try {\n    expose(',start),p=text.indexOf('persist: {'),q=text.indexOf('extensions: {',p);
 assert(start>=0&&end>start&&q>p,'exact actual preload helper/object boundaries');
 const listeners=new Map(),sent=[],invoked=[];
 const persist=vm.runInNewContext(text.slice(start,end)+'\n({'+text.slice(p,q)+'}).persist;',{
  Buffer,nativeExecutorPreloadTypes:types,betterIpcRenderer:{
   invoke:(...args)=>{invoked.push(args);return options.invoke?.(...args)??Promise.resolve({});},
   on:(channel,fn)=>{listeners.set(channel,fn);options.on?.(channel,fn);},
   off:(channel,fn)=>{if(listeners.get(channel)===fn)listeners.delete(channel);},
   send:(channel,value)=>{sent.push({channel,value});options.send?.(channel,value);}
  }
 });
 return {persist,listeners,sent,invoked,deliver:c=>listeners.get('persist:native-executor-cancellation-challenge')?.(undefined,c)};
}
