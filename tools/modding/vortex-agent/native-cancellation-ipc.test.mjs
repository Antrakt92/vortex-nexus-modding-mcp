// Private actual IPC source, explicit Main/Electron delivery facades. Root alone executes.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createCancellationIPCFixture as fixture} from './native-cancellation-ipc-fixture.mjs';
const actor=(name,fn)=>test(name,{timeout:10000,skip:process.env.VORTEX_EXTENSION_ADMISSION_REPO?false:'Set reviewed original source repo'},fn);
const tick=()=>new Promise(r=>setImmediate(r));
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};}
const noInstall=f=>{assert(!f.calls.includes('copy'));assert(!f.calls.includes('register'));assert(!f.calls.includes('close'));assert(!f.calls.includes('seal'));assert(!f.calls.includes('release'));};

actor('actual IPC four rounds order cancel/join, seal, Main release and Renderer finalize with closed false-permission result',async()=>{
 const f=fixture(),p=await f.prepare(),r=await f.cancel(p.transportId);
 assert.deepEqual(f.calls,['preflight','reserve','pending','cancel-round1','cancel','cancel-round2','cancel-seal','cancel-round3','cancel-release','cancel-round4']);
 assert.equal(r.schema,'native-executor-cancellation-result/1');assert.equal(Object.keys(r).length,17);assert.equal(r.outcome,'prepared_no_start_cancelled_worker_closed');
 assert.equal(r.operationId,p.operationId);assert.equal(r.requestSHA256,p.requestSHA256);assert.equal(r.rootId,'1:2');assert.equal(r.inventorySHA256,f.current.C);
 for(const k of ['effectsAllowed','installationPermit','nativeAdmission','powerLossPersistenceVerified'])assert.equal(r[k],false);assert(r.mainReleased&&r.rendererReleased);
 const c=f.cancelChallenges();assert.deepEqual(c.map(x=>x.sequence),[1,2,3,4]);assert.equal(new Set(c.map(x=>x.challengeId)).size,4);
 assert(c.slice(0,3).every(x=>x.payloadJSON===null));const receipt=JSON.parse(c[3].payloadJSON);assert.equal(receipt.schema,'native-executor-cancellation-release/1');assert.equal(Object.keys(receipt).length,10);
 assert.equal(f.timers.size,0);assert.equal(f.current.held,false);noInstall(f);
});

actor('cancel/closure and terminal-CAS failures preserve primary null and undefined, never Main release/finalize',async()=>{
 for(const stage of ['cancel','cancelSeal'])for(const primary of [null,undefined]){
  const f=fixture({[stage]:()=>{throw primary;}}),p=await f.prepare();let caught=false;
  await f.cancel(p.transportId).then(()=>assert.fail('unexpected success'),e=>{caught=true;assert.equal(e,primary);});assert(caught);
  assert.equal(f.current.held,true);assert.equal(f.current.released,false);assert(!f.calls.includes('cancel-release'));assert(!f.calls.includes('cancel-round4'));
  assert.equal(f.api.testOnlyCancellation().mainReleased,false);assert.equal(f.api.testOnlyCancellation().result,null);assert.equal(f.timers.size,0);noInstall(f);
 }
});

actor('wrong frame and stale nonce cannot consume current cancellation challenge; correlated forgery holds before Main cancel',async()=>{
 const f=fixture({autoCancel:false}),p=await f.prepare(),work=f.cancel(p.transportId);void work.catch(()=>{});await tick();const first=f.cancelChallenges()[0];
 f.respondCancel(first,{}, {sender:{...f.owner},senderFrame:f.owner.mainFrame});f.respondCancel(first,{}, {sender:f.owner,senderFrame:{...f.owner.mainFrame}});
 f.respondCancel(first,{challengeId:'challenge_'+'f'.repeat(32)});await tick();assert(!f.calls.includes('cancel'));
 f.respondCancel(first);for(let seq=2;seq<=4;seq++){await tick();const c=f.cancelChallenges().find(x=>x.sequence===seq);assert(c);f.respondCancel(c);}
 assert.equal((await work).rendererReleased,true);
 const g=fixture({autoCancel:false}),q=await g.prepare(),bad=g.cancel(q.transportId);void bad.catch(()=>{});await tick();
 g.respondCancel(g.cancelChallenges()[0],{requestSHA256:'f'.repeat(64)});await assert.rejects(bad);assert(g.current.held);assert(!g.calls.includes('cancel'));noInstall(g);
});

actor('provisional auth getter reentry blocks execute and outer cancel, while unauthenticated foreign event leaves prepared owner usable',async()=>{
 const f=fixture(),p=await f.prepare();let nested;const e={senderFrame:f.owner.mainFrame};
 Object.defineProperty(e,'sender',{get(){if(!nested){nested=f.execute(p.transportId,e);void nested.catch(()=>{});}return f.owner;}});
 await assert.rejects(f.cancel(p.transportId,e));await assert.rejects(nested);assert(f.current.held);assert(!f.calls.includes('cancel'));assert(!f.calls.includes('copy'));
 const g=fixture(),q=await g.prepare();const foreign=Object.defineProperty({},'sender',{get(){throw Error('foreign');}});
 await assert.rejects(g.cancel(q.transportId,foreign));assert.equal(g.current.held,false);assert.equal(g.api.testOnlyCancellation(),null);
 assert.equal((await g.cancel(q.transportId)).rendererReleased,true);noInstall(g);
});

actor('deadline settles observer without settling underlying cancel, and late rejection cannot seal or replay',async()=>{
 const gate=deferred(),entered=deferred(),f=fixture({cancel:()=>{entered.resolve();return gate.promise;}}),p=await f.prepare(),work=f.cancel(p.transportId);void work.catch(()=>{});await entered.promise;
 f.timeout();await assert.rejects(work);assert(f.current.held);assert(!f.calls.includes('cancel-seal'));assert.equal(f.timers.size,0);
 gate.reject(Error('late model closure'));await tick();await assert.rejects(f.cancel(p.transportId));assert.equal(f.calls.filter(x=>x==='cancel').length,1);assert(!f.calls.includes('cancel-release'));noInstall(f);
});

actor('authentic execute/cancel and duplicate prepare races immediately hold stalled observer without new control lane',async()=>{
 for(const mode of ['execute-during-cancel','prepare-during-cancel','cancel-during-execute']){
  const gate=deferred(),entered=deferred(),executing=mode==='cancel-during-execute',f=fixture({[executing?'copy':'cancel']:()=>{entered.resolve();return gate.promise;}}),p=await f.prepare();
  const work=executing?f.execute(p.transportId):f.cancel(p.transportId);void work.catch(()=>{});await entered.promise;
  const competing=mode==='execute-during-cancel'?f.execute(p.transportId):mode==='prepare-during-cancel'?f.prepare():f.cancel(p.transportId);
  await assert.rejects(competing);let settled=false;void work.then(()=>{settled=true;},()=>{settled=true;});await tick();assert.equal(settled,true,'observer rejects before underlying gate settles');
  assert(f.current.held);gate.resolve();await assert.rejects(work);await tick();assert.equal(f.calls.filter(x=>x==='copy').length,executing?1:0);assert.equal(f.calls.filter(x=>x==='cancel').length,executing?0:1);assert(!f.calls.includes('register'));assert(!f.calls.includes('cancel-release'));
 }
});

actor('lost Main release return preserves primitive primary and truthful split release, never finalizes Renderer',async()=>{
 for(const primary of [null,undefined]){
  const f=fixture({afterCancelRelease:()=>{throw primary;}}),p=await f.prepare();let caught=false;
  await f.cancel(p.transportId).then(()=>assert.fail('unexpected complete'),e=>{caught=true;assert.equal(e,primary);});assert(caught);
  assert.equal(f.current.released,true);assert.equal(f.current.held,false);assert.equal(f.api.testOnlyCancellation().mainReleased,true);assert.equal(f.api.testOnlyCancellation().phase,'held');
  assert.equal(f.api.testOnlyCancellation().result,null);assert.equal(f.calls.filter(x=>x==='get-cancel-release').length,1);assert(!f.calls.includes('cancel-round4'));
  assert.throws(()=>f.cancelHandoff(p.transportId,f.cancelChallenges()[0].cancellationId));assert.equal(f.calls.filter(x=>x==='cancel-release').length,1);noInstall(f);
 }
});

actor('cancelled retirement retains exact retry ACK; both-outcome stale filters protect later running operation and common history',async()=>{
 let block=false;const gate=deferred(),entered=deferred(),f=fixture({copy:()=>{if(block){entered.resolve();return gate.promise;}}});
 const p=await f.prepare(),r=await f.cancel(p.transportId),ack=f.cancelHandoff(p.transportId,r.cancellationId);assert.equal(Object.keys(ack).length,10);assert(Object.isFrozen(ack));
 // First return can be lost: exact repeat authenticates retained history, no second Main retirement.
 assert.equal(f.cancelHandoff(p.transportId,r.cancellationId),ack);assert.equal(f.calls.filter(x=>x==='cancel-retired').length,1);
 const q=await f.prepare(Uint8Array.of(3),Uint8Array.of(4));block=true;const work=f.execute(q.transportId);void work.catch(()=>{});await entered.promise;
 try{
  await assert.rejects(f.prepare());await assert.rejects(f.cancel(p.transportId));await assert.rejects(f.execute(p.transportId));
  for(const channel of ['persist:native-executor-response','persist:native-executor-execution-response','persist:native-executor-execution-invalidated','persist:native-executor-cancellation-response','persist:native-executor-cancellation-invalidated'])f.listeners.get(channel)(f.event,{transportId:p.transportId,malformedOld:true});
  assert.equal(f.cancelHandoff(p.transportId,r.cancellationId),ack);assert.throws(()=>f.cancelHandoff(p.transportId,r.cancellationId,{sender:f.owner,senderFrame:{...f.owner.mainFrame}}));assert.equal(f.current.held,false);
 }finally{gate.resolve();}
 const success=await work,successACK=f.successHandoff(q.transportId,success.executionId);assert.equal(successACK.schema,'native-executor-successor/1');assert.equal(f.api.testOnlyHistorySize(),2);
 const third=await f.prepare(Uint8Array.of(5),Uint8Array.of(6));assert.equal(f.cancelHandoff(p.transportId,r.cancellationId),ack);assert.equal(f.successHandoff(q.transportId,success.executionId),successACK);
 assert.throws(()=>f.successHandoff(p.transportId,r.cancellationId));assert.throws(()=>f.cancelHandoff(q.transportId,success.executionId));assert.equal(f.current.held,false);
 assert.equal((await f.cancel(third.transportId)).rendererReleased,true);
});

actor('existing seven-round installed-success protocol still completes two distinct jobs in new IPC source',async()=>{
 const f=fixture(),p=await f.prepare(),first=await f.execute(p.transportId),a=f.successHandoff(p.transportId,first.executionId);
 const q=await f.prepare(Uint8Array.of(7),Uint8Array.of(8)),second=await f.execute(q.transportId),b=f.successHandoff(q.transportId,second.executionId);
 assert.equal(first.schema,'native-executor-execution-result/1');assert.equal(second.schema,first.schema);assert.equal(Object.keys(first).length,17);
 assert.notEqual(first.operationId,second.operationId);assert.notEqual(first.requestSHA256,second.requestSHA256);assert.notEqual(first.executionId,second.executionId);assert.equal(f.rows.length,2);
 assert.equal(f.calls.filter(x=>x==='copy').length,2);assert.equal(f.calls.filter(x=>x==='register').length,2);assert.equal(f.calls.filter(x=>x==='execution-round7').length,2);
 assert.equal(f.calls.filter(x=>x==='success-retired').length,2);assert.equal(f.api.testOnlyHistorySize(),2);assert.equal(f.successHandoff(p.transportId,first.executionId),a);assert.equal(f.successHandoff(q.transportId,second.executionId),b);
 assert(!f.calls.includes('cancel'));assert.equal(f.timers.size,0);
});

actor('authentic callback reentry during cancelled handoff holds before Main retire and does not clear completed record',async()=>{
 let armed=false,nested=0,p,r,f;f=fixture({getOSPID(){if(armed){armed=false;nested++;assert.throws(()=>f.cancelHandoff(p.transportId,r.cancellationId));}}});
 p=await f.prepare();r=await f.cancel(p.transportId);armed=true;assert.throws(()=>f.cancelHandoff(p.transportId,r.cancellationId));assert.equal(nested,1);
 assert.equal(f.calls.filter(x=>x==='cancel-retired').length,0);assert.equal(f.api.testOnlyCancellation().phase,'completed');assert.equal(f.current.released,true);
 assert.throws(()=>f.cancelHandoff(p.transportId,r.cancellationId));await assert.rejects(f.prepare(Uint8Array.of(9),Uint8Array.of(10)));assert.equal(f.rows.length,1);
});
