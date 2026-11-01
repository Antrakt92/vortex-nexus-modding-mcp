import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {createNativeExecutorJournal} from './native-executor-journal.mjs';
import {deferred,tick} from './native-query-source-admission.test.mjs';

const available=process.env.VORTEX_EXTENSION_ADMISSION_REPO;
const integration=(name,fn)=>test(name,{timeout:15000,skip:available?false:'Set reviewed source input'},fn);
const sha=b=>createHash('sha256').update(b).digest('hex');
let factoryPromise;
function moduleSource(text,url){
  text=text.replace(/(from\s*['"])(\.\/[^'"]+)(['"])/g,(_a,b,c,d)=>b+new URL(c,url).href+d);
  text=text.replaceAll("'import.meta.url'","'__NATIVE_META_LITERAL__'").replaceAll('import.meta.url',JSON.stringify(url.href)).replaceAll('__NATIVE_META_LITERAL__','import.meta.url');
  return 'data:text/javascript;base64,'+Buffer.from(text).toString('base64');
}
async function factory(){
  if(factoryPromise)return factoryPromise;
  // Include the actual QueryRegistry/SQL release producers before their methods
  // are captured by Level/Main. The older preparation fixture never released.
  const singletonURL=new URL('./native-singleton-sql-admission.test.mjs',import.meta.url);
  let singleton=fs.readFileSync(singletonURL,'utf8');
  assert.equal(singleton.split('Registry=registryClass()').length,2);
  singleton=singleton.replace('Registry=registryClass()',"Registry=execute(prepared(['native-query-source-admission','native-query-registration-release']),'QueryRegistry')");
  assert.equal(singleton.split("prepared(['native-singleton-sql-admission'])").length,2);
  singleton=singleton.replace("prepared(['native-singleton-sql-admission'])","prepared(['native-singleton-sql-admission','native-sql-registration-release'])");
  const registrationURL=new URL('./native-owned-mod-registration.test.mjs',import.meta.url);
  let registration=fs.readFileSync(registrationURL,'utf8');
  registration=registration.replace("'./native-singleton-sql-admission.test.mjs'",JSON.stringify(moduleSource(singleton,singletonURL)));
  const registrationModule=moduleSource(registration,registrationURL);
  const url=new URL('./native-main-executor-continuation.test.mjs',import.meta.url);
  let text=fs.readFileSync(url,'utf8');
  const replace=(a,b)=>{assert.equal(text.split(a).length,2,a);text=text.replace(a,b);};
  replace("'native-main-executor-pending','native-main-executor-transport','native-main-executor-continuation'];", "'native-main-executor-pending','native-main-executor-transport','native-main-executor-continuation','native-main-executor-completion'];");
  replace('reserveNativeExecutorTransport,prepareNativeExecutorTransportPending,copyNativeExecutorTransport,registerNativeExecutorTransportCopied})', 'reserveNativeExecutorTransport,prepareNativeExecutorTransportPending,copyNativeExecutorTransport,registerNativeExecutorTransportCopied,closeNativeExecutorTransportWorker,sealNativeExecutorTransportTerminal,releaseNativeExecutorTransport,getNativeExecutorTransportMainRelease})');
  replace('local-state/native-coordinator/recovery/cases', 'local-state/native-completion/root/main-cases');
  replace('base.backend.runAndReadAll=async(sql,params)=>{','base.backend.runAndReadAll=async(sql,params=[])=>{');
  const originalRegistrationURL=new URL('./native-owned-mod-registration.test.mjs',url).href;
  const ownedInsert="else if(sql.startsWith('INSERT INTO')){assert.ok(transaction);for(let n=0;n<params.length;n+=2)transaction.set(params[n],params[n+1]);}";
  const ordinaryInsert="else if(sql.startsWith('INSERT INTO')){const target=transaction??committed;for(let n=0;n<params.length;n+=2)target.set(params[n],params[n+1]);}";
  replace("const module=await import('data:text/javascript;base64,'+Buffer.from(text).toString('base64'));",
    'assert.equal(text.split('+JSON.stringify(originalRegistrationURL)+').length,2);text=text.replace('+JSON.stringify(originalRegistrationURL)+','+JSON.stringify(registrationModule)+');'+
    'assert.equal(text.split('+JSON.stringify(ownedInsert)+').length,2);text=text.replace('+JSON.stringify(ownedInsert)+','+JSON.stringify(ordinaryInsert)+');'+
    "const module=await import('data:text/javascript;base64,'+Buffer.from(text).toString('base64'));");
  replace('const status=()=>({', 'const status=()=>options.statusValue({');
  replace("release(){assert.fail('No worker release');}", 'async release(){calls.push("release");return options.closeRelay(context);}');
  factoryPromise=import(moduleSource(text,url));return factoryPromise;
}
function terminal(binding,closed=false){
  return{schema:'child-terminal-observation/1',binding:{...binding},spawnObserved:true,exitObserved:closed,closeObserved:closed,
    childErrorObserved:false,childErrorCode:null,exitCode:closed?0:null,exitSignal:null,closeCode:closed?0:null,closeSignal:null,
    pipes:Object.fromEntries(['stdin','stdout','stderr'].map(k=>[k,{closeObserved:closed,errorObserved:false,errorCode:null}])),
    childResourcesClosed:closed,held:false,reasonCode:null,outcome:closed?'exited':'pending',exitSucceeded:closed,
    nativeInstallAccepted:false,persistenceVerified:false,descendantsVerified:false};
}
/** Actual Main/Level/Registry, SDK journal and parsers. SQL and both physical
 * process observations are explicit facades; renderer acknowledgements are
 * fixture data. Fixed IPC producer authentication is a separate composition. */
export async function createMainCompletionFixture(t,options={}){
  const{createContinuationFixture}=await factory();let closed=false,releaseStarted=false,nodeTerminal,workerTerminal;
  const f=await createContinuationFixture(t,{...options,
    statusValue(raw){
      nodeTerminal??=terminal(raw.binding);
      if(!workerTerminal){workerTerminal=raw.sdk.workerTerminal;Object.assign(workerTerminal,terminal(raw.binding));}
      const sdk=raw.sdk;
      Object.assign(sdk,{schema:'owned-zip-coordinator-status/1',binding:{...raw.binding},workerPid:4321,creationTime:'12345',startAttempted:true,startSent:true,
        handoffAttempted:true,cancelAttempted:false,releaseAttempted:releaseStarted,childClosed:closed,childExitCode:closed?0:null,childSignal:null,
        worker:null,errorCode:null,stderrObserved:false,effectsAllowed:false,nativeInstallAccepted:false,powerLossPersistenceVerified:false});
      if(sdk.copyProof&&!sdk.copyProof.identity)sdk.copyProof.identity={schema:'win-file-id128/1',volumeSerialNumber:'1',fileId:'8'};
      if(closed)sdk.phase='released';
      const value={...raw,relayTerminal:nodeTerminal,releaseAttempted:releaseStarted,controllerEnded:closed,phase:closed?'released':raw.phase};
      options.statusValue?.(value);return value;
    },
    async closeRelay(context){
      releaseStarted=true;await options.close?.(context);
      closed=true;Object.assign(workerTerminal,terminal(context.binding,true));Object.assign(nodeTerminal,terminal(context.binding,true));
      const value=context.status();return options.closedStatus?.(value)??value;
    }});
  assert.equal(typeof f.Singleton.prototype.prepareNativeSQLRelease,'function');
  assert.equal(typeof f.Registry.prototype.prepareNativeQueryRelease,'function');
  let observed,adoption;
  return{...f,
    async registered(){const ticket=await f.prepare();await f.copy(ticket);observed=await f.register(ticket);
      adoption={schema:'native-executor-renderer-adoption/1',transportId:'transport_'+'1'.repeat(32),operationId:observed.operationId,
        nativeJobId:observed.nativeJobId,requestSHA256:observed.requestSHA256,recordSHA256:observed.recordSHA256,fullRecordSHA256:observed.fullRecordSHA256,effectsAllowed:false,installationPermit:false};
      return ticket;},
    observed:()=>observed,adoption:()=>adoption,
    close:(ticket,bytes=Buffer.from(JSON.stringify(adoption)))=>f.wiring.closeNativeExecutorTransportWorker(ticket,bytes),
    seal:(ticket,bytes=Buffer.from(JSON.stringify(adoption)))=>f.wiring.sealNativeExecutorTransportTerminal(ticket,bytes),
    release:ticket=>f.wiring.releaseNativeExecutorTransport(ticket),
    knownRelease:ticket=>f.wiring.getNativeExecutorTransportMainRelease(ticket),
    census(){const anchor=JSON.parse(f.committed.get('nativeExecutorAnchorV1'));return createNativeExecutorJournal({root:f.root}).inventory({expectedRootId:anchor.rootId,expectedInventorySHA256:anchor.inventorySHA256});}};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  integration('actual Main closes both facade processes, seals B to C and releases only after independent readback',async t=>{
    const f=await createMainCompletionFixture(t),ticket=await f.registered(),before=f.committed.get('nativeExecutorAnchorV1');
    assert.equal(f.knownRelease(ticket),null);assert.equal(f.census().unresolvedCount,1);
    const closure=await f.close(ticket);assert.equal(closure.schema,'native-executor-worker-closed/1');assert.equal(f.census().unresolvedCount,1);
    const transition=await f.seal(ticket);assert.equal(transition.schema,'native-executor-terminal-transition/1');assert.notEqual(f.committed.get('nativeExecutorAnchorV1'),before);
    const census=f.census();assert.equal(census.historySealVerified,true);assert.equal(census.startupHoldRequired,false);assert.equal(census.closedCount,1);
    assert.equal(f.main.getNativeModPersistenceReservation().phase,'reserved');
    const released=f.release(ticket);assert.equal(released.released,true);assert.equal(Object.keys(released).length,12);assert.deepEqual(f.knownRelease(ticket),released);
    assert.equal(f.main.getNativeModPersistenceReservation().phase,'not_reserved');f.wiring.checkNativeExecutorTransport(ticket);
    assert.equal(f.level.getNativeBackendWriteStatus().phase,'not_reserved');assert.equal(f.pool.getNativeSQLConnectionStatus().phase,'not_reserved');
    assert.equal(f.relayCalls.filter(c=>c==='release').length,1);assert(f.committed.has('persistent###mods###cyberpunk2077###own###id'));
    const disk=JSON.parse(fs.readFileSync(path.join(f.root,'terminals',f.request.operationId,'terminal.json')));
    assert.equal(disk.schema,'native-executor-terminal/2');assert.equal(disk.fullRecordSHA256,f.observed().fullRecordSHA256);
    assert.equal(transition.evidenceSHA256,disk.evidenceSHA256);assert.equal(disk.adoptionObservationSHA256,sha(Buffer.from(JSON.stringify(f.adoption()))));
  });
  integration('close, seal and release refuse out-of-order calls without opening writer barriers',async t=>{
    for(const stage of ['close','seal','release']){
      const f=await createMainCompletionFixture(t),ticket=stage==='close'?await f.prepare():await f.registered();
      if(stage==='close')await assert.rejects(f.close(ticket,Buffer.from('{}')));
      else if(stage==='seal')await assert.rejects(f.seal(ticket));else assert.throws(()=>f.release(ticket));
      assert.equal(f.relayCalls.filter(c=>c==='release').length,0);assert.equal(f.main.getNativeModPersistenceReservation().phase,'held');
      assert.equal(fs.existsSync(path.join(f.root,'terminals')),false);assert.equal(f.knownRelease(ticket),null);
    }
  });
  integration('wrong adoption binding and malformed bytes never invoke worker release',async t=>{
    for(const mutation of [a=>a.nativeJobId='exec_'+'f'.repeat(32),a=>a.fullRecordSHA256='f'.repeat(64),a=>a.extra=true]){
      const f=await createMainCompletionFixture(t),ticket=await f.registered(),a={...f.adoption()};mutation(a);
      await assert.rejects(f.close(ticket,Buffer.from(JSON.stringify(a))));assert.equal(f.relayCalls.filter(c=>c==='release').length,0);
      assert.equal(f.main.getNativeModPersistenceReservation().phase,'held');assert.equal(fs.existsSync(path.join(f.root,'terminals')),false);
    }
  });
  integration('foreign tickets refuse inertly while an actual close remains available',async t=>{
    const f=await createMainCompletionFixture(t),ticket=await f.registered();
    for(const foreign of [{},Object.freeze({}),null]){await assert.rejects(f.close(foreign));await assert.rejects(f.seal(foreign));assert.throws(()=>f.release(foreign));assert.throws(()=>f.knownRelease(foreign));}
    await f.close(ticket);assert.equal(f.main.getNativeModPersistenceReservation().phase,'reserved');assert.equal(f.relayCalls.filter(c=>c==='release').length,1);
  });
  integration('incomplete pipes, unsuccessful exit and changed native identities refuse terminal publication',async t=>{
    for(const mutation of [s=>s.relayTerminal.pipes.stderr.closeObserved=false,s=>s.sdk.workerTerminal.closeObserved=false,
      s=>s.relayTerminal.exitCode=1,s=>s.sdk.workerLifetime='worker_'+'f'.repeat(32),s=>s.sdk.childClosed=false,s=>s.relayPid++]){
      const f=await createMainCompletionFixture(t,{closedStatus:s=>{mutation(s);return s;}}),ticket=await f.registered();
      await assert.rejects(f.close(ticket));assert.equal(fs.existsSync(path.join(f.root,'terminals')),false);
      assert.equal(f.main.getNativeModPersistenceReservation().phase,'held');await assert.rejects(f.seal(ticket));assert.equal(f.knownRelease(ticket),null);
    }
  });
  integration('worker release preserves primary Error, null and undefined without retry or terminal append',async t=>{
    for(const primary of [Error('owned closure failure'),null,undefined]){
      const f=await createMainCompletionFixture(t,{close:()=>{throw primary;}}),ticket=await f.registered();
      await f.close(ticket).then(()=>assert.fail('unexpected close'),error=>assert.equal(error,primary));await assert.rejects(f.close(ticket));await assert.rejects(f.seal(ticket));
      assert.equal(f.relayCalls.filter(c=>c==='release').length,1);assert.equal(fs.existsSync(path.join(f.root,'terminals')),false);
      assert.equal(f.main.getNativeModPersistenceReservation().phase,'held');assert.equal(f.knownRelease(ticket),null);
    }
  });
  integration('duplicate close and frame loss observe late actual closure without restoring a held operation',async t=>{
    for(const mode of ['duplicate','frame']){
      const gate=deferred(),f=await createMainCompletionFixture(t,{close:()=>gate.promise}),ticket=await f.registered(),pending=f.close(ticket);void pending.catch(()=>{});await tick();
      if(mode==='duplicate')await assert.rejects(f.close(ticket));else f.frame.owner.rendererPID++;
      gate.resolve();await assert.rejects(pending);assert.equal(f.relayCalls.filter(c=>c==='release').length,1);
      assert.equal(f.main.getNativeModPersistenceReservation().phase,'held');assert.equal(fs.existsSync(path.join(f.root,'terminals')),false);
    }
  });
  integration('closed evidence drift or changed predecessor refuses sealing before Main anchor publication',async t=>{
    for(const mode of ['closed','anchor','adoption']){
      const f=await createMainCompletionFixture(t),ticket=await f.registered();await f.close(ticket);const previous=f.committed.get('nativeExecutorAnchorV1');
      let bytes;
      if(mode==='closed')f.context().sdk.workerTerminal.exitCode=3;
      else if(mode==='anchor'){const a=JSON.parse(previous);f.committed.set('nativeExecutorAnchorV1',JSON.stringify({...a,inventorySHA256:'f'.repeat(64)}));}
      else bytes=Buffer.from(JSON.stringify({...f.adoption(),transportId:'transport_'+'f'.repeat(32)}));
      await assert.rejects(f.seal(ticket,bytes));assert.equal(fs.existsSync(path.join(f.root,'terminals')),false);
      assert.equal(f.main.getNativeModPersistenceReservation().phase,'held');assert.equal(f.knownRelease(ticket),null);
    }
  });
  integration('lost terminal COMMIT acknowledgement preserves actual C and holds every owner without release',async t=>{
    let commits=0;const primary=Error('owned lost terminal COMMIT reply');
    const f=await createMainCompletionFixture(t,{afterRun:sql=>{if(sql==='COMMIT'&&++commits===4)throw primary;}}),ticket=await f.registered();await f.close(ticket);
    const before=f.committed.get('nativeExecutorAnchorV1');await assert.rejects(f.seal(ticket),error=>error===primary);
    assert.equal(commits,4);assert.notEqual(f.committed.get('nativeExecutorAnchorV1'),before);assert.equal(f.census().closedCount,1);
    assert.equal(f.main.getNativeModPersistenceReservation().phase,'held');assert.equal(f.knownRelease(ticket),null);assert.throws(()=>f.release(ticket));
    assert.equal(f.calls.some(c=>c.sql==='ROLLBACK'),false);await assert.rejects(f.seal(ticket));assert.equal(commits,4);
  });
  integration('a failed separate post-CAS readback cannot release Main even when actual C is present',async t=>{
    let armed=false,reads=0;const primary=Error('owned lost terminal readback');
    const f=await createMainCompletionFixture(t,{beforeRead:sql=>{if(armed&&sql.includes('AS exact_key')&&++reads===4)throw primary;}}),ticket=await f.registered();await f.close(ticket);armed=true;
    await assert.rejects(f.seal(ticket),error=>error===primary);assert.equal(reads,4);assert.equal(f.census().closedCount,1);
    assert.equal(f.main.getNativeModPersistenceReservation().phase,'held');assert.equal(f.knownRelease(ticket),null);assert.throws(()=>f.release(ticket));
  });
  integration('known Main ACK survives later frame invalidation without pretending owners were re-locked',async t=>{
    const f=await createMainCompletionFixture(t),ticket=await f.registered();await f.close(ticket);await f.seal(ticket);const ack=f.release(ticket);
    f.frame.owner.rendererPID++;assert.throws(()=>f.wiring.checkNativeExecutorTransport(ticket));
    assert.deepEqual(f.knownRelease(ticket),ack);assert.equal(f.main.getNativeModPersistenceReservation().phase,'not_reserved');
    assert.equal(f.level.getNativeBackendWriteStatus().phase,'not_reserved');assert.equal(f.pool.getNativeSQLConnectionStatus().phase,'not_reserved');
    assert.throws(()=>f.release(ticket));assert.deepEqual(f.knownRelease(ticket),ack);assert.equal(f.relayCalls.filter(c=>c==='release').length,1);
  });
  integration('closed destination and retained proof metadata cannot change from the copied evidence',async t=>{
    for(const mutation of [s=>s.sdk.destination.leaf='other',s=>s.sdk.copyProof.sha256='f'.repeat(64)]){
      const f=await createMainCompletionFixture(t,{closedStatus:s=>{mutation(s);return s;}}),ticket=await f.registered();
      await assert.rejects(f.close(ticket));assert.equal(fs.existsSync(path.join(f.root,'terminals')),false);
      assert.equal(f.main.getNativeModPersistenceReservation().phase,'held');assert.equal(f.knownRelease(ticket),null);
    }
  });
  integration('pre-close proof metadata must still describe the actual retained canonical proof',async t=>{
    const f=await createMainCompletionFixture(t),ticket=await f.registered();f.context().sdk.copyProof.sha256='f'.repeat(64);
    await assert.rejects(f.close(ticket));assert.equal(f.relayCalls.filter(c=>c==='release').length,0);
    assert.equal(f.main.getNativeModPersistenceReservation().phase,'held');assert.equal(fs.existsSync(path.join(f.root,'terminals')),false);
  });
}
