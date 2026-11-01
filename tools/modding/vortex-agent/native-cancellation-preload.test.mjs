import test from 'node:test';
import assert from 'node:assert/strict';
import {createCancellationPreloadFixture,cancellationChallenge,cancellationResponse,stages,tick} from './native-cancellation-preload-fixture.mjs';
const available=process.env.VORTEX_EXTENSION_ADMISSION_REPO;
const sourceTest=(name,fn)=>test(name,{skip:available?false:'Set VORTEX_EXTENSION_ADMISSION_REPO'},fn);

 sourceTest('fixed cancellation invokes expose only transport/cancellation labels and preserve success invoke ABI',async()=>{
  const f=createCancellationPreloadFixture(),c=cancellationChallenge();
  await f.persist.cancelNativeExecutorPrepared(c.transportId,'ignored');
  await f.persist.handoffNativeExecutorCancellationSuccessor(c.transportId,c.cancellationId,'ignored');
  await f.persist.executeNativeExecutor(c.transportId,'ignored');
  await f.persist.handoffNativeExecutorSuccessor(c.transportId,'execution_'+'8'.repeat(32),'ignored');
  assert.deepEqual(f.invoked,[['persist:native-executor-cancel',c.transportId],['persist:native-executor-cancellation-successor',c.transportId,c.cancellationId],['persist:native-executor-execute',c.transportId],['persist:native-executor-successor',c.transportId,'execution_'+'8'.repeat(32)]]);
 });
 sourceTest('all four cancellation stages and HOLD preserve exact cloned 17/12/11 envelopes',async()=>{
  const f=createCancellationPreloadFixture();let seen;
  f.persist.onExecutorCancellationChallenge(async c=>{seen=c;return cancellationResponse(c);});
  for(let n=1;n<=5;n++){
   const c=cancellationChallenge(n);f.deliver(c);c.modId='mutated';await tick();const row=f.sent.at(-1),r=row.value;
   assert.equal(row.channel,'persist:native-executor-cancellation-response');assert.equal(Object.keys(seen).length,17);assert(Object.isFrozen(seen));assert.equal(seen.modId,'Own');assert.equal(Object.keys(r).length,12);
   assert.equal(r.state,n===5?'held':n===1?'prepared':n===4?'finalized':'checked');
   if(n===5)assert.equal(r.observation,null);else{assert.equal(Object.keys(r.observation).length,11);assert(Object.isFrozen(r.observation));assert.equal(r.observation.targetAbsent,true);}
   assert.equal(r.errorCode,null);
  }
 });
 sourceTest('malformed nonce/schema/stage/payload/extra/getter/proxy challenges never call handler',async()=>{
  const f=createCancellationPreloadFixture();let calls=0,traps=0;
  f.persist.onExecutorCancellationChallenge(async c=>{calls++;return cancellationResponse(c);});
  const getter=cancellationChallenge();Object.defineProperty(getter,'sequence',{get(){traps++;return 1;}});
  const malformed=[cancellationChallenge(1,{schema:'native-executor-execution-challenge/1'}),cancellationChallenge(1,{cancellationId:'execution_'+'9'.repeat(32)}),
   cancellationChallenge(1,{challengeId:'wrong'}),cancellationChallenge(1,{extra:true}),cancellationChallenge(1,{stage:stages[1]}),
   cancellationChallenge(1,{payloadJSON:'{}'}),cancellationChallenge(4,{payloadJSON:null}),cancellationChallenge(4,{payloadJSON:'x'.repeat(8193)}),
   cancellationChallenge(4,{payloadJSON:'\u00e9'.repeat(4097)}),cancellationChallenge(1,{sequence:NaN}),getter,
   new Proxy(cancellationChallenge(),{ownKeys(){traps++;return[];}})];
  for(const c of malformed)f.deliver(c);await tick();assert.equal(calls,0);assert.equal(traps,0);assert.equal(f.sent.length,0);
 });
 sourceTest('tuple and nested observation mismatches serialize only fixed correlated failed responses',async()=>{
  let gets=0;
  for(const mutate of [r=>r.cancellationId='cancellation_'+'f'.repeat(32),r=>r.sequence=2,r=>r.extra='private',r=>r.observation.operationId='op_'+'f'.repeat(32),
   r=>r.observation.targetAbsent=false,r=>r.observation.installationPermit=true,r=>r.observation.state='finalized',
   r=>Object.defineProperty(r.observation,'requestSHA256',{get(){gets++;throw Error('secret')}}),
   r=>r.observation=new Proxy(r.observation,{ownKeys(){gets++;throw Error('secret')}})]) {
   const f=createCancellationPreloadFixture();f.persist.onExecutorCancellationChallenge(async c=>{const r=cancellationResponse(c);mutate(r);return r;});f.deliver(cancellationChallenge());await tick();
   const r=f.sent[0].value;assert.equal(r.state,'failed');assert.equal(r.observation,null);assert.equal(r.errorCode,'NATIVE_EXECUTOR_RENDERER_FAILED');assert.equal(r.cancellationId,cancellationChallenge().cancellationId);assert(!JSON.stringify(f.sent).includes('private'));
  }assert.equal(gets,0);
 });
 sourceTest('thenables/proxy promises never invoke then; primitive failures and late rejection are observed safely',async()=>{
  let gets=0;
  for(const handler of [()=>({get then(){gets++;throw Error('secret')}}),()=>new Proxy(Promise.resolve(),{get(){gets++;throw Error('secret')}}),()=>{throw null;},async()=>{throw undefined;}]) {
   const f=createCancellationPreloadFixture();f.persist.onExecutorCancellationChallenge(handler);f.deliver(cancellationChallenge());await tick();assert.equal(f.sent[0].value.state,'failed');assert.equal(f.sent[0].value.observation,null);
  }assert.equal(gets,0);
  let reject;const pending=new Promise((_r,j)=>reject=j),f=createCancellationPreloadFixture();f.persist.onExecutorCancellationChallenge(()=>pending);f.deliver(cancellationChallenge());assert.equal(f.sent.length,0);reject(Error('private-late'));await tick();assert.equal(f.sent[0].value.state,'failed');assert(!JSON.stringify(f.sent).includes('private-late'));
 });
 sourceTest('receiver lifetime cannot rebound after off or uncertain registration, including handler proxy rejection',()=>{
  let traps=0;const f=createCancellationPreloadFixture();assert.throws(()=>f.persist.onExecutorCancellationChallenge(new Proxy(()=>Promise.resolve(),{get(){traps++;throw Error('trap')}})));assert.equal(traps,0);
  const off=f.persist.onExecutorCancellationChallenge(async c=>cancellationResponse(c));off();assert.equal(f.listeners.has('persist:native-executor-cancellation-challenge'),false);assert.throws(()=>f.persist.onExecutorCancellationChallenge(async c=>cancellationResponse(c)));
  const g=createCancellationPreloadFixture({on(){throw Error('uncertain')}});assert.throws(()=>g.persist.onExecutorCancellationChallenge(async c=>cancellationResponse(c)));assert.throws(()=>g.persist.onExecutorCancellationChallenge(async c=>cancellationResponse(c)));
 });
 sourceTest('negative invalidation uses exact closed nine-field detached immutable message',()=>{
  const f=createCancellationPreloadFixture(),c=cancellationChallenge(),d={schema:'native-executor-cancellation-invalidated/1',transportId:c.transportId,cancellationId:c.cancellationId,operationId:c.operationId,nativeJobId:c.nativeJobId,requestSHA256:c.requestSHA256,requestBytesSHA256:c.requestBytesSHA256,archiveBytesSHA256:c.archiveBytesSHA256,reasonCode:'NATIVE_EXECUTOR_RENDERER_FAILED'};
  f.persist.invalidateNativeExecutorCancellation(d);d.reasonCode='changed';assert.equal(f.sent[0].channel,'persist:native-executor-cancellation-invalidated');assert.equal(Object.keys(f.sent[0].value).length,9);assert.equal(f.sent[0].value.reasonCode,'NATIVE_EXECUTOR_RENDERER_FAILED');assert(Object.isFrozen(f.sent[0].value));
  let gets=0;const getter={...d,reasonCode:'NATIVE_EXECUTOR_RENDERER_FAILED'};Object.defineProperty(getter,'requestSHA256',{get(){gets++;return c.requestSHA256;}});
  for(const raw of [{...d,extra:true},{...d,reasonCode:'NATIVE_EXECUTOR_RENDERER_FAILED',cancellationId:'execution_'+'9'.repeat(32)},getter,new Proxy(d,{ownKeys(){gets++;return[];}})])assert.throws(()=>f.persist.invalidateNativeExecutorCancellation(raw));assert.equal(gets,0);assert.equal(f.sent.length,1);
 });
 sourceTest('wrong successful or HOLD state never substitutes for checked/finalized cancellation observation',async()=>{
  for(const [n,extra]of [[1,{state:'checked'}],[2,{state:'finalized'}],[4,{state:'held',observation:null}],[5,{state:'checked',observation:null}],[1,{state:'failed',observation:null,errorCode:'private'}]]){
   const f=createCancellationPreloadFixture();f.persist.onExecutorCancellationChallenge(async c=>cancellationResponse(c,extra));f.deliver(cancellationChallenge(n));await tick();assert.equal(f.sent[0].value.state,'failed');assert.equal(f.sent[0].value.errorCode,'NATIVE_EXECUTOR_RENDERER_FAILED');
  }
 });
