// Opt-in physical ZIP/copy acceptance in new owned directories, never Vortex/game data.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import childProcess from 'node:child_process';
import {createRequire,syncBuiltinESMExports} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {captureNativeSDKSources} from './native-sdk-capture.mjs';
import {buildNativeSDKCapsule} from './native-sdk-capsule-build.mjs';
import loader from './native-sdk-capsule-load.cjs';
import job from './install-job-contract.cjs';
import dispatch from './native-dispatch-contract.cjs';
const HERE=path.dirname(fileURLToPath(import.meta.url));
const TASK=path.resolve(HERE,'../../../local-state/owned-zip-relay-tests');
const SOURCE=process.env.VORTEX_CAPSULE_BUILD_SOURCE,SDK=process.env.VORTEX_CAPSULE_BUILD_SDK,
  BINDING=process.env.VORTEX_CAPSULE_BUILD_BINDING;
const enabled=process.platform==='win32'&&process.arch==='x64'&&process.env.VORTEX_CAPSULE_NATIVE_TEST==='1'&&SOURCE&&SDK&&BINDING;
const ownTest=(name,body)=>test(name,{skip:enabled?false:'Set reviewed capsule inputs and VORTEX_CAPSULE_NATIVE_TEST=1',timeout:45000},body);
const sha=b=>crypto.createHash('sha256').update(b).digest('hex'),nonce=()=>crypto.randomBytes(16).toString('hex');
const PYTHON='C:/Python314/python.exe',NODE='C:/Program Files/nodejs/node.exe';
const ZIP_FIXTURE=String.raw`import sys,json,pathlib,hashlib,zipfile
r=pathlib.Path(sys.argv[1]);r.mkdir(parents=True,exist_ok=False)
for n in ['archives','model-game','model-stage','runtime']:(r/n).mkdir()
payload={'payload.bin':b'own capsule fixture '*8192,'r6/scripts/fixture.reds':b'// inert fixture bytes, never deployed\n'}
p=r/'archives/own.zip'
with zipfile.ZipFile(p,'x',compression=zipfile.ZIP_DEFLATED,allowZip64=False)as z:
 for name,data in payload.items():z.writestr(name,data)
def identity(p):
 s=p.stat();return {'schema':'win-file-id128/1','volumeSerialNumber':str(s.st_dev),'fileId':str(s.st_ino)}
raw=p.read_bytes();print(json.dumps({'archive':{'parent':str(p.parent),'parentIdentity':identity(p.parent),'leaf':p.name,'identity':identity(p),'bytes':len(raw),'sha256':hashlib.sha256(raw).hexdigest()},'payload':{n:hashlib.sha256(b).hexdigest()for n,b in payload.items()},'total':sum(map(len,payload.values())),'md5':hashlib.md5(raw).hexdigest()}))`;
function python(script,args){
  const p=childProcess.spawnSync(PYTHON,['-I','-S','-B','-c',script,...args],{encoding:'utf8',windowsHide:true,timeout:15000,maxBuffer:65536});
  assert.ifError(p.error);assert.equal(p.status,0,p.stderr);return JSON.parse(p.stdout);
}
function retirementScript(){
  const text=fs.readFileSync(new URL('./owned-zip-relay.test.mjs',import.meta.url),'utf8');
  const start=text.indexOf('const PROCESS_HELPER = String.raw '),begin=text.indexOf('`',start)+1,end=text.indexOf('`;',begin);
  assert(start>=0&&begin>start&&end>begin);
  const script=text.slice(begin,end).replaceAll('\r\n','\n');
  assert.equal(sha(script),'b07784ced0b745d646c00e48220931286c257428af902b75c79540e6455bc34d');
  return script;
}
const bounded=(promise,ms=5000)=>new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>reject(Error('OWN_CAPSULE_FIXTURE_TIMEOUT')),ms);
  Promise.resolve(promise).then(v=>{clearTimeout(timer);resolve(v);},e=>{clearTimeout(timer);reject(e);});
});
function retainSpawnedChild(child,children,capture){
  const record={child,identity:null,captureError:null};children.set(child.pid,record);
  try{record.identity=capture();}
  catch(error){record.captureError=String(error?.message??'CAPTURE_FAILED');}
  return child;
}
test('fixture capture failure retains and returns the spawned child for normal SDK cleanup',()=>{
  const child=Object.freeze({pid:123}),children=new Map();
  const returned=retainSpawnedChild(child,children,()=>{
    assert.equal(children.get(child.pid).child,child);throw Error('identity probe failed');
  });
  assert.equal(returned,child);assert.equal(children.get(123).identity,null);
  assert.equal(children.get(123).captureError,'identity probe failed');
});
async function fixture(t){
  fs.mkdirSync(TASK,{recursive:true});const root=path.join(TASK,'run-'+nonce());
  const value=python(ZIP_FIXTURE,[root]),workspace=path.join(root,'runtime');
  const old=JSON.parse(fs.readFileSync(BINDING)),capture=captureNativeSDKSources(SDK,old.sourceSHA256);
  const binding={...old,workspaceRoot:workspace.replaceAll('\\','/')};
  const require=createRequire(path.join(SOURCE,'src/main/package.json'));
  const compiler=(await import(pathToFileURL(require.resolve('rolldown')).href)).rolldown;
  const times={},before=performance.now();
  const built=await buildNativeSDKCapsule(capture,Buffer.from(JSON.stringify(binding)),compiler);
  times.buildMs=performance.now()-before;
  fs.writeFileSync(path.join(root,'CAPSULE.json'),built.artifact,{flag:'wx'});
  fs.writeFileSync(path.join(root,'BINDING.json'),JSON.stringify(binding),{flag:'wx'});
  const sourcePins=Object.fromEntries(['native-sdk-capture.mjs','native-sdk-capsule-build.mjs','native-sdk-capsule-load.cjs',
    'native-sdk-node-bootstrap.mjs','native-sdk-python-capsule.mjs','native-sdk-capsule-native.test.mjs']
    .map(name=>[name,sha(fs.readFileSync(path.join(HERE,name)))]));
  fs.writeFileSync(path.join(root,'SOURCE-PINS.json'),JSON.stringify({sourcePins,sdkRoot:SDK,sdk:binding.sourceSHA256,
    compilerEntry:require.resolve('rolldown'),compilerEntrySHA256:sha(fs.readFileSync(require.resolve('rolldown'))),
    compilerPackageSHA256:sha(fs.readFileSync(require.resolve('rolldown/package.json'))),
    lockSHA256:sha(fs.readFileSync(path.join(SOURCE,'pnpm-lock.yaml')))},null,2),{flag:'wx'});
  const children=new Map(),original=childProcess.spawn,retire=retirementScript();
  childProcess.spawn=function(file,args,options){
    const child=original(file,args,options);
    if(file===NODE)return retainSpawnedChild(child,children,()=>python(retire,['capture',String(child.pid)]));
    return child;
  };
  syncBuiltinESMExports();
  let relay;
  t.after(async()=>{
    try{
      if(!relay)return;
      const status=relay.status();if(status.relayTerminal?.childResourcesClosed)return;
      try{
        if(!status.startSent){await bounded(relay.retireInert());return;}
        if(!status.cancelAttempted&&!status.releaseAttempted)await bounded(relay.cancel());
        if(!relay.status().releaseAttempted)await bounded(relay.release());
        await relay.waitFor('closed',5000);
      }catch(primary){
        const state=relay.status(),owned=children.get(state.relayPid);
        assert(owned?.identity,'Preserve unknown process: no exact fixture identity');
        const result=python(retire,['retire',String(owned.child.pid),owned.identity.creationTime,root,TASK]);
        await relay.waitFor('closed',5000);
        fs.writeFileSync(path.join(root,'FAILED-RETIREMENT.json'),JSON.stringify({status:state,result,normalRelease:false},null,2),{flag:'wx'});
        throw primary;
      }
    }finally{childProcess.spawn=original;syncBuiltinESMExports();}
  });
  const capsule=loader.loadNativeSDKCapsule(Buffer.from(built.artifact),built.sha256,Buffer.from(JSON.stringify(binding)));
  const roots={gamePath:path.join(root,'model-game'),stagingPath:path.join(root,'model-stage'),downloadPath:path.join(root,'archives')};
  const filesystemIds=Object.fromEntries(Object.entries(roots).map(([k,p])=>{const s=fs.statSync(p,{bigint:true});return[k,`${s.dev}:${s.ino}`];}));
  const h=sha('own capsule physical fixture, no host admission');
  const plan={schema:'install-job-plan/1',family:'tracked-new-disabled',contractId:job.CONTRACT_ID,
    context:{gameId:'cyberpunk2077',profileId:'capsule-fixture',...roots,filesystemIds},
    package:{downloadId:'fixture-own',fileName:'own.zip',expectedModId:'own',expectedType:'',bytes:value.archive.bytes,
      sha256:value.archive.sha256,md5:value.md5,expectedUncompressedBytes:value.total,payload:value.payload},
    evidence:{buildSHA256:h,sourceSHA256:h,nativeAdmissionSHA256:h},options:{enabled:false,deploy:false}};
  const request={schema:'native-dispatch-request/1',contractId:dispatch.CONTRACT_ID,operationId:'op_'+nonce(),nativeJobId:'exec_'+nonce(),
    planId:job.installPlanId(plan),managerScope:'manager-relay-fixture-1',rendererGeneration:'renderer_'+nonce(),admissionSHA256:h,plan};
  fs.writeFileSync(path.join(root,'REQUEST.json'),JSON.stringify(request),{flag:'wx'});
  const journalRoot=path.join(workspace,'local-state/vortex-agent-build/native-install-executor');
  fs.mkdirSync(path.dirname(journalRoot),{recursive:true});
  const journal=capsule.modules['native-executor-journal.mjs'].createNativeExecutorJournal({root:journalRoot});
  const anchor=journal.provision().anchor;
  relay=capsule.modules['owned-zip-relay-client.mjs'].createBoundOwnedZipRelay(Buffer.from(JSON.stringify(request)),
    Buffer.from(JSON.stringify(value.archive)),Buffer.from(JSON.stringify(binding)));
  assert.equal(fs.existsSync(path.join(workspace,'tools')),false);
  return{root,workspace,value,request,relay,journal,anchor,times,built,
    inertObserver:capsule.modules['owned-zip-relay-client.mjs'].observeRelayInertCancellation,
    assertCaptured(){assert.equal(children.size,1);for(const record of children.values())assert(record.identity,record.captureError??'No fixture process identity');},
    async step(label,fn){const before=performance.now();const result=await fn();times[label+'Ms']=performance.now()-before;return result;},
    save(outcome,inertCancellation=null){fs.writeFileSync(path.join(root,'CAPSULE-RESULT.json'),JSON.stringify({schema:'owned-capsule-copy-fixture/1',outcome,inertCancellation,
      artifactSHA256:built.sha256,requestSHA256:dispatch.dispatchRequestDigest(Buffer.from(JSON.stringify(request))),
      bindingSHA256:sha(JSON.stringify(binding)),sourcePins,
      processIdentity:[...children.values()].map(r=>({identity:r.identity,captureError:r.captureError})),
      times,status:relay.status(),journal:journal.inventory(),installedHostModified:false,nativeInstallAccepted:false},null,2),{flag:'wx'});}};
}

ownTest('real bound capsule extracts and copies an own ZIP, verifies proof and joins both process closures',async t=>{
  const f=await fixture(t),target=path.join(f.request.plan.context.stagingPath,'own');
  const prepared=await f.step('prepare',()=>f.relay.prepare(Buffer.from(JSON.stringify(f.anchor))));
  f.assertCaptured();
  assert.equal(prepared.transition.previousInventorySHA256,f.anchor.inventorySHA256);
  assert.equal(fs.existsSync(target),false);assert.equal(f.relay.status().sdk.startSent,false);
  await f.step('start',()=>f.relay.startPrepared());
  await f.step('extract',()=>f.relay.waitFor('extracted',15000));
  await f.step('copy',()=>f.relay.handoff());
  const proof=await f.step('proof',()=>f.relay.copyProof());
  assert.equal(proof.files.length,2);assert.equal(proof.totalBytes,f.value.total);
  for(const [name,h]of Object.entries(f.value.payload))assert.equal(sha(fs.readFileSync(path.join(target,...name.split('/')))),h);
  const released=await f.step('release',()=>f.relay.release());
  assert.equal(released.sdk.workerTerminal.childResourcesClosed,true);assert.equal(released.relayTerminal.childResourcesClosed,true);
  assert.equal(released.sdk.workerTerminal.exitSucceeded,true);assert.equal(released.relayTerminal.exitSucceeded,true);
  assert.equal(released.nativeInstallAccepted,false);assert.equal(fs.existsSync(path.join(f.workspace,'tools')),false);
  assert.throws(()=>f.inertObserver(f.relay),/INERT_CANCELLATION_UNPROVEN/);
  // SDK filesystem success is not a Vortex commit/adoption or terminal-history permit.
  assert.equal(f.journal.inventory().unresolvedCount,1);
  f.save('copied_and_closed_without_vortex_registration');
});

ownTest('prepared capsule cancellation closes the inert worker and preserves pending history without output',async t=>{
  const f=await fixture(t),target=path.join(f.request.plan.context.stagingPath,'own');
  await f.relay.prepare(Buffer.from(JSON.stringify(f.anchor)));
  f.assertCaptured();
  assert.equal(f.relay.status().sdk.startSent,false);
  assert.equal(fs.existsSync(target),false);
  assert.throws(()=>f.inertObserver(f.relay),/INERT_CANCELLATION_UNPROVEN/);
  await bounded(f.relay.cancel());
  assert.throws(()=>f.inertObserver(f.relay),/INERT_CANCELLATION_UNPROVEN/);
  const released=await bounded(f.relay.release());
  assert.equal(released.relayTerminal.childResourcesClosed,true);assert.equal(released.sdk.workerTerminal.childResourcesClosed,true);
  assert.equal(released.sdk.startSent,false);assert.equal(fs.existsSync(target),false);
  assert.equal(fs.existsSync(path.join(f.workspace,'local-state/owned-zip-worker-work')),false);
  const observation=f.inertObserver(f.relay);
  assert.equal(observation.schema,'owned-zip-relay-inert-cancellation/1');assert(Object.isFrozen(observation));
  assert(Object.isFrozen(observation.binding));assert(Object.isFrozen(observation.workerTerminal.pipes.stdin));
  assert.equal(observation.cancelledBeforeStart,true);assert.equal(observation.explicitStartAttempted,false);
  assert.equal(observation.pythonStartSent,false);assert.equal(observation.destinationAcquired,false);
  assert.equal(observation.binding.operationId,f.request.operationId);assert.equal(observation.relayPid,released.relayPid);
  assert.equal(observation.workerLifetime,released.sdk.workerLifetime);assert.equal(observation.workerPid,released.sdk.workerPid);
  assert.equal(observation.packetSHA256,released.sdk.packetSHA256);
  assert.equal(observation.relayTerminal.exitSucceeded,true);assert.equal(observation.workerTerminal.exitSucceeded,true);
  assert.equal(observation.nativeAdmission,false);assert.equal(observation.installationPermit,false);
  assert.throws(()=>f.inertObserver({}),/INERT_CANCELLATION_OWNER/);
  assert.throws(()=>f.inertObserver(f.relay,{}),/INERT_CANCELLATION_ARGUMENTS/);
  assert.equal(f.journal.inventory().unresolvedCount,1);
  f.save('inert_cancel_closed_without_registration',observation);
});
