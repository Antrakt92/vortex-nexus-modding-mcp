import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import * as sdk from './owned-zip-worker-client.mjs';
import job from './install-job-contract.cjs';
import dispatch from './native-dispatch-contract.cjs';

const encode=value=>Buffer.from(JSON.stringify(value));
function fixture(){
  const plan={schema:'install-job-plan/1',family:'tracked-new-disabled',contractId:job.CONTRACT_ID,
    context:{gameId:'cyberpunk2077',profileId:'own-inputs',gamePath:'C:/own-game',stagingPath:'C:/own-stage',downloadPath:'C:/own-downloads',
      filesystemIds:{gamePath:'1:1',stagingPath:'1:2',downloadPath:'1:3'}},
    package:{downloadId:'own-download',fileName:'own.zip',expectedModId:'own',expectedType:'',bytes:32,
      sha256:'a'.repeat(64),md5:'b'.repeat(32),expectedUncompressedBytes:1,payload:{'a.txt':'c'.repeat(64)}},
    evidence:{buildSHA256:'d'.repeat(64),sourceSHA256:'e'.repeat(64),nativeAdmissionSHA256:'f'.repeat(64)},options:{enabled:false,deploy:false}};
  const request={schema:'native-dispatch-request/1',contractId:dispatch.CONTRACT_ID,operationId:'op_'+'1'.repeat(32),
    nativeJobId:'exec_'+'2'.repeat(32),planId:job.installPlanId(plan),managerScope:'manager-inputs-1',
    rendererGeneration:'renderer_'+'3'.repeat(32),admissionSHA256:'f'.repeat(64),plan};
  const identity=(volume,file)=>({schema:'win-file-id128/1',volumeSerialNumber:volume,fileId:file});
  const archive={parent:plan.context.downloadPath,parentIdentity:identity('18446744073709551615','340282366920938463463374607431768211455'),
    leaf:'own.zip',identity:identity('18446744073709551615','4'),bytes:32,sha256:plan.package.sha256};
  return{request,archive};
}
function noIO(body){
  const names=['lstatSync','statSync','openSync','readSync','readFileSync','mkdirSync','writeFileSync','readdirSync','opendirSync'];
  const originals=new Map(names.map(name=>[name,fs[name]])),spawn=childProcess.spawn,cwd=process.cwd;
  let calls=0;const refuse=()=>{calls++;throw Error('Pure snapshot attempted IO');};
  for(const name of names)fs[name]=refuse;childProcess.spawn=refuse;process.cwd=refuse;syncBuiltinESMExports();
  try{return body();}finally{for(const[name,fn]of originals)fs[name]=fn;childProcess.spawn=spawn;process.cwd=cwd;syncBuiltinESMExports();assert.equal(calls,0);}
}
const snapshot=(request,archive)=>sdk.snapshotOwnedStagingZipInputs(request,archive);

test('actual pure staging snapshot returns frozen detached request and six-field archive without IO',()=>noIO(()=>{
  const f=fixture(),request=encode(f.request),archive=encode(f.archive),r=Buffer.from(request),a=Buffer.from(archive);
  const out=snapshot(request,archive);
  assert.deepEqual(Object.keys(out),['request','archive']);assert.deepEqual(out.archive,f.archive);
  assert.deepEqual(out.request,dispatch.parseDispatchRequest(r));
  assert.equal(dispatch.dispatchRequestDigest(encode(out.request)),dispatch.dispatchRequestDigest(r));
  for(const value of [out,out.request,out.request.plan,out.request.plan.context,out.request.plan.package,out.request.plan.package.payload,
    out.archive,out.archive.identity,out.archive.parentIdentity])assert(Object.isFrozen(value));
  assert(request.equals(r));assert(archive.equals(a));request.fill(0);archive.fill(0);
  assert.equal(out.request.plan.package.md5,'b'.repeat(32));assert.equal(out.archive.sha256,'a'.repeat(64));
  assert.equal(out.archive.parentIdentity.fileId,'340282366920938463463374607431768211455');
  assert.equal(out.archive.parentIdentity.volumeSerialNumber,'18446744073709551615');
  assert(!Object.hasOwn(out,'effectsAllowed'));assert(!Object.hasOwn(out.archive,'md5'));
}));
test('archive canonical slash/case aliases preserve native64/128 identity domains',()=>noIO(()=>{
  const f=fixture();f.archive.parent='c:\\OWN-downloads';
  const out=snapshot(encode(f.request),encode(f.archive));assert.equal(out.archive.parent,f.archive.parent);
  assert.notEqual(out.archive.parentIdentity.volumeSerialNumber,out.request.plan.context.filesystemIds.downloadPath.split(':')[0]);
  f.archive.parent='C:/different-downloads';assert.throws(()=>snapshot(encode(f.request),encode(f.archive)),/ARCHIVE_CONTEXT_MISMATCH/);
}));
test('missing, extra and inconsistent archive fields refuse before IO',()=>noIO(()=>{
  for(const mutate of [a=>delete a.identity,a=>a.extra=true,a=>a.leaf='other.zip',a=>a.bytes++,a=>a.sha256='d'.repeat(64),
    a=>a.parent='C:/own-downloads/../other',a=>a.identity.fileId='340282366920938463463374607431768211456',
    a=>a.parentIdentity.volumeSerialNumber='18446744073709551616']){
    const f=fixture();mutate(f.archive);assert.throws(()=>snapshot(encode(f.request),encode(f.archive)));
  }
}));
test('duplicate JSON keys, BOM and malformed UTF8 refuse on either input without IO',()=>noIO(()=>{
  const f=fixture(),r=encode(f.request),a=encode(f.archive);
  const duplicate=(b,key,value)=>Buffer.from(b.toString().replace('{','{'+JSON.stringify(key)+':'+JSON.stringify(value)+','));
  for(const bad of [duplicate(r,'operationId',f.request.operationId),Buffer.concat([Buffer.from([239,187,191]),r]),Buffer.from([255]),Buffer.alloc(dispatch.LIMITS.bytes+1)])
    assert.throws(()=>snapshot(bad,a));
  for(const bad of [duplicate(a,'leaf','own.zip'),Buffer.concat([Buffer.from([239,187,191]),a]),Buffer.from([255]),Buffer.alloc(8193)])
    assert.throws(()=>snapshot(r,bad));
  assert.equal(snapshot(Buffer.from(' \r\n'+r+'\t'),Buffer.from('\n'+a+' ')).archive.leaf,'own.zip');
}));
test('forged objects, byte proxies and shared inputs refuse without getters or IO',()=>noIO(()=>{
  const f=fixture(),r=encode(f.request),a=encode(f.archive);let gets=0;
  const forged={get byteLength(){gets++;throw Error('getter');},get buffer(){gets++;throw Error('getter');}};
  for(const invalid of [f.request,forged,new Proxy(r,{get(){gets++;throw Error('proxy');}}),new Uint8Array(new SharedArrayBuffer(r.length))])
    assert.throws(()=>snapshot(invalid,a));
  for(const invalid of [f.archive,forged,new Proxy(a,{get(){gets++;throw Error('proxy');}}),new Uint8Array(new SharedArrayBuffer(a.length))])
    assert.throws(()=>snapshot(r,invalid));
  assert.equal(gets,0);
}));
test('intrinsic byte length/buffer access ignores shadowed getters and copies only subarray',()=>noIO(()=>{
  const f=fixture(),r=encode(f.request),a=encode(f.archive),request=new Uint8Array(r),backing=Buffer.concat([Buffer.from('bad'),a,Buffer.from('bad')]),archive=backing.subarray(3,-3);
  for(const input of [request,archive])for(const name of ['byteLength','buffer'])Object.defineProperty(input,name,{get(){assert.fail('shadowed getter');}});
  const out=snapshot(request,archive);assert.equal(out.archive.leaf,'own.zip');assert.equal(out.request.operationId,f.request.operationId);
}));
test('request target/plan digest are parsed, validated and detached rather than accepted as object claims',()=>noIO(()=>{
  const f=fixture();f.request.plan.package.expectedModId='other';
  assert.throws(()=>snapshot(encode(f.request),encode(f.archive)));
  const g=fixture();g.request.plan.context.profileId='changed';assert.throws(()=>snapshot(encode(g.request),encode(g.archive)),/PLAN_MISMATCH/);
  g.request.planId=job.installPlanId(g.request.plan);assert.equal(snapshot(encode(g.request),encode(g.archive)).request.plan.context.profileId,'changed');
}));
test('supported staging/registration family intersection refuses before any IO',()=>noIO(()=>{
  for(const mutate of [r=>r.plan.package.downloadId='Constructor',r=>r.plan.package.downloadId='_archive',
    r=>r.plan.package.payload={'a#.txt':'c'.repeat(64)},r=>r.plan.package.payload={'a~.txt':'c'.repeat(64)},
    r=>r.plan.package.payload={['a/'.repeat(32)+'a.txt']:'c'.repeat(64)},
    r=>r.plan.context.stagingPath='C:/own~stage',r=>r.plan.context.stagingPath='C:/'+Array(33).fill('stage').join('/')]){
    const f=fixture();mutate(f.request);f.request.planId=job.installPlanId(f.request.plan);
    assert.throws(()=>snapshot(encode(f.request),encode(f.archive)),/UNSUPPORTED_/);
  }
  // No game HANDLE or game output is used by this fixed staging backend.
  const f=fixture();f.request.plan.context.gamePath='C:/own~game';f.request.planId=job.installPlanId(f.request.plan);
  assert.equal(snapshot(encode(f.request),encode(f.archive)).request.plan.context.gamePath,'C:/own~game');
}));
