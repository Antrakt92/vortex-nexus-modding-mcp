import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import vm from 'node:vm';
import {types} from 'node:util';
import {stripTypeScriptTypes} from 'node:module';
import {fileURLToPath} from 'node:url';
import {repo,stage,sha} from './native-query-source-admission.test.mjs';
import {completionSource} from './native-executor-completion-preload.test.mjs';
export function createSuccessorPreloadFixture(options={}){
 const text=stripTypeScriptTypes(completionSource('native-executor-successor-preload'),{mode:'transform'}),start=text.indexOf('let nativeExecutorReceiverBound'),end=text.indexOf('try {\n    expose(',start),p=text.indexOf('persist: {'),q=text.indexOf('extensions: {',p);
 assert(start>=0&&end>start&&q>p);const listeners=new Map(),sent=[],invoked=[];
 const persist=vm.runInNewContext(text.slice(start,end)+'\n({'+text.slice(p,q)+'}).persist;',{
  Buffer,nativeExecutorPreloadTypes:types,betterIpcRenderer:{invoke:(...args)=>{invoked.push(args);return options.invoke?.(...args)??Promise.resolve({});},
   on:(name,fn)=>{listeners.set(name,fn);options.on?.(name,fn);},off:(name,fn)=>{if(listeners.get(name)===fn)listeners.delete(name);},send:(channel,value)=>{sent.push({channel,value});options.send?.(channel,value);}},
 });
 return{persist,listeners,sent,invoked,deliver:c=>listeners.get('persist:native-executor-execution-challenge')?.(undefined,c)};
}
const integration=(name,fn)=>test(name,{skip:repo?false:'Set VORTEX_EXTENSION_ADMISSION_REPO',timeout:10000},fn);
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 test('successor shared/preload sources pin exact predecessors and companion outputs',()=>{
  for(const name of ['native-executor-successor-shared-ipc','native-executor-successor-shared-preload','native-executor-successor-preload']){
   const {m,patch}=stage(name),parent=stage(m.prerequisitePatch.slice(0,-6)).m;
   assert.equal(sha(patch),m.patchSHA256);assert.equal(m.inputSHA256,parent.outputSHA256);assert.equal(m.prerequisitePatchSHA256,parent.patchSHA256);
   for(const c of m.additionalCompanions??[]){const actual=stage(c.name).m;assert.equal(c.patchSHA256,actual.patchSHA256);assert.equal(c.outputSHA256,actual.outputSHA256);}
   assert.equal(m.installed,false);assert.equal(m.nativeAdmission,false);
  }
 });
 integration('actual preload handoff forwards only two IDs on its fixed channel and preserves exact ACK',async()=>{
  const ack=Object.freeze({schema:'native-executor-successor/1',transportId:'transport_1',executionId:'execution_1',operationId:'op_1',nativeJobId:'job_1',requestSHA256:'a'.repeat(64),ready:true,effectsAllowed:false,installationPermit:false,nativeAdmission:false});
  const f=createSuccessorPreloadFixture({invoke:()=>Promise.resolve(ack)});
  assert.equal(await f.persist.handoffNativeExecutorSuccessor(ack.transportId,ack.executionId,'ignored'),ack);
  assert.deepEqual(f.invoked,[['persist:native-executor-successor',ack.transportId,ack.executionId]]);assert.equal(f.sent.length,0);
 });
 integration('unknown handoff rejection preserves original primary and does not replay install/release',async()=>{
  for(const primary of [null,undefined,Error('own failure')]){
   const f=createSuccessorPreloadFixture({invoke:()=>Promise.reject(primary)});
   await f.persist.handoffNativeExecutorSuccessor('transport_1','execution_1').then(()=>assert.fail('unexpected ACK'),error=>assert.equal(error,primary));
   assert.equal(f.invoked.length,1);assert.equal(f.sent.length,0);
  }
 });
}
