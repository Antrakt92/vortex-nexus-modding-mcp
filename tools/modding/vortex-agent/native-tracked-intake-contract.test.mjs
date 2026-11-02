import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import vm from 'node:vm';
import intake from './native-tracked-intake-contract.cjs';
import job from './install-job-contract.cjs';
const {SCHEMA, LIMITS, validateTrackedIntake, parseTrackedIntake, trackedIntakeDigest} = intake;
const hash = 'a'.repeat(64);
function plan() {
  return {schema:'install-job-plan/1',family:'tracked-new-disabled',contractId:job.CONTRACT_ID,
    context:{gameId:'cyberpunk2077',profileId:'fixture-profile',gamePath:'F:/Fixture/Game',stagingPath:'F:/Fixture/Stage',downloadPath:'D:/Fixture/Downloads',
      filesystemIds:{gamePath:'1:2',stagingPath:'1:3',downloadPath:'2:4'}},
    package:{downloadId:'tracked_1',fileName:'Own Fixture.zip',expectedModId:'Own Fixture',expectedType:'',bytes:200,sha256:hash,md5:'b'.repeat(32),expectedUncompressedBytes:10,payload:{'r6/scripts/own.reds':hash}},
    evidence:{buildSHA256:hash,sourceSHA256:hash,nativeAdmissionSHA256:hash},options:{enabled:false,deploy:false}};
}
const request = () => ({schema:SCHEMA,requestId:'tracked_request_001',plan:plan()});
const bytes = value => Buffer.from(JSON.stringify(value));
const error = code => e => e instanceof Error && e.message === code;

test('closed intake snapshots real job-plan data synchronously and grants no authority', async () => {
  const input=request(), checked=validateTrackedIntake(input), digest=trackedIntakeDigest(input);
  input.requestId='changed_request';input.plan.context.profileId='changed';input.plan.package.payload['r6/scripts/own.reds']='c'.repeat(64);
  await Promise.resolve();
  assert.equal(checked.requestId,'tracked_request_001');assert.equal(checked.plan.context.profileId,'fixture-profile');assert.equal(checked.plan.package.payload['r6/scripts/own.reds'],hash);
  assert(Object.isFrozen(checked));assert(Object.isFrozen(checked.plan));assert(Object.isFrozen(checked.plan.package.payload));
  assert.deepEqual(Reflect.ownKeys(checked),['schema','requestId','plan']);assert.equal(Object.getPrototypeOf(checked),null);
  assert.equal(trackedIntakeDigest(checked),digest);assert.notEqual(trackedIntakeDigest(input),digest);
  assert.equal(Object.hasOwn(checked,'effectsAllowed'),false);assert.equal(Object.hasOwn(checked,'nativeAdmission'),false);
});

test('semantic digest binds stable public ID plus the existing plan identity', () => {
  const input=request(), reordered={plan:Object.fromEntries(Object.entries(input.plan).reverse()),requestId:input.requestId,schema:SCHEMA};
  reordered.plan.package=Object.fromEntries(Object.entries(input.plan.package).reverse());
  assert.equal(trackedIntakeDigest(reordered),trackedIntakeDigest(input));
  const expected=createHash('sha256').update(JSON.stringify([SCHEMA,input.requestId,job.installPlanId(input.plan)])).digest('hex');
  assert.equal(trackedIntakeDigest(input),expected);
  const other=request();other.requestId+='x';assert.notEqual(trackedIntakeDigest(other),expected);
  other.requestId=input.requestId;other.plan.evidence.sourceSHA256='c'.repeat(64);assert.notEqual(trackedIntakeDigest(other),expected);
  const parsed=parseTrackedIntake(Buffer.from(JSON.stringify(reordered,null,2).replace(/\n/g,'\r\n')));
  assert.equal(trackedIntakeDigest(parsed),expected);
});


test('digest rejects getters without invocation and revalidates each current caller plan', () => {
  let calls=0;
  for(const name of ['schema','requestId','plan']){
    const input=request();Object.defineProperty(input,name,{enumerable:true,get(){calls++;throw Error('envelope getter');}});
    assert.throws(()=>trackedIntakeDigest(input),error('NATIVE_TRACKED_INTAKE_INVALID'));
  }
  const input=request(), first=trackedIntakeDigest(input);
  input.plan.package.sha256='c'.repeat(64);assert.notEqual(trackedIntakeDigest(input),first);
  input.plan.options.enabled=true;assert.throws(()=>trackedIntakeDigest(input),error('INSTALL_JOB_INVALID_OPTIONS'));
  const accessor=request();Object.defineProperty(accessor.plan.package,'sha256',{enumerable:true,get(){calls++;throw Error('plan getter');}});
  assert.throws(()=>trackedIntakeDigest(accessor),error('INSTALL_JOB_JSON_REQUIRED'));
  const proxy=request();proxy.plan=new Proxy(proxy.plan,{getPrototypeOf(){calls++;throw Error('plan proxy');}});
  assert.throws(()=>trackedIntakeDigest(proxy),error('INSTALL_JOB_JSON_REQUIRED'));
  assert.equal(calls,0);
});
test('request ID exactly reuses adapter 8-to-80 ASCII alphanumeric underscore hyphen convention', () => {
  for(const id of ['a'.repeat(8),'Z9_-'.repeat(20)])assert.equal(validateTrackedIntake({...request(),requestId:id}).requestId,id);
  for(const id of ['', 'a'.repeat(7),'a'.repeat(81),'request.with.dot','request/secret','request1\n','request1\r','requesté',3,null,{}])
    assert.throws(()=>validateTrackedIntake({...request(),requestId:id}),error('NATIVE_TRACKED_INTAKE_INVALID'));
});

test('closed envelope refuses extra native labels, providers, owners and permit claims', () => {
  for(const [key,value] of Object.entries({operationId:'op_'+'1'.repeat(32),nativeJobId:'exec_'+'2'.repeat(32),managerScope:'manager-own-1',rendererGeneration:'renderer_'+'3'.repeat(32),archive:{},archiveBytes:new Uint8Array(1),owner:{},provider:()=>{},effectsAllowed:true,nativeAdmission:true}))
    assert.throws(()=>validateTrackedIntake({...request(),[key]:value}),error('NATIVE_TRACKED_INTAKE_INVALID'));
  for(const value of [null,undefined,[],new Uint8Array(1),Promise.resolve(request()),{...request(),schema:'native-tracked-intake/2'}])
    assert.throws(()=>validateTrackedIntake(value),error('NATIVE_TRACKED_INTAKE_INVALID'));
  for(const key of ['schema','requestId','plan']){const value=request();delete value[key];assert.throws(()=>validateTrackedIntake(value),error('NATIVE_TRACKED_INTAKE_INVALID'));}
});

test('getters, proxy traps, symbols, foreign prototypes and inherited serialization never run', () => {
  let calls=0;
  for(const key of ['schema','requestId','plan']){
    const value=request();Object.defineProperty(value,key,{enumerable:true,get(){calls++;throw Error('getter');}});
    assert.throws(()=>validateTrackedIntake(value),error('NATIVE_TRACKED_INTAKE_INVALID'));
  }
  const proxy=new Proxy(request(),{getPrototypeOf(){calls++;throw Error('trap');},ownKeys(){calls++;throw Error('trap');}});
  assert.throws(()=>validateTrackedIntake(proxy),error('NATIVE_TRACKED_INTAKE_INVALID'));
  const inherited=Object.assign(Object.create({toJSON(){calls++;throw Error('toJSON');}}),request());
  assert.throws(()=>validateTrackedIntake(inherited),error('NATIVE_TRACKED_INTAKE_INVALID'));
  const symbol=request();symbol[Symbol('extra')]=1;assert.throws(()=>validateTrackedIntake(symbol),error('NATIVE_TRACKED_INTAKE_INVALID'));
  const hidden=request();Object.defineProperty(hidden,'hidden',{value:1});assert.throws(()=>validateTrackedIntake(hidden),error('NATIVE_TRACKED_INTAKE_INVALID'));
  const foreign=vm.runInNewContext('({schema:"native-tracked-intake/1",requestId:"request_001",plan:{}})');
  assert.throws(()=>validateTrackedIntake(foreign),error('NATIVE_TRACKED_INTAKE_INVALID'));
  assert.equal(calls,0);
  assert.equal(validateTrackedIntake(Object.assign(Object.create(null),request())).requestId,'tracked_request_001');
});

test('plan negatives retain authoritative existing validator errors without duplicate schema rules', () => {
  for(const [mutate,code] of [
    [p=>{p.options.enabled=true;},'INSTALL_JOB_INVALID_OPTIONS'],
    [p=>{p.options.deploy=true;},'INSTALL_JOB_INVALID_OPTIONS'],
    [p=>{p.package.expectedModId='Other';},'INSTALL_JOB_INVALID_PACKAGE'],
    [p=>{p.context.filesystemIds.stagingPath=p.context.filesystemIds.gamePath;},'INSTALL_JOB_ROOT_ALIAS'],
    [p=>{p.package.payload={'../escape':hash};},'INSTALL_JOB_INVALID_PAYLOAD'],
    [p=>{p.package.payload['r6/scripts/own.reds']='not-a-digest';},'INSTALL_JOB_INVALID_PAYLOAD'],
    [p=>{p.package.bytes=job.LIMITS.archiveBytes+1;},'INSTALL_JOB_INVALID_PACKAGE']]){
    const input=request();mutate(input.plan);assert.throws(()=>validateTrackedIntake(input),error(code));
  }
  let calls=0;const input=request();Object.defineProperty(input.plan,'options',{enumerable:true,get(){calls++;throw Error('getter');}});
  assert.throws(()=>validateTrackedIntake(input),error('INSTALL_JOB_JSON_REQUIRED'));assert.equal(calls,0);
  const cycle=request();cycle.plan.options=cycle.plan;assert.throws(()=>validateTrackedIntake(cycle),error('INSTALL_JOB_JSON_REQUIRED'));
});

test('strict bytes reject decoded duplicates, malformed UTF8, BOM and unbounded input', () => {
  for(const value of [Buffer.from('{"schema":1,"\\u0073chema":2}'),Buffer.from([0xff]),Buffer.from('{'),Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),bytes(request())]),Buffer.alloc(LIMITS.bytes+1),new Uint8Array(0)])
    assert.throws(()=>parseTrackedIntake(value),error('NATIVE_TRACKED_INTAKE_INVALID_JSON'));
  assert.equal(parseTrackedIntake(new Uint8Array(bytes(request()))).requestId,'tracked_request_001');
  const input=bytes(request()), checked=parseTrackedIntake(input);input.fill(0);assert.equal(checked.plan.package.sha256,hash);
});

test('typed bytes refuse proxies, custom prototypes and shared or resizable backing', () => {
  let calls=0;const proxy=new Proxy(bytes(request()),{getPrototypeOf(){calls++;throw Error('trap');}});
  assert.throws(()=>parseTrackedIntake(proxy),error('NATIVE_TRACKED_INTAKE_INVALID_JSON'));

  const custom=new Uint8Array(bytes(request()));Object.setPrototypeOf(custom,Object.create(Uint8Array.prototype));
  assert.throws(()=>parseTrackedIntake(custom),error('NATIVE_TRACKED_INTAKE_INVALID_JSON'));
  const shared=new Uint8Array(new SharedArrayBuffer(2048));shared.set(bytes(request()));
  assert.throws(()=>parseTrackedIntake(shared),error('NATIVE_TRACKED_INTAKE_INVALID_JSON'));
  const backing=new ArrayBuffer(2048,{maxByteLength:4096});assert.equal(backing.resizable,true,'Node24 fixture requires actual resizable buffers');
  const resizable=new Uint8Array(backing);resizable.set(bytes(request()));assert.throws(()=>parseTrackedIntake(resizable),error('NATIVE_TRACKED_INTAKE_INVALID_JSON'));
  const detached=new Uint8Array(4);structuredClone(detached.buffer,{transfer:[detached.buffer]});assert.throws(()=>parseTrackedIntake(detached),error('NATIVE_TRACKED_INTAKE_INVALID_JSON'));
  assert.equal(calls,0);
});


test('intrinsic byte carriers ignore metadata and copy exactly nonzero-offset visible bytes', () => {
  let calls=0;const raw=bytes(request()), backing=new Uint8Array(raw.length+16);backing.fill(0xff);backing.set(raw,7);
  const view=new Uint8Array(backing.buffer,7,raw.length);
  for(const name of ['extra','byteLength','buffer'])Object.defineProperty(view,name,{enumerable:true,get(){calls++;throw Error('carrier getter');}});
  view[Symbol('unrelated')]=()=>{throw Error('carrier symbol');};
  const checked=parseTrackedIntake(view);assert.equal(checked.requestId,'tracked_request_001');assert.equal(checked.plan.package.sha256,hash);assert.equal(calls,0);
  backing.fill(0);assert.equal(checked.plan.package.sha256,hash);assert.equal(calls,0);
  const carrier=bytes(request());Object.defineProperty(carrier,'extra',{get(){calls++;throw Error('buffer metadata');}});carrier[Symbol('metadata')]=1;
  assert.equal(parseTrackedIntake(carrier).requestId,'tracked_request_001');assert.equal(calls,0);
});
test('plan traversal budget remains bounded through intake', () => {
  const value=request();let cursor=value.plan.options;for(let n=0;n<job.LIMITS.depth+1;n++){cursor.next={};cursor=cursor.next;}
  assert.throws(()=>validateTrackedIntake(value),error('INSTALL_JOB_LIMIT'));
  const large=request();large.plan.package.fileName='x'.repeat(4097);assert.throws(()=>validateTrackedIntake(large),error('INSTALL_JOB_LIMIT'));
});
