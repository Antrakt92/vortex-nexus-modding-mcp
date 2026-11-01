// Source-backed fixture only. Import constructs no actors or processes.
// Actual Main/Level/Registry/capsule/journal/CAS; SQL/frame/process facts are facades.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {stage} from './native-query-source-admission.test.mjs';
import {applyExact} from './native-patch-test-fixture.mjs';
import {createNativeExecutorJournal} from './native-executor-journal.mjs';
const PUBLIC=new URL('./',import.meta.url),sha=b=>createHash('sha256').update(b).digest('hex');
const FIXED=Object.freeze({
  "native-backend-unregistered-release": {
    "upstreamPath": "src/main/src/store/LevelPersist.ts",
    "inputSHA256": "ebd5f18a2f599c89733854e2bb7069000118165cc3b0d0ddebe750f2ce329a5a",
    "outputSHA256": "11ca91f241329d33332a083c7538449c8cd5181aaa04247993646c1488a6662a",
    "patchSHA256": "1332d28662aece843048cb29e6e9651255ce83c6b3276c02e93d1f79f4f64223",
    "prerequisitePatch": "native-backend-executor-terminal-window.patch",
    "prerequisitePatchSHA256": "ddfa2d0ca7e06f5573d2ad00e28ab6368d52d96421cab24b382a7a192aaf61a7"
  },
  "native-main-unregistered-release": {
    "upstreamPath": "src/main/src/store/ReduxPersistorIPC.ts",
    "inputSHA256": "0079084dee06bed5b96b560fe576f4e0b8734ab3363fa6c9e89af8c7adff2b5d",
    "outputSHA256": "1acf238012cbb57f1f457fb12a9eb04c293a2dedf643d9b70c7bd633e95abf93",
    "patchSHA256": "1683e2361021962f479d5a085b965a9c2770d1955bc98ae22b8ce1b872cabbbf",
    "prerequisitePatch": "native-main-executor-terminal-window.patch",
    "prerequisitePatchSHA256": "93466fb7d9eda396ed8e9fd4d873c7ab6735b982f57ca1a894eb4d73b4eaa343"
  },
  "native-main-executor-cancellation": {
    "upstreamPath": "src/main/src/store/mainPersistence.ts",
    "inputSHA256": "c87e07044cd05be1f9d6cce68355234d623ec68ed6c5e18865eb6dc44fb0b8c6",
    "outputSHA256": "8b63710b57bde4e09c97add7ae1bc4ab81efb74c6f9d046df646213ae6882adb",
    "patchSHA256": "871aafeb7500de3c1c76a855a40dcfcd1357d1b52e412802aa3c57f7d23bd623",
    "prerequisitePatch": "native-main-executor-successor.patch",
    "prerequisitePatchSHA256": "f696fce270e32a2b6aab68244d9e9de5aeff03071e886bf05533bd70f6d29db2"
  }
});
/** Fixed three-stage TEST intake, never a caller-selected production source. */
export function applyCancellationStage(source,name){
 assert(Object.hasOwn(FIXED,name),'fixed cancellation test stage');const expected=FIXED[name],{m,patch}=stage(name);
 for(const[k,v]of Object.entries(expected))assert.equal(m[k],v,name+':'+k);
 assert.equal(sha(source),expected.inputSHA256);assert.equal(sha(patch),expected.patchSHA256);
 const parent=stage(expected.prerequisitePatch.slice(0,-6)).m;assert.equal(parent.patchSHA256,expected.prerequisitePatchSHA256);
 assert.equal(parent.outputSHA256,expected.inputSHA256);
 const output=applyExact(source,patch,expected.upstreamPath);assert.equal(sha(output),expected.outputSHA256);return output;
}
function once(text,a,b){assert.equal(text.split(a).length,2,a);return text.replace(a,b);}
function moduleSource(text,url){
 text=text.replace(/(from\s*['"])(\.\/[^'"]+)(['"])/g,(_a,b,c,d)=>b+new URL(c,url).href+d);
 text=text.replaceAll("'import.meta.url'","'__CANCELLATION_OUTER_META_LITERAL__'")
  .replaceAll('import.meta.url',JSON.stringify(url.href)).replaceAll('__CANCELLATION_OUTER_META_LITERAL__','import.meta.url');
 return 'data:text/javascript;base64,'+Buffer.from(text).toString('base64');
}
const INERT_LOAD=String.raw`// TEST ONLY. Replaces only physical relay/process creation AND its observer;
// the actual compiled capsule is validated first. This is not SDK brand proof.
  load(file,actual){
    const module=actual(file);if(!file.endsWith('owned-zip-relay-client.mjs'))return module;
    let owned;
    const frozen=v=>{if(v&&typeof v==='object'){for(const d of Object.values(Object.getOwnPropertyDescriptors(v)))if(Object.hasOwn(d,'value'))frozen(d.value);Object.freeze(v);}return v;};
    const term=(binding,closed)=>({schema:'child-terminal-observation/1',binding:{...binding},spawnObserved:true,exitObserved:closed,closeObserved:closed,
      childErrorObserved:false,childErrorCode:null,exitCode:closed?0:null,exitSignal:null,closeCode:closed?0:null,closeSignal:null,
      pipes:Object.fromEntries(['stdin','stdout','stderr'].map(k=>[k,{closeObserved:closed,errorObserved:false,errorCode:null}])),
      childResourcesClosed:closed,held:false,reasonCode:null,outcome:closed?'exited':'pending',exitSucceeded:closed,
      nativeInstallAccepted:false,persistenceVerified:false,descendantsVerified:false});
    return {...module,
      observeRelayInertCancellation(owner){
        assert.equal(owner,owned,'only exact fixture relay owner');calls.push('observer');
        const x=context;if(!x.cancelled||!x.released||x.started)throw Error('MODEL_INERT_UNPROVEN');
        const observation={schema:'owned-zip-relay-inert-cancellation/1',binding:{...x.binding},preparedReceiptSHA256:sha(Buffer.from(JSON.stringify(receipt))),
          relayLifetime:x.relayLifetime,relayPid:4320,workerLifetime:x.sdk.workerLifetime,workerPid:4321,creationTime:'12345',packetSHA256:x.sdk.packetSHA256,
          cancelledBeforeStart:true,explicitStartAttempted:false,pythonStartSent:false,destinationAcquired:false,
          relayTerminal:term(x.binding,true),workerTerminal:term(x.binding,true),effectsAllowed:false,installationPermit:false,nativeAdmission:false,
          nativeInstallAccepted:false,powerLossPersistenceVerified:false};
        const result=options.inertObservation?options.inertObservation(observation,x):observation;return frozen(result);
      },
      createBoundOwnedZipRelay(rb,ab,runtime){
        const state={phase:'prepared'};lastState=state;
        const request=dispatch.parseDispatchRequest(rb),binding={operationId:request.operationId,nativeJobId:request.nativeJobId,
          requestSHA256:dispatch.dispatchRequestDigest(rb),rendererGeneration:request.rendererGeneration};
        const root=path.join(JSON.parse(runtime).workspaceRoot,'local-state/vortex-agent-build/native-install-executor');
        const sdk={schema:'owned-zip-coordinator-status/1',binding:{...binding},phase:'ready',workerPid:4321,creationTime:'12345',
          workerLifetime:'worker_'+request.nativeJobId.slice(5),packetSHA256:sha(Buffer.from(rb)),destination:{parent:request.plan.context.stagingPath,
            leaf:request.plan.package.expectedModId,parentIdentity:{schema:'win-file-id128/1',volumeSerialNumber:'1',fileId:'4'},directoryIdentity:null},
          workerTerminal:term(binding,false),copyProof:null,startAttempted:true,startSent:false,handoffAttempted:false,cancelAttempted:false,
          releaseAttempted:false,childClosed:false,childExitCode:null,childSignal:null,worker:null,errorCode:null,stderrObserved:false,
          effectsAllowed:false,nativeInstallAccepted:false,powerLossPersistenceVerified:false};
        const x={request,binding,sdk,started:false,cancelled:false,released:false,relayLifetime:'relay_'+request.operationId.slice(3)};
        const status=()=>({schema:'owned-zip-relay-owner-status/1',binding,mode:'staging',relayLifetime:x.relayLifetime,relayPid:4320,startSHA256:sha(Buffer.from(ab)),
          startAttempted:true,startSent:true,cancelAttempted:x.cancelled,handoffAttempted:false,releaseAttempted:x.released,controllerEnded:x.released,
          phase:x.released?'released':state.phase,relayTerminal:term(binding,x.released),sdk,errorCode:null,stderrObserved:false,
          effectsAllowed:false,nativeInstallAccepted:false,persistenceVerified:false});
        context=Object.assign(x,{status});
        owned=Object.freeze({
          async prepare(anchor){const journal=actual(path.join(path.dirname(file),'native-executor-journal.mjs')).createNativeExecutorJournal({root}),
            pending=journal.reservePending(rb,sdk.workerLifetime,sdk.packetSHA256,anchor);
            receipt={schema:'owned-zip-worker-prepared/1',binding,workerLifetime:sdk.workerLifetime,workerPid:4321,creationTime:'12345',packetSHA256:sdk.packetSHA256,transition:pending.transition};return receipt;},
          async startPrepared(){calls.push('start');x.started=true;await options.inertStart?.(x);throw Error('MODEL_START_STOP');},
          async waitFor(){assert.fail('cancel fixture never extracts');},async handoff(){assert.fail('cancel fixture never hands off');},
          async copyProof(){assert.fail('cancel fixture never produces copy proof');},
          status(){options.inertStatus?.(x);return status();},
          async cancel(){calls.push('cancel');await options.inertCancel?.(x);x.cancelled=true;sdk.phase='cancelled';sdk.cancelAttempted=true;sdk.childClosed=true;
            sdk.childExitCode=0;sdk.workerTerminal=term(binding,true);state.phase='cancelled';return status();},
          async release(){calls.push('release');await options.inertRelease?.(x);assert.equal(x.cancelled,true);x.released=true;state.phase='released';return status();}
        });return owned;
      }
    };
  }
`;
const factories=new Map();
async function load(mode){
 if(factories.has(mode))return factories.get(mode);
 const inputsURL=new URL('native-successor-fixture-inputs.mjs',PUBLIC);let inputs=fs.readFileSync(inputsURL,'utf8');
 inputs=once(inputs,'  return text;\n}\n/** Continuation',"  text=\"import {applyCancellationStage} from './native-cancellation-main-fixture.mjs';\\n\"+text;\n  text=once(text,\"const types=execute(prepared(levelStages),\",\"const types=execute((()=>{options.beforeLevelClass?.(base);return applyCancellationStage(prepared(levelStages),'native-backend-unregistered-release');})(),\");\n  text=once(text,\"const Main=execute(prepared(mainStages),\",\"const Main=execute((()=>{options.beforeMainClass?.(types);return applyCancellationStage(prepared(mainStages),'native-main-unregistered-release');})(),\");\n  text=once(text,\"const wiring=execute(prepared([...stages,...[\\\"native-main-executor-successor\\\"]]),\",\"const wiring=execute(applyCancellationStage(prepared([...stages,...[\\\"native-main-executor-successor\\\"]]),'native-main-executor-cancellation'),\");\n  text=once(text,\"`({prepareNativeExecutorSuccessor,verifyNativeExecutorStartup,\",\"`({prepareNativeExecutorCancellationSuccessor,cancelNativeExecutorTransportPrepared,sealNativeExecutorTransportCancellation,releaseNativeExecutorTransportCancellation,getNativeExecutorTransportCancellationRelease,prepareNativeExecutorSuccessor,verifyNativeExecutorStartup,\");\n"+'  return text;\n}\n/** Continuation');
 inputs=once(inputs,'  const predicate = conflictRows.toString();',"  text=once(text,\"   if(sql.includes('AS exact_key'))\",\"   if(sql==='SELECT value FROM db.kv WHERE key = $1'){assert.equal(params.length,1);rows=data.has(params[0])?[[data.get(params[0])]]:[];}\\n   else if(sql.includes('AS exact_key'))\");\n"+'  const predicate = conflictRows.toString();');
 const helperURL=new URL('native-successor-main-fixture.mjs',PUBLIC);let helper=fs.readFileSync(helperURL,'utf8');
 if(mode==='inert'){
  const marker=inputs.lastIndexOf('  return text;\n}');assert(marker>=0);
  const swap="  const a=text.indexOf('  load(file,actual){'),b=text.indexOf('\\n return{...f,relayCalls',a);assert(a>=0&&b>a);\n";
  inputs=inputs.slice(0,marker)+swap+'  text=text.slice(0,a)+'+JSON.stringify(INERT_LOAD+' });\n')+'+text.slice(b);\n'+inputs.slice(marker);
  helper=once(helper,'  text=text.slice(0,start)+replacement+text.slice(end);','  text=text.slice(0,start)+replacement+text.slice(end);\n'+"  text=once(text,\"  replace('const status=()=>({', 'const status=()=>options.statusValue({');\\n\",'');\n  text=once(text,\"  replace(\\\"release(){assert.fail('No worker release');}\\\", 'async release(){calls.push(\\\"release\\\");return options.closeRelay(context);}');\\n\",'');\n");
  helper=once(helper,"  const url=new URL('./native-main-sdk-capsule.test.mjs',import.meta.url);\n  let text=fs.readFileSync(url,'utf8');","  const url=new URL('./native-main-sdk-capsule.test.mjs',import.meta.url);\n  let text=fs.readFileSync(url,'utf8');\n  text=once(text,\"if(key!=='createBoundOwnedZipRelay')\",\"if(key!=='createBoundOwnedZipRelay'&&key!=='observeRelayInertCancellation')\");");
 }
 assert.equal(helper.split("'./native-successor-fixture-inputs.mjs'").length,3);
 helper=helper.replaceAll("'./native-successor-fixture-inputs.mjs'",JSON.stringify(moduleSource(inputs,inputsURL)));
 const factory=import(moduleSource(helper,helperURL));factories.set(mode,factory);return factory;
}
/** TEST ONLY mode: installed retains the published success facade; inert models
 * no-START cancellation and additionally replaces only its observer namespace.
 * Neither mode proves physical process custody or a real SDK WeakMap brand. */
export async function createNativeCancellationMainFixture(t,options={}){
 const{processFacade='inert',...rest}=options;assert(['inert','installed'].includes(processFacade));
 const f=await (await load(processFacade)).createTwoOperationMainFixture(t,rest);
 for(const name of ['cancelNativeExecutorTransportPrepared','sealNativeExecutorTransportCancellation','releaseNativeExecutorTransportCancellation','getNativeExecutorTransportCancellationRelease','prepareNativeExecutorCancellationSuccessor'])assert.equal(typeof f.wiring[name],'function',name);
 return {...f,
  cancel:ticket=>f.wiring.cancelNativeExecutorTransportPrepared(ticket),
  cancelSeal:ticket=>f.wiring.sealNativeExecutorTransportCancellation(ticket),
  cancelRelease:ticket=>f.wiring.releaseNativeExecutorTransportCancellation(ticket),
  cancellationRelease:ticket=>f.wiring.getNativeExecutorTransportCancellationRelease(ticket),
  census(){const a=JSON.parse(f.committed.get('nativeExecutorAnchorV1'));return createNativeExecutorJournal({root:f.root}).inventory({expectedRootId:a.rootId,expectedInventorySHA256:a.inventorySHA256});}
 };
}
export const createMainCancellationFixture=(t,options={})=>createNativeCancellationMainFixture(t,{...options,processFacade:'inert'});
export const createSuccessCompatibilityFixture=(t,options={})=>createNativeCancellationMainFixture(t,{...options,processFacade:'installed'});
