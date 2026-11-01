// Source-backed fixture input helpers only. Importing this file does not construct a Main,
// Renderer, store, backend, capsule, journal, relay or worker.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import job from './install-job-contract.cjs';
import dispatch from './native-dispatch-contract.cjs';
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
export const SECOND_DOWNLOAD = Object.freeze({
  id: 'second-download', modId: 'second-own', leaf: 'second-own.zip',
  archiveSHA256: 'c'.repeat(64), md5: 'd'.repeat(32), payloadSHA256: 'e'.repeat(64),
  operationId: 'op_'+'8'.repeat(32), nativeJobId: 'exec_'+'9'.repeat(32),
});
/** Build fresh raw protocol bytes; actual producer computes all request/plan IDs.
 * This is model metadata, not a real archive or held hash/custody proof. */
export function nextRequest(firstRequestBytes, firstArchiveBytes, options = {}) {
  const request = structuredClone(dispatch.parseDispatchRequest(firstRequestBytes));
  const archive = JSON.parse(Buffer.from(firstArchiveBytes).toString('utf8'));
  const chosen = {...SECOND_DOWNLOAD, ...options};
  assert.notEqual(chosen.operationId,request.operationId);
  assert.notEqual(chosen.nativeJobId,request.nativeJobId);
  assert.notEqual(chosen.id,request.plan.package.downloadId);
  assert.notEqual(chosen.modId,request.plan.package.expectedModId);
  assert.notEqual(chosen.archiveSHA256,request.plan.package.sha256);
  request.operationId = chosen.operationId; request.nativeJobId = chosen.nativeJobId;
  Object.assign(request.plan.package, {downloadId: chosen.id, fileName: chosen.leaf,
    expectedModId: chosen.modId, sha256: chosen.archiveSHA256, md5: chosen.md5,
    payload: {'a.txt': chosen.payloadSHA256}});
  request.planId = job.installPlanId(request.plan);
  Object.assign(archive,{leaf:chosen.leaf,sha256:chosen.archiveSHA256,
    identity:{...archive.identity,fileId:'33'}});
  const requestBytes = Buffer.from(JSON.stringify(request)), archiveBytes = Buffer.from(JSON.stringify(archive));
  const checked = dispatch.parseDispatchRequest(requestBytes);
  return {request:checked,archive,requestBytes,archiveBytes,
    requestSHA256:dispatch.dispatchRequestDigest(requestBytes),
    requestBytesSHA256:sha(requestBytes),archiveBytesSHA256:sha(archiveBytes)};
}
export function secondArchiveRows(gameId='cyberpunk2077', options={}) {
  const v={...SECOND_DOWNLOAD,...options};
  return {[v.id]:{state:'finished',game:[gameId],localPath:v.leaf,size:32,fileMD5:v.md5}};
}
/** Seed before Main init into the SAME map; do not replace it between cycles. */
export function seedSecondDownload(committed, gameId='cyberpunk2077', options={}) {
  for(const[id,row]of Object.entries(secondArchiveRows(gameId,options)))
    for(const[key,value]of Object.entries(row)) {
      const name='persistent###downloads###files###'+id+'###'+key;
      assert(!committed.has(name)); committed.set(name,JSON.stringify(value));
    }
}
/** Exact fixed hasNewModRegistrationConflict predicate, SQL facade only. */
export function conflictRows(data, params) {
  const [gamePrefix,targetPrefix,modId] = params;
  assert.equal(typeof gamePrefix,'string');assert.equal(typeof targetPrefix,'string');
  for(const key of data.keys()) {
    if(key===null||key===''||key==='persistent'||key==='persistent###mods'||key===gamePrefix
      ||key===targetPrefix||key.startsWith(targetPrefix+'###')||key==='persistent###profiles') return [[1]];
    if(key.startsWith('persistent###profiles###')) {
      const parts=key.split('###');
      if(parts.length===3 || parts[3]==='modState'&&(parts.length===4||parts[4]===modId))return [[1]];
    }
  }
  return [];
}
/** Callback-free fixture physical facts are PER SDK owner, never per lifetime.
 * This does not reset any production admission, attempt or consumed-ID field. */
export function perOwnerTerminalFacts(terminal) {
  const states=new WeakMap();
  const state=raw=>{let value=states.get(raw.sdk);if(!value){value={closed:false,releaseStarted:false,
    nodeTerminal:terminal(raw.binding),workerTerminal:raw.sdk.workerTerminal};
    Object.assign(value.workerTerminal,terminal(raw.binding));states.set(raw.sdk,value);}return value;};
  return {state,states};
}

export function once(text,before,after) {
  assert.equal(text.split(before).length,2,'exact source fixture seam: '+before);
  return text.replace(before,after);
}
/** Applied to the raw transport fixture before the existing exact adapters. */
export function adaptTransportText(text) {
  const mainPatches=['native-main-executor-successor'];
  const mainExports=['prepareNativeExecutorSuccessor'];
  text=once(text,'const wiring=execute(prepared(stages),',
    'const wiring=execute(prepared([...stages,...'+JSON.stringify(mainPatches)+']),');
  if(mainExports.length)text=once(text,'`({verifyNativeExecutorStartup,',
    '`({'+mainExports.join(',')+',verifyNativeExecutorStartup,');
  return text;
}
/** Continuation wrapper's SQL dispatch and physical facades are test code.
 * Source checks, genuine opaque owners and capsule namespace are untouched. */
export function adaptContinuationText(text) {
  const predicate = conflictRows.toString();
  text=once(text,"else if(sql.includes('SELECT 1 FROM keys'))rows=[];",
    "else if(sql.includes('SELECT 1 FROM keys'))rows=("+predicate+")(data,params);");
  text=once(text,"calls=[],state={phase:'prepared'},h='a'.repeat(64);let context,receipt,proof;",
    "calls=[];let lastState,context,receipt;");
  text=once(text,"const request=dispatch.parseDispatchRequest(rb),binding=",
    "const state={phase:'prepared'};lastState=state;const request=dispatch.parseDispatchRequest(rb),binding=");
  text=once(text,"workerLifetime:'worker_'+'4'.repeat(32),packetSHA256:'5'.repeat(64)",
    "workerLifetime:'worker_'+request.nativeJobId.slice(5),packetSHA256:sha(Buffer.from(rb))");
  text=once(text,'   proof={schema:', '   const proof={schema:');
  text=once(text,"files:[{path:'a.txt',bytes:1,sha256:h,",
    "files:[{path:'a.txt',bytes:1,sha256:request.plan.package.payload['a.txt'],");
  text=once(text,"relayLifetime:'relay_'+'6'.repeat(32),relayPid:4320,startSHA256:'7'.repeat(64)",
    "relayLifetime:'relay_'+request.operationId.slice(3),relayPid:4320,startSHA256:sha(Buffer.concat([Buffer.from(rb),Buffer.from(ab)]))");
  text=once(text,'relayCalls:calls,relayState:state,context:',
    'relayCalls:calls,get relayState(){return lastState;},context:');
  return text;
}
