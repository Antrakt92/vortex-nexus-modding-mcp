// Source-only composition: actual Main/Level/Registry and validated capsule journal.
// SQL, frame and both physical-process observations remain explicit facades.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {captureNativeSDKSources, NATIVE_SDK_SOURCE_NAMES} from './native-sdk-capture.mjs';
import {buildNativeSDKCapsule} from './native-sdk-capsule-build.mjs';
import capsuleLoader from './native-sdk-capsule-load.cjs';

const SOURCE = process.env.VORTEX_CAPSULE_BUILD_SOURCE;
const REPO = process.env.VORTEX_EXTENSION_ADMISSION_REPO;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const integration = (name, body) => test(name, {
  timeout:30000, skip:SOURCE && REPO ? false : 'Set reviewed source and capsule compiler workspace',
},body);
let fixtureModule;
function moduleSource(text,url) {
  text=text.replace(/(from\s*['"])(\.\/[^'"]+)(['"])/g,(_a,b,c,d)=>b+new URL(c,url).href+d);
  text=text.replaceAll("'import.meta.url'","'__CAPSULE_MAIN_OUTER_META_LITERAL__'")
    .replaceAll('import.meta.url',JSON.stringify(url.href)).replaceAll('__CAPSULE_MAIN_OUTER_META_LITERAL__','import.meta.url');
  return 'data:text/javascript;base64,'+Buffer.from(text).toString('base64');
}
// Exact intake adaptation only. The original source-backed test bodies stay untouched.
function adaptTransportFixture(text) {
  const once=(before,after)=>{assert.equal(text.split(before).length,2,before);text=text.replace(before,after);};
  once('  options.seed?.({root,workspace,committed});','  await options.seed?.({root,workspace,committed});');
  once('const module=options.load?options.load(file,actualRequire):actualRequire(file);',
    'const actual=options.capsuleActual??actualRequire;const module=options.load?options.load(file,actual):actual(file);');
  once('  };loader.cache=actualRequire.cache;',
    '  };loader.cache=actualRequire.cache;options.captureFacadeLoader?.(loader);');
  const meta='import'+'.meta.url';
  once('__filename:fileURLToPath('+meta+'),__NEXUS_NATIVE_RUNTIME_BINDING__:binding});',
    '__filename:fileURLToPath('+meta+'),__NEXUS_NATIVE_RUNTIME_BINDING__:binding,'+
    '__NEXUS_NATIVE_CAPSULE__:options.capsuleLiteral(),__NEXUS_NATIVE_CAPSULE_LOAD__:options.capsuleLoad,'+
    '__NEXUS_NATIVE_CAPSULE_LOADER_SHA256__:options.capsuleLoaderSHA()});');
  once('  const startup=await wiring.verifyNativeExecutorStartup(level);',
    '  options.captureWiring?.(wiring);const startup=await wiring.verifyNativeExecutorStartup(level);');
  return text;
}
async function completionFactory() {
  if(fixtureModule)return fixtureModule;
  const url=new URL('./native-main-executor-completion.test.mjs',import.meta.url);
  let text=fs.readFileSync(url,'utf8');
  const once=(before,after)=>{assert.equal(text.split(before).length,2,before);text=text.replace(before,after);};
  // This is the replacement-value string in the original completion composition.
  once("'native-main-executor-continuation','native-main-executor-completion'];",
    "'native-main-executor-continuation','native-main-executor-completion','native-main-sdk-capsule'];");
  once('local-state/native-completion/root/main-cases','local-state/native-capsule-main/prep/cases');
  const needle=" let text=fs.readFileSync(original,'utf8');";
  const injected=needle+'\n text=('+adaptTransportFixture.toString()+')(text);';
  once("  let text=fs.readFileSync(url,'utf8');",
    "  let text=fs.readFileSync(url,'utf8');\n"+
    '  assert.equal(text.split('+JSON.stringify(needle)+').length,2);'+
    'text=text.replace('+JSON.stringify(needle)+','+JSON.stringify(injected)+');'+
    'assert.equal(text.split("options.seed?.(args);").length,2);'+
    'text=text.replace("options.seed?.(args);","return options.seed?.(args);");');
  fixtureModule=import(moduleSource(text,url));return fixtureModule;
}
async function compiler() {
  assert(SOURCE,'Reviewed compiler workspace is required');
  const require=createRequire(path.join(SOURCE,'src/main/package.json'));
  return (await import(pathToFileURL(require.resolve('rolldown')).href)).rolldown;
}

/** Real capsule validation occurs before the sole relay-factory facade is inserted.
 * No production loader seam or worker spawn is used. */
export async function createMainSDKCapsuleFixture(t,options={}) {
  const make=(await completionFactory()).createMainCompletionFixture;
  const compile=await compiler();
  let built,literal,binding,validated,facadeLoader,workspace,retainedSDK,loaderSHA256;
  const events=[];let loadCount=0;let wiring;
  const actual=name=>{
    assert(validated,'No capsule namespace before real artifact validation');
    const leaf=path.basename(name);
    const namespace=Object.getOwnPropertyDescriptor(validated.modules,leaf)?.value;
    assert(namespace,'Unlisted source module requested by controlled relay facade: '+leaf);
    return namespace;
  };
  const f=await make(t,{
    ...options,
    async seed(args) {
      await options.seed?.(args);workspace=args.workspace;
      const sdk=path.join(workspace,'tools/modding/vortex-agent');
      const pins=Object.fromEntries(NATIVE_SDK_SOURCE_NAMES.map(name=>[name,sha(fs.readFileSync(path.join(sdk,name)))]));
      binding={schema:'native-executor-runtime-binding/1',workspaceRoot:workspace.replaceAll('\\','/'),
        relayNodeSHA256:'5c976096e04e5c2c1f091938926234cc9fbebfe9787ddd149351b3b0ecc707b5',sourceSHA256:pins};
      const capture=captureNativeSDKSources(sdk,pins);
      built=await buildNativeSDKCapsule(capture,Buffer.from(JSON.stringify(binding)),compile);
      loaderSHA256=sha(fs.readFileSync(new URL('./native-sdk-capsule-load.cjs',import.meta.url)));
      literal={schema:'native-sdk-capsule-binding/1',artifactBase64:Buffer.from(built.artifact).toString('base64'),
        artifactSHA256:built.sha256,loaderSHA256};
      options.mutateLiteral?.(literal,built,binding);
      if(options.absentSDK){retainedSDK=sdk+'-retained';fs.renameSync(sdk,retainedSDK);}
      events.push('built');
    },
    capsuleLiteral:()=>literal,
    capsuleLoaderSHA:()=>loaderSHA256,
    captureFacadeLoader:loader=>{facadeLoader=loader;},
    captureWiring:value=>{wiring=value;},
    capsuleActual:actual,
    capsuleLoad(bytes,expected,bindingBytes) {
      loadCount++;events.push('load');options.observeCapsuleLoad?.(loadCount);options.beforeLoad?.({wiring,bytes,expected,bindingBytes});
      validated=capsuleLoader.loadNativeSDKCapsule(bytes,expected,bindingBytes);
      options.afterValidate?.(validated);
      const relayPath=path.join(workspace,'tools/modding/vortex-agent/owned-zip-relay-client.mjs');
      assert(facadeLoader,'Source fixture loader must be captured before Main startup');
      const facade=facadeLoader(relayPath);
      // Only physical relay creation is replaced after actual capsule validation.
      const original=validated.modules['owned-zip-relay-client.mjs'];
      for(const key of Object.keys(original))if(key!=='createBoundOwnedZipRelay')
        assert.equal(facade[key],original[key],key);
      return Object.freeze({...validated,modules:Object.freeze({...validated.modules,
        'owned-zip-relay-client.mjs':Object.freeze(facade)})});
    },
  });
  return {...f,capsule:{built,binding,literal,events,loads:()=>loadCount,
    modules:()=>validated.modules,retainedSDK:()=>retainedSDK},
    removeSDK() {
      if(!fs.existsSync(f.sdk))return;
      retainedSDK=f.sdk+'-retained';fs.renameSync(f.sdk,retainedSDK);
    }};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
integration('actual Main initializes and completes from one validated capsule with SDK source tree absent',async t=>{
  const f=await createMainSDKCapsuleFixture(t,{absentSDK:true});
  assert.equal(fs.existsSync(f.sdk),false);assert.equal(f.startup.phase,'uninitialized');
  const ticket=await f.registered();
  assert.equal(f.capsule.loads(),1);assert.equal(f.census().unresolvedCount,1);
  await f.close(ticket);await f.seal(ticket);
  const ack=f.release(ticket);assert.equal(ack.released,true);assert.equal(ack.installationPermit,false);
  assert.equal(f.capsule.loads(),1);assert.equal(f.census().closedCount,1);
  assert.equal(f.main.getNativeModPersistenceReservation().phase,'not_reserved');
  assert.equal(f.level.getNativeBackendWriteStatus().phase,'not_reserved');
  assert.equal(f.pool.getNativeSQLConnectionStatus().phase,'not_reserved');
  assert.equal(f.relayCalls.filter(x=>x==='release').length,1);
});

integration('post-load SDK rename and unrelated code-directory churn do not alter captured source identity',async t=>{
  const f=await createMainSDKCapsuleFixture(t);const ticket=await f.registered();
  f.removeSDK();fs.mkdirSync(f.sdk);
  fs.writeFileSync(path.join(f.sdk,'untrusted-extra.cjs'),'throw Error("never loaded")');
  f.wiring.checkNativeExecutorTransport(ticket);
  await f.close(ticket);await f.seal(ticket);assert.equal(f.release(ticket).released,true);
  assert.equal(f.capsule.loads(),1);
});

integration('physical journal drift still holds Main despite pathless code and prevents release',async t=>{
  const f=await createMainSDKCapsuleFixture(t,{absentSDK:true});const ticket=await f.registered();
  await f.close(ticket);
  fs.writeFileSync(path.join(f.root,'unknown-record.json'),'{}',{flag:'wx'});
  await assert.rejects(f.seal(ticket));assert.throws(()=>f.release(ticket));
  assert.equal(f.main.getNativeModPersistenceReservation().phase,'held');
  assert.equal(f.capsule.loads(),1);assert.equal(f.knownRelease(ticket),null);
});

integration('invalid artifact, digest, binding and loader pins have no physical-source fallback',async t=>{
  for(const [mutation,expectedLoads] of [
    [value=>{value.artifactBase64=Buffer.from('{}').toString('base64');},1],
    [value=>{value.artifactSHA256='f'.repeat(64);},1],
    [value=>{value.loaderSHA256='e'.repeat(64);},0],
    [(value,built)=>{const a=JSON.parse(built.artifact);a.binding.workspaceRoot+='-other';
      const bytes=Buffer.from(JSON.stringify(a));value.artifactBase64=bytes.toString('base64');value.artifactSHA256=sha(bytes);},1],
  ]) {
    let loads=0;
    await assert.rejects(createMainSDKCapsuleFixture(t,{absentSDK:true,mutateLiteral:mutation,
      observeCapsuleLoad:n=>{loads=n;}}),error=>{
      assert.equal(Object.getOwnPropertyDescriptor(error,'message')?.value,'NATIVE_EXECUTOR_STARTUP_HOLD');
      assert(['SOURCE_CLOSURE','SDK_LOAD'].includes(Object.getOwnPropertyDescriptor(error,'reasonCode')?.value));
      return true;
    });
    assert.equal(loads,expectedLoads,'Only the intended loader boundary may fail; no generic fixture bootstrap refusal');
  }
});

integration('literal artifact metadata drift after capsule load refuses before START without reloading',async t=>{
  const f=await createMainSDKCapsuleFixture(t,{absentSDK:true});
  const ticket=await f.prepare();
  assert.equal(f.capsule.loads(),1);assert.equal(f.relayCalls.filter(x=>x==='start').length,0);
  f.capsule.literal.artifactSHA256='f'.repeat(64);
  await assert.rejects(f.copy(ticket));
  assert.equal(f.capsule.loads(),1);assert.equal(f.relayCalls.filter(x=>x==='start').length,0);
  assert.equal(f.knownRelease(ticket),null);
  assert.equal(f.main.getNativeModPersistenceReservation().phase,'held');
});
}
