// Opt-in OWN Node/Python preparation only. Main SQL and Electron frame objects
// are explicit controlled facades; this is not Vortex/Electron/real DB proof.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {fileURLToPath} from 'node:url';
import {repo} from './native-query-source-admission.test.mjs';
import {createPendingFixture} from './native-executor-pending.test.mjs';
import job from './install-job-contract.cjs';
import dispatch from './native-dispatch-contract.cjs';
import {createNativeExecutorJournal} from './native-executor-journal.mjs';

const HERE=path.dirname(fileURLToPath(import.meta.url)),sha=x=>crypto.createHash('sha256').update(x).digest('hex');
const enabled=process.platform==='win32'&&process.arch==='x64'&&process.env.VORTEX_NATIVE_EXECUTOR_PENDING_RELAY_TEST==='1';
const NODE='C:/Program Files/nodejs/node.exe',PYTHON='C:/Python314/python.exe';
const PINS={node:'5c976096e04e5c2c1f091938926234cc9fbebfe9787ddd149351b3b0ecc707b5',
  python:'434b361fe0c5960d404974feed493db47f2603a1ace2574312104fbed0182c6f',
  pythonCore:'854fe7549eb4b2ac478935a38ae2ca1b774c6fdc3d87f0263fbd697ff86d7149',
  fixture:'4b210592df26bc45985ab47cf55f97c3f810fd11cda78b29fcef63e16ff60f37',
  processHelper:'b07784ced0b745d646c00e48220931286c257428af902b75c79540e6455bc34d'};
function helpers(){
  const source=fs.readFileSync(path.join(HERE,'owned-zip-relay.test.mjs'),'utf8');
  const literal=(start,end)=>new Function('return '+source.slice(source.indexOf(start)+start.length,source.indexOf(end,source.indexOf(start))).trim().replace(/;$/,''))();
  const fixture=literal('const FIXTURE = ','\nfunction fixture()'),processHelper=literal('const PROCESS_HELPER = ','\nconst children = new Map();');
  assert.equal(sha(fixture),PINS.fixture);assert.equal(sha(processHelper),PINS.processHelper);
  return{fixture,processHelper};
}
function hashFile(file){
  const stamp=s=>[s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs,s.nlink].join(':'),before=fs.lstatSync(file,{bigint:true});
  assert(before.isFile()&&!before.isSymbolicLink()&&before.size>0n&&before.size<=134217728n);
  const fd=fs.openSync(file,'r'),hash=crypto.createHash('sha256'),chunk=Buffer.alloc(65536),size=Number(before.size);let used=0;
  try{assert.equal(stamp(fs.fstatSync(fd,{bigint:true})),stamp(before));while(used<=size){const n=fs.readSync(fd,chunk,0,Math.min(chunk.length,size+1-used),used);if(n===0)break;used+=n;assert(used<=size);hash.update(chunk.subarray(0,n));}
    assert.equal(used,size);assert.equal(stamp(fs.fstatSync(fd,{bigint:true})),stamp(before));assert.equal(stamp(fs.lstatSync(file,{bigint:true})),stamp(before));return hash.digest('hex');
  }finally{fs.closeSync(fd);}
}
const encoded=value=>Buffer.from(JSON.stringify(value));
async function bounded(promise,ms=10000){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('OWN_FIXTURE_TIMEOUT')),ms);})]);}finally{clearTimeout(timer);}}

test('reviewed own archive fixture and exact-child retirement helper keep their accepted bytes',()=>{
  assert(helpers().fixture.includes('ZIP_STORED'));assert(helpers().processHelper.includes('GetProcessTimes'));
});
test('actual Main/frame source prepares real bound Node/Python, ACKs pending anchor, then explicitly joins inert cancellation',{
  skip:!enabled||!repo,timeout:60000,
},async t=>{
  const scripts=helpers();assert.equal(hashFile(NODE),PINS.node);assert.equal(hashFile(PYTHON),PINS.python);assert.equal(hashFile('C:/Python314/python314.dll'),PINS.pythonCore);
  const f=await createPendingFixture(t,{realRelay:true}),root=path.join(f.workspace,'run-'+crypto.randomBytes(16).toString('hex'));
  const generated=childProcess.spawnSync(PYTHON,['-I','-S','-B','-c',scripts.fixture,root],{encoding:'utf8',windowsHide:true,timeout:10000,maxBuffer:32768});
  assert.equal(generated.status,0,generated.stderr);const fixture=JSON.parse(generated.stdout),request=structuredClone(f.request);
  Object.assign(request.plan.context,{gamePath:path.join(root,'model-game'),stagingPath:path.join(root,'model-stage'),downloadPath:path.join(root,'archives')});
  for(const key of ['gamePath','stagingPath','downloadPath']){const s=fs.statSync(request.plan.context[key],{bigint:true});request.plan.context.filesystemIds[key]=`${s.dev}:${s.ino}`;}
  Object.assign(request.plan.package,{bytes:fixture.archive.bytes,sha256:fixture.archive.sha256,md5:fixture.md5,expectedUncompressedBytes:fixture.total,payload:fixture.payload});
  request.operationId='op_'+crypto.randomBytes(16).toString('hex');request.nativeJobId='exec_'+crypto.randomBytes(16).toString('hex');request.planId=job.installPlanId(request.plan);
  const requestBytes=encoded(request),archiveBytes=encoded(fixture.archive),sourceBefore=Object.fromEntries(fs.readdirSync(f.sdk).map(name=>[name,hashFile(path.join(f.sdk,name))]));
  assert.equal(Object.keys(sourceBefore).length,15);
  const original=childProcess.spawn;let child,identity,relay,result,closed,failed=false;
  childProcess.spawn=(file,args,options)=>{
    const c=original(file,args,options);
    if(file===NODE){assert.equal(child,undefined);child=c;
      const capture=childProcess.spawnSync(PYTHON,['-I','-S','-B','-c',scripts.processHelper,'capture',String(c.pid)],{encoding:'utf8',windowsHide:true,timeout:5000,maxBuffer:8192});
      assert.equal(capture.status,0,capture.stderr);identity=JSON.parse(capture.stdout);
      fs.writeFileSync(path.join(root,'EXACT-CHILD.json'),JSON.stringify({identity,args,helperSHA256:PINS.processHelper}),{flag:'wx'});
    }return c;
  };syncBuiltinESMExports();
  try{
    result=await bounded(f.wiring.prepareNativeExecutorPending(f.mainOwner,f.owner,f.frameOwner,requestBytes,archiveBytes),30000);
    relay=f.wiring.testOnlyPendingRelay();assert(relay);
    // The prepared envelope precedes the passive SDK status frame on stdout.
    const deadline=performance.now()+5000;
    while(relay.status().sdk?.phase!=='ready'){assert(performance.now()<deadline);await new Promise(resolve=>setTimeout(resolve,5));}
    const prepared=relay.status();
    assert.equal(result.schema,'native-executor-pending-preparation/1');assert.equal(result.requestSHA256,dispatch.dispatchRequestDigest(requestBytes));
    assert.equal(prepared.sdk.phase,'ready');assert.equal(prepared.sdk.startSent,false);assert.equal(prepared.sdk.handoffAttempted,false);
    assert.equal(prepared.sdk.workerTerminal.exitObserved,false);assert.equal(prepared.relayTerminal.exitObserved,false);
    f.frame.check(f.frameOwner);f.main.checkNativeModPersistenceTarget(f.owner,'cyberpunk2077','own');
    const anchor=JSON.parse(f.committed.get('nativeExecutorAnchorV1'));assert.equal(anchor.inventorySHA256,result.inventorySHA256);
    assert.equal(f.calls.filter(c=>c.sql==='COMMIT').length,2);
    assert.equal(fs.existsSync(path.join(f.workspace,'local-state/owned-zip-worker-work',request.operationId)),false);
    assert.equal(fs.existsSync(path.join(request.plan.context.stagingPath,'own')),false);
    // Known inert preparation, never unknown mutation recovery or an install.
    await bounded(relay.cancel());closed=await bounded(relay.release());
    assert.equal(closed.phase,'released');assert.equal(closed.sdk.startSent,false);assert.equal(closed.sdk.childClosed,true);
    for(const observation of [closed.relayTerminal,closed.sdk.workerTerminal]){
      assert.equal(observation.childResourcesClosed,true);assert.equal(observation.exitSucceeded,true);
      for(const key of ['stdin','stdout','stderr'])assert.equal(observation.pipes[key].closeObserved,true);
    }
    const inventory=createNativeExecutorJournal({root:f.root}).inventory({expectedRootId:anchor.rootId,expectedInventorySHA256:anchor.inventorySHA256});
    assert.equal(inventory.historySealVerified,true);assert.equal(inventory.startupHoldRequired,true);assert.equal(inventory.unresolvedCount,1);assert.equal(inventory.closedCount,0);
    assert.equal(inventory.records[0].operationId,request.operationId);assert.equal(inventory.records[0].nativeJobId,request.nativeJobId);
    assert.equal(fs.existsSync(path.join(request.plan.context.stagingPath,'own')),false);
    assert.deepEqual(Object.fromEntries(fs.readdirSync(f.sdk).map(name=>[name,hashFile(path.join(f.sdk,name))])),sourceBefore);
    fs.writeFileSync(path.join(root,'RESULT.json'),JSON.stringify({schema:'own-main-pending-relay-acceptance/1',operationId:request.operationId,nativeJobId:request.nativeJobId,
      requestSHA256:result.requestSHA256,pendingAnchorAcknowledged:true,prepared,result,closed,inventory,sourceBefore,runtimePins:PINS,
      actualMainClass:true,actualJournal:true,actualNodePython:true,sqlFacade:true,electronFrameFacade:true,pythonSTART:false,installationPermit:false,nativeInstallAccepted:false},null,2)+'\n',{flag:'wx'});
  }catch(error){failed=true;throw error;}
  finally{
    childProcess.spawn=original;syncBuiltinESMExports();relay??=f.wiring.testOnlyPendingRelay();
    if(relay&&!relay.status().relayTerminal?.childResourcesClosed){
      try{
        const state=relay.status();assert.equal(state.sdk?.startSent,false,'Only known inert SDK may be normally cancelled');
        await bounded(relay.cancel());await bounded(relay.release());
      }catch(cleanup){
        assert(child&&identity,'Unknown exact fixture identity: preserve without generic kill');
        const retired=childProcess.spawnSync(PYTHON,['-I','-S','-B','-c',scripts.processHelper,'retire',String(child.pid),identity.creationTime,root,f.workspace],{encoding:'utf8',windowsHide:true,timeout:15000,maxBuffer:32768});
        fs.writeFileSync(path.join(root,'FAILED-RETIREMENT.json'),JSON.stringify({helperSHA256:PINS.processHelper,status:retired.status,stdout:retired.stdout,stderr:retired.stderr,
          installationPermit:false,nativeInstallAccepted:false,unknownHistoryPreserved:true}),{flag:'wx'});
        assert.equal(retired.status,0,retired.stderr);await bounded(relay.waitFor('closed',5000));
        if(!failed)throw cleanup;
      }
    }
  }
});
