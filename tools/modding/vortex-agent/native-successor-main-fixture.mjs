// Actual-graph source fixture. Importing this module starts no actor or process.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {once,nextRequest,seedSecondDownload,secondArchiveRows,
  adaptTransportText,adaptContinuationText,conflictRows} from './native-successor-fixture-inputs.mjs';

function moduleSource(text,url){
  text=text.replace(/(from\s*['"])(\.\/[^'"]+)(['"])/g,(_a,b,c,d)=>b+new URL(c,url).href+d);
  text=text.replaceAll("'import.meta.url'","'__SUCCESSOR_OUTER_META_LITERAL__'")
    .replaceAll('import.meta.url',JSON.stringify(url.href))
    .replaceAll('__SUCCESSOR_OUTER_META_LITERAL__','import.meta.url');
  return 'data:text/javascript;base64,'+Buffer.from(text).toString('base64');
}

/** Replace ONLY physical-process observations in the completion fixture.
 * A new SDK object gets new facts; old SDK facts remain terminal forever. */
export function adaptCompletionText(text){
  const start=text.indexOf('  const{createContinuationFixture}=await factory();let closed=false,releaseStarted=false,nodeTerminal,workerTerminal;');
  const end=text.indexOf("  assert.equal(typeof f.Singleton.prototype.prepareNativeSQLRelease",start);
  assert(start>=0&&end>start,'exact completion physical facade bounds');
  const replacement=`  const{createContinuationFixture}=await factory();const lives=new WeakMap();
  const lifeFor=(sdk,binding)=>{let life=lives.get(sdk);if(!life){
    life={closed:false,releaseStarted:false,nodeTerminal:terminal(binding),workerTerminal:sdk.workerTerminal};
    Object.assign(life.workerTerminal,terminal(binding));lives.set(sdk,life);}return life;};
  const f=await createContinuationFixture(t,{...options,
    statusValue(raw){
      const life=lifeFor(raw.sdk,raw.binding),sdk=raw.sdk;
      Object.assign(sdk,{schema:'owned-zip-coordinator-status/1',binding:{...raw.binding},workerPid:4321,creationTime:'12345',startAttempted:true,startSent:true,
        handoffAttempted:true,cancelAttempted:false,releaseAttempted:life.releaseStarted,childClosed:life.closed,childExitCode:life.closed?0:null,childSignal:null,
        worker:null,errorCode:null,stderrObserved:false,effectsAllowed:false,nativeInstallAccepted:false,powerLossPersistenceVerified:false});
      if(sdk.copyProof&&!sdk.copyProof.identity)sdk.copyProof.identity={schema:'win-file-id128/1',volumeSerialNumber:'1',fileId:'8'};
      if(life.closed)sdk.phase='released';
      const value={...raw,relayTerminal:life.nodeTerminal,releaseAttempted:life.releaseStarted,controllerEnded:life.closed,phase:life.closed?'released':raw.phase};
      options.statusValue?.(value);return value;
    },
    async closeRelay(context){
      const life=lifeFor(context.sdk,context.binding);life.releaseStarted=true;await options.close?.(context);
      life.closed=true;Object.assign(life.workerTerminal,terminal(context.binding,true));Object.assign(life.nodeTerminal,terminal(context.binding,true));
      const value=context.status();return options.closedStatus?.(value)??value;
    }});
`;
  text=text.slice(0,start)+replacement+text.slice(end);
  // The completion factory reads the continuation wrapper once. Adapt that
  // wrapper before its existing exact source/parent-chain intake runs.
  const call='(function(text){const once='+once.toString()+';const conflictRows='
    +conflictRows.toString()+';return ('+adaptContinuationText.toString()+')(text);})(text)';
  return once(text,"  let text=fs.readFileSync(url,'utf8');",
    "  let text=fs.readFileSync(url,'utf8');\n  text="+call+';');
}

/** Compose the fixed published successor stage, not a supplied source overlay. */
async function capsuleFactory(){
  const url=new URL('./native-main-sdk-capsule.test.mjs',import.meta.url);
  let text=fs.readFileSync(url,'utf8');
  // Functions serialized into the owned copied fixture retain only pure source
  // adapters. Its existing assert/fs/path bindings supply all dependencies.
  const transportCall='(function(text){const once='+once.toString()+';return ('
    +adaptTransportText.toString()+')(text);})(text)';
  const completionCall='(function(text){const once='+once.toString()+';const conflictRows='
    +conflictRows.toString()+';const adaptContinuationText='+adaptContinuationText.toString()
    +';return ('+adaptCompletionText.toString()+')(text);})(text)';
  text=once(text,"function adaptTransportFixture(text) {",
    'function adaptTransportFixture(text) {\n  text='+transportCall+';');
  text=once(text,"  fixtureModule=import(moduleSource(text,url));return fixtureModule;",
    '  text='+completionCall+';\n  fixtureModule=import(moduleSource(text,url));return fixtureModule;');
  text=once(text,"'local-state/native-capsule-main/prep/cases'","'local-state/native-successor-fixtures/cases'");
  return import(moduleSource(text,url));
}

/** Call ONCE per source-only composed scenario; use nextInputs for job2.
 * Retains actual Main/Level/Registry/capsule; SQL/process observations are facades. */
export async function createTwoOperationMainFixture(t,options={}){
  const{mainPatchNames=['native-main-executor-successor'],mainExports=['prepareNativeExecutorSuccessor'],second={},...rest}=options;
  // Accept only the fixed stage/export, including explicit old fixture callers.
  assert.deepEqual(mainPatchNames,['native-main-executor-successor']);
  assert.deepEqual(mainExports,['prepareNativeExecutorSuccessor']);
  const make=(await capsuleFactory()).createMainSDKCapsuleFixture;
  const f=await make(t,{absentSDK:true,...rest,async seed(args){
    seedSecondDownload(args.committed,'cyberpunk2077',second);await rest.seed?.(args);
  }});
  const retained={main:f.main,level:f.level,pool:f.pool,Registry:f.Registry,Main:f.Main,
    committed:f.committed,mainOwner:f.mainOwner,modules:f.capsule.modules()};
  return {...f,nextInputs:()=>nextRequest(f.requestBytes,f.archiveBytes,second),
    secondArchiveRows:secondArchiveRows('cyberpunk2077',second),
    assertSameLifetime(){
      for(const[key,value]of Object.entries(retained))
        assert.equal(key==='modules'?f.capsule.modules():f[key],value,key);
      assert.equal(f.capsule.loads(),1);assert.equal(fs.existsSync(f.sdk),false);
    }};
}

export {secondArchiveRows,nextRequest,seedSecondDownload} from './native-successor-fixture-inputs.mjs';
