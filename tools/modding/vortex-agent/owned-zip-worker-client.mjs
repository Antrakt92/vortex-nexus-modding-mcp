// Internal standalone coordinator. No Vortex dispatch or public MCP entrypoint.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {isUint8Array, isSharedArrayBuffer} from 'node:util/types';
import {fileURLToPath} from 'node:url';
import strict from './strict-json.cjs';
import dispatch from './native-dispatch-contract.cjs';
import {createNativeExecutorJournal} from './native-executor-journal.mjs';
import {createImmutableRecordIO, generation} from './immutable-records.mjs';
import childTerminal from './child-terminal-observer.cjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PYTHON = 'C:/Python314/python.exe';
const CORE = 'C:/Python314/python314.dll';
const WORK_BASE = path.resolve(HERE, '../../../local-state/owned-zip-worker-work');
const SOURCES = ['owned-file-transfer.py', 'owned-zip-extractor.py', 'owned-zip-worker.py'];
const RUNTIME = Object.freeze({
  pythonExe: '434b361fe0c5960d404974feed493db47f2603a1ace2574312104fbed0182c6f',
  pythonCore: '854fe7549eb4b2ac478935a38ae2ca1b774c6fdc3d87f0263fbd697ff86d7149',
});
const PHASES = new Set(['extracting', 'extracted', 'copying', 'copied', 'cancelled', 'held', 'released']);
const FRAME_MAX = 16384, START_MAX = 1024*1024+16384;
const scopeIO = createImmutableRecordIO({maxBytes: FRAME_MAX, prefix: 'OWNED_ZIP_WORKER_'});
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const exact = (v, keys) => v && typeof v === 'object' && !Array.isArray(v)
  && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const need = (ok, code) => {if (!ok) throw Error('OWNED_ZIP_WORKER_' + code);};
const label = (v, prefix) => typeof v === 'string' && new RegExp('^'+prefix+'_[a-f0-9]{32}$').test(v);
const finiteCode = v => v === null || typeof v === 'string' && /^[A-Z][A-Z0-9_]{0,99}$/.test(v);
let occupied = null;

function ordinary(file) {
  for (let node = path.resolve(file);; node = path.dirname(node)) {
    const stat = fs.lstatSync(node);
    need(!stat.isSymbolicLink(), 'UNSAFE_SOURCE');
    if (node === path.dirname(node)) break;
  }
}
function fileHash(file, maxBytes = 32*1024*1024) {
  ordinary(file);
  const before = fs.lstatSync(file, {bigint: true});
  need(before.isFile() && before.size > 0n && before.size <= BigInt(maxBytes), 'SOURCE_LIMIT');
  const same = stat => stat.isFile() && !stat.isSymbolicLink()
    && ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'nlink'].every(k => stat[k] === before[k]);
  const fd = fs.openSync(file, 'r');
  try {
    need(same(fs.fstatSync(fd, {bigint: true})), 'SOURCE_CHANGED');
    const hash = crypto.createHash('sha256'), chunk = Buffer.alloc(64*1024);
    const size = Number(before.size);
    let used = 0;
    // Read at most the admitted size plus one byte, even if the file grows.
    while (used <= size) {
      const count = fs.readSync(fd, chunk, 0, Math.min(chunk.length, size+1-used), used);
      if (count === 0) break;
      used += count;
      need(used <= size, 'SOURCE_CHANGED');
      hash.update(chunk.subarray(0, count));
    }
    need(used === size && same(fs.fstatSync(fd, {bigint: true}))
      && same(fs.lstatSync(file, {bigint: true})), 'SOURCE_CHANGED');
    ordinary(file);
    return hash.digest('hex');
  } finally {fs.closeSync(fd);}
}
function sources() {return Object.fromEntries(SOURCES.map(name => [name, fileHash(path.join(HERE, name), 512*1024)]));}
function runtime() {
  need(process.platform === 'win32' && process.arch === 'x64' && !process.versions.electron
    && process.versions.node === '24.20.0', 'UNSUPPORTED_RUNTIME');
  need(fileHash(PYTHON) === RUNTIME.pythonExe && fileHash(CORE) === RUNTIME.pythonCore, 'PYTHON_SOURCE_MISMATCH');
}
function nativeIdentity(v) {
  return exact(v, ['schema', 'volumeSerialNumber', 'fileId']) && v.schema === 'win-file-id128/1'
    && [['volumeSerialNumber', 64n], ['fileId', 128n]].every(([k, bits]) =>
      typeof v[k] === 'string' && /^[1-9][0-9]{0,38}$/.test(v[k]) && BigInt(v[k]) < 2n**bits);
}
const sameIdentity = (a,b) => nativeIdentity(a) && nativeIdentity(b)
  && ['schema','volumeSerialNumber','fileId'].every(key=>a[key]===b[key]);
const sameDestination = (a,b) => exact(a,['parent','leaf','parentIdentity','directoryIdentity'])
  && exact(b,['parent','leaf','parentIdentity','directoryIdentity']) && a.parent===b.parent && a.leaf===b.leaf
  && sameIdentity(a.parentIdentity,b.parentIdentity)
  && (a.directoryIdentity===null && b.directoryIdentity===null || sameIdentity(a.directoryIdentity,b.directoryIdentity));
function nativeComponent(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 255
    && /^[\x20-\x7e]+$/.test(value) && !/[<>:"/\\|?*~]/.test(value)
    && !['.', '..'].includes(value) && !/[. ]$/.test(value)
    && !/^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value);
}
function nativeRoot(value) {
  if (typeof value !== 'string' || value.length > 512 || !/^[A-Za-z]:[\\/]/.test(value)) return false;
  const parts = value.length > 3 ? value.slice(3).split(/[\\/]/) : [];
  return parts.length <= 32 && parts.every(nativeComponent);
}
function archiveValue(bytes, request) {
  // Copy byte inputs without invoking caller getters or accepting shared memory.
  const typed = Object.getPrototypeOf(Uint8Array.prototype);
  let copy;
  try {
    need(isUint8Array(bytes), 'INVALID_ARCHIVE');
    const size = Object.getOwnPropertyDescriptor(typed, 'byteLength').get.call(bytes);
    const backing = Object.getOwnPropertyDescriptor(typed, 'buffer').get.call(bytes);
    need(size <= 8192 && !isSharedArrayBuffer(backing), 'INVALID_ARCHIVE');
    copy = new Uint8Array(size); Uint8Array.prototype.set.call(copy, bytes);
  } catch {throw Error('OWNED_ZIP_WORKER_INVALID_ARCHIVE');}
  const value = strict.parseStrictJSON(copy, {maxBytes: 8192, maxDepth: 4, maxTokens: 100});
  need(exact(value, ['parent', 'parentIdentity', 'leaf', 'identity', 'bytes', 'sha256'])
    && nativeRoot(value.parent)
    && nativeIdentity(value.parentIdentity) && nativeIdentity(value.identity)
    && value.leaf === request.plan.package.fileName && value.bytes === request.plan.package.bytes
    && value.sha256 === request.plan.package.sha256, 'INVALID_ARCHIVE');
  return value;
}

export function createOwnedZipWorker(requestBytes, archiveBindingBytes) {
  return createWorker(requestBytes, archiveBindingBytes, false);
}
export function createOwnedStagingZipWorker(requestBytes, archiveBindingBytes) {
  return createWorker(requestBytes, archiveBindingBytes, true);
}
function createWorker(requestBytes, archiveBindingBytes, staging) {
  const request = dispatch.parseDispatchRequest(requestBytes);
  if (staging) {
    const identifier = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(value)
      && !['__proto__','constructor','prototype'].includes(value.toLowerCase());
    need(identifier(request.plan.package.expectedModId) && identifier(request.plan.package.downloadId), 'UNSUPPORTED_REGISTRATION_ID');
  }
  need(Object.keys(request.plan.package.payload).every(name => /^[A-Za-z0-9_./ -]+$/.test(name)
    && name.split('/').length <= 32 && name.split('/').every(nativeComponent)), 'UNSUPPORTED_PAYLOAD');
  const requestSHA256 = dispatch.dispatchRequestDigest(Buffer.from(JSON.stringify(request)));
  const archive = archiveValue(archiveBindingBytes, request);
  const binding = Object.freeze({operationId: request.operationId, nativeJobId: request.nativeJobId,
    requestSHA256, rendererGeneration: request.rendererGeneration});
  const bindingEqual = value => exact(value, Object.keys(binding)) && Object.keys(binding).every(k => value[k] === binding[k]);
  const workRoot = path.join(WORK_BASE, request.operationId);
  const payloadFiles = Object.keys(request.plan.package.payload).length;
  let child = null, ready = null, inertLifetime = null, expectedSources = null, startAttempted = false, startSent = false;
  let handoffAttempted = false, cancelAttempted = false, releaseAttempted = false;
  let childClosed = false, packetSHA256 = null, last = null, firstError = null, sequence = 0;
  let pending = Buffer.alloc(0), stderrBytes = 0;
  let writing = false;
  let terminal = null, destination = null, copiedProof = null;
  let outbound = [];
  const seen = new Set(), waiters = new Set();
  const journal = createNativeExecutorJournal();
  let owner;
  function error(code) {const e = Error('OWNED_ZIP_WORKER_'+code); e.owner = owner; return e;}
  function status() {
    return structuredClone({schema: 'owned-zip-coordinator-status/1', binding, packetSHA256,
      workerLifetime: ready?.workerLifetime ?? null, workerPid: child?.pid ?? null,
      creationTime: ready?.creationTime ?? null, startAttempted, startSent, handoffAttempted,
      cancelAttempted, releaseAttempted, childClosed, phase: last?.phase ?? (ready ? 'ready' : 'not_started'),
      childExitCode: child?.exitCode ?? null, childSignal: child?.signalCode ?? null,
      worker: last, destination: last?.destination ?? (destination ? {...destination, directoryIdentity:null} : null),
      copyProof: last?.copyProof ?? null, workerTerminal: terminal?.read() ?? null,
      errorCode: firstError, stderrObserved: stderrBytes > 0,
      effectsAllowed: false, nativeInstallAccepted: false, powerLossPersistenceVerified: false});
  }
  function terminalClosed() {return terminal?.read().childResourcesClosed === true;}
  function observed(phase) {return seen.has(phase) && (phase !== 'closed' || terminalClosed());}
  function wake() {
    if (childClosed && terminalClosed() && occupied === owner) occupied = null;
    for (const item of [...waiters]) {
      if (observed(item.phase)) {clearTimeout(item.timer); waiters.delete(item); item.resolve(status());}
      else if ((childClosed || firstError) && item.phase !== 'closed') {clearTimeout(item.timer); waiters.delete(item); item.reject(error(firstError || 'WORKER_CLOSED'));}
      else if (['held','cancelled'].includes(last?.phase) && !['held','cancelled','released','closed'].includes(item.phase)) {
        clearTimeout(item.timer); waiters.delete(item); item.reject(error(last.errorCode || 'WORKER_STOPPED'));
      }
    }
  }
  function fail(code) {firstError ||= code; wake();}
  function wait(phase, timeoutMs = 30000) {
    need(['ready', 'accepted', 'closed', 'destination_prepared', ...PHASES].includes(phase) && Number.isSafeInteger(timeoutMs)
      && timeoutMs > 0 && timeoutMs <= 120000, 'INVALID_OBSERVATION');
    if (observed(phase)) return Promise.resolve(status());
    if ((childClosed || firstError) && phase !== 'closed') return Promise.reject(error(firstError || 'WORKER_CLOSED'));
    if (['held','cancelled'].includes(last?.phase) && !['held','cancelled','released','closed'].includes(phase))
      return Promise.reject(error(last.errorCode || 'WORKER_STOPPED'));
    need(waiters.size < 8, 'OBSERVER_CAPACITY');
    return new Promise((resolve, reject) => {
      const item = {phase, resolve, reject, timer: null};
      item.timer = setTimeout(() => {waiters.delete(item); reject(error('OBSERVATION_TIMEOUT'));}, timeoutMs);
      waiters.add(item);
    });
  }
  function frame(value) {
    if (!ready) {
      if (value?.schema === 'owned-zip-worker-ready/1' && value.pid === child.pid && label(value.workerLifetime, 'worker'))
        inertLifetime = value.workerLifetime; // Abort-only; never authorizes start.
      need(exact(value, ['schema', 'workerLifetime', 'pid', 'creationTime', 'sourceSHA256',
        'runtimeSHA256', 'pythonVersion', 'zlibOrigin', 'zlibVersion'])
        && value.schema === 'owned-zip-worker-ready/1' && label(value.workerLifetime, 'worker')
        && value.pid === child.pid && typeof value.creationTime === 'string'
        && /^[1-9][0-9]{0,19}$/.test(value.creationTime) && BigInt(value.creationTime) < 2n**64n
        && JSON.stringify(value.pythonVersion) === '[3,14,8]'
        && value.zlibOrigin === 'built-in' && value.zlibVersion === '1.3.1.zlib-ng'
        && exact(value.runtimeSHA256, Object.keys(RUNTIME))
        && Object.keys(RUNTIME).every(k => value.runtimeSHA256[k] === RUNTIME[k])
        && exact(value.sourceSHA256, SOURCES)
        && SOURCES.every(k => value.sourceSHA256[k] === expectedSources[k]), 'READY_MISMATCH');
      need(JSON.stringify(sources()) === JSON.stringify(expectedSources), 'SOURCE_CHANGED');
      ready = value; seen.add('ready'); wake(); return;
    }
    if (value?.schema === 'owned-zip-worker-destination/1') {
      need(staging && !startSent && destination === null
        && exact(value, ['schema','workerLifetime','binding','destination','effectsAllowed','nativeInstallAccepted'])
        && value.workerLifetime === ready.workerLifetime && bindingEqual(value.binding)
        && value.effectsAllowed === false && value.nativeInstallAccepted === false
        && exact(value.destination,['parent','leaf','parentIdentity'])
        && nativeIdentity(value.destination.parentIdentity)
        && path.resolve(value.destination.parent).toLowerCase() === path.resolve(request.plan.context.stagingPath).toLowerCase()
        && value.destination.leaf === request.plan.package.expectedModId, 'DESTINATION_MISMATCH');
      destination = value.destination; seen.add('destination_prepared'); wake(); return;
    }
    const preparingHeld = staging && !startSent && value?.phase === 'held' && value.packetSHA256 === null;
    need((startSent || preparingHeld) && exact(value, ['schema', 'workerLifetime', 'binding', 'packetSHA256', 'sequence',
      'phase', 'zipStatus', 'copiedFiles', 'workRoot', 'errorCode', 'effectsAllowed', 'nativeInstallAccepted', 'persistenceVerified',
      ...(staging ? ['destination','copyProof'] : [])])
      && value.schema === (staging ? 'owned-zip-worker-status/2' : 'owned-zip-worker-status/1') && value.workerLifetime === ready.workerLifetime
      && bindingEqual(value.binding) && value.packetSHA256 === packetSHA256
      && Number.isSafeInteger(value.sequence) && value.sequence > sequence && PHASES.has(value.phase)
      && Number.isSafeInteger(value.copiedFiles) && value.copiedFiles >= 0 && value.copiedFiles <= payloadFiles
      && (value.workRoot === null || typeof value.workRoot === 'string' && path.resolve(value.workRoot) === workRoot)
      && finiteCode(value.errorCode) && value.effectsAllowed === false
      && value.nativeInstallAccepted === false && value.persistenceVerified === false, 'STATUS_MISMATCH');
    if (staging) {
      need(value.destination === null ? preparingHeld : exact(value.destination,['parent','leaf','parentIdentity','directoryIdentity'])
        && destination !== null && value.destination.parent === destination.parent && value.destination.leaf === destination.leaf
        && sameIdentity(value.destination.parentIdentity,destination.parentIdentity)
        && (value.destination.directoryIdentity === null || nativeIdentity(value.destination.directoryIdentity)), 'DESTINATION_MISMATCH');
      need(value.copyProof === null || exact(value.copyProof,['identity','bytes','sha256','files','totalBytes'])
        && nativeIdentity(value.copyProof.identity) && Number.isSafeInteger(value.copyProof.bytes) && value.copyProof.bytes > 0
        && value.copyProof.bytes <= 4*1024*1024 && typeof value.copyProof.sha256==='string' && /^[a-f0-9]{64}$/.test(value.copyProof.sha256)
        && value.copyProof.files === payloadFiles && value.copyProof.totalBytes === request.plan.package.expectedUncompressedBytes, 'COPY_PROOF_MISMATCH');
    }
    const zip = value.zipStatus;
    need(zip === null || exact(zip, ['backend', 'startAttempted', 'started', 'completed', 'cancelled', 'poisoned',
      'closed', 'errorCode', 'binding', 'createdFiles', 'verifiedFiles', 'writtenBytes', 'effectsAllowed', 'nativeInstallAccepted', 'persistenceVerified'])
      && zip.backend === 'zip' && bindingEqual(zip.binding) && finiteCode(zip.errorCode)
      && ['startAttempted','started','completed','cancelled','poisoned','closed'].every(k => typeof zip[k] === 'boolean')
      && ['createdFiles','verifiedFiles','writtenBytes'].every(k => Number.isSafeInteger(zip[k]) && zip[k] >= 0)
      && zip.createdFiles <= payloadFiles && zip.verifiedFiles <= zip.createdFiles
      && zip.writtenBytes <= request.plan.package.expectedUncompressedBytes
      && zip.effectsAllowed === false && zip.nativeInstallAccepted === false && zip.persistenceVerified === false, 'ZIP_STATUS_MISMATCH');
    if (['extracted','copying','copied'].includes(value.phase)) need(zip?.completed && zip.closed
      && !zip.poisoned && !zip.cancelled && zip.createdFiles === payloadFiles
      && zip.verifiedFiles === payloadFiles && zip.writtenBytes === request.plan.package.expectedUncompressedBytes
      && value.workRoot !== null, 'COMPLETION_MISMATCH');
    if (['copying','copied'].includes(value.phase)) need(handoffAttempted, 'UNREQUESTED_HANDOFF');
    if (value.phase === 'released') need(releaseAttempted, 'UNREQUESTED_RELEASE');
    if (value.phase === 'copied') {
      need(value.copiedFiles === payloadFiles, 'COPY_COUNT_MISMATCH');
      if (staging && copiedProof === null) copiedProof = readCopyProof(value);
    }
    sequence = value.sequence; last = value; if (startSent) seen.add('accepted'); seen.add(value.phase); wake();
  }

  function readCopyProof(value) {
    const meta = value.copyProof;
    need(meta !== null && nativeIdentity(value.destination?.directoryIdentity), 'COPY_PROOF_MISMATCH');
    const ancestors = scopeIO.ancestry(workRoot); need(ancestors, 'COPY_PROOF_MISMATCH');
    const file = path.join(workRoot,'CopyProof.json'), before = fs.lstatSync(file,{bigint:true});
    need(before.isFile() && !before.isSymbolicLink() && before.nlink === 1n && before.size === BigInt(meta.bytes), 'COPY_PROOF_MISMATCH');
    const fd = fs.openSync(file,'r'); let raw;
    try {
      need(generation(fs.fstatSync(fd,{bigint:true})) === generation(before), 'COPY_PROOF_CHANGED');
      const buffer = Buffer.alloc(meta.bytes+1); let used = 0;
      while (used < buffer.length) {const n=fs.readSync(fd,buffer,used,Math.min(65536,buffer.length-used),used); if (n===0) break; used+=n;}
      need(used === meta.bytes && generation(fs.fstatSync(fd,{bigint:true})) === generation(before)
        && generation(fs.lstatSync(file,{bigint:true})) === generation(before), 'COPY_PROOF_CHANGED');
      raw=buffer.subarray(0,used); need(sha(raw)===meta.sha256,'COPY_PROOF_CHANGED');
    } finally {fs.closeSync(fd);}
    const proof = strict.parseStrictJSON(raw,{maxBytes:4*1024*1024,maxDepth:10,maxTokens:200000});
    need(exact(proof,['schema','workerLifetime','binding','packetSHA256','destination','files','copiedFiles','totalBytes','effectsAllowed','nativeInstallAccepted','persistenceVerified'])
      && proof.schema==='owned-zip-copy-proof/1' && proof.workerLifetime===ready.workerLifetime && bindingEqual(proof.binding)
      && proof.packetSHA256===packetSHA256 && sameDestination(proof.destination,value.destination)
      && proof.copiedFiles===payloadFiles && proof.totalBytes===request.plan.package.expectedUncompressedBytes
      && proof.effectsAllowed===false && proof.nativeInstallAccepted===false && proof.persistenceVerified===false
      && Array.isArray(proof.files) && proof.files.length===payloadFiles,'COPY_PROOF_MISMATCH');
    const names=Object.keys(request.plan.package.payload).sort(), ids=new Set(); let total=0;
    for (const [index,row] of proof.files.entries()) {
      need(exact(row,['path','bytes','sha256','sourceIdentity','destinationIdentity']) && row.path===names[index]
        && row.sha256===request.plan.package.payload[row.path] && Number.isSafeInteger(row.bytes) && row.bytes>=0
        && nativeIdentity(row.sourceIdentity) && nativeIdentity(row.destinationIdentity), 'COPY_PROOF_MISMATCH');
      const id=row.destinationIdentity.volumeSerialNumber+':'+row.destinationIdentity.fileId;
      need(!ids.has(id),'COPY_PROOF_MISMATCH'); ids.add(id); total+=row.bytes;
    }
    need(total===proof.totalBytes,'COPY_PROOF_MISMATCH'); scopeIO.sameAncestry(workRoot,ancestors);
    return proof;
  }
  function data(bytes) {
    if (firstError) return;
    try {
      pending = Buffer.concat([pending, bytes]);
      let at;
      while ((at = pending.indexOf(10)) !== -1) {
        need(at > 0 && at <= FRAME_MAX, 'FRAME_LIMIT');
        const raw = pending.subarray(0, at); pending = pending.subarray(at+1);
        frame(strict.parseStrictJSON(raw, {maxBytes: FRAME_MAX, maxDepth: 8, maxTokens: 1024}));
      }
      need(pending.length <= FRAME_MAX, 'FRAME_LIMIT');
    } catch (e) {fail(/^OWNED_ZIP_WORKER_([A-Z_]+)$/.exec(e?.message || '')?.[1] || 'PROTOCOL_FAILED');}
  }
  function flush() {
    if (writing || outbound.length === 0 || childClosed) return;
    const next = outbound.shift(); writing = true;
    try {
      child.stdin.write(next.bytes, e => {
        writing = false;
        if (e) {fail('CONTROL_WRITE_FAILED'); return;}
        flush();
      });
    } catch {writing = false; fail('CONTROL_WRITE_FAILED');}
  }
  function write(value, max, command = null) {
    need(child && !childClosed && child.stdin.writable, 'CONTROL_CLOSED');
    const bytes = Buffer.from(JSON.stringify(value)+'\n');
    need(bytes.length <= max && outbound.length < 3, 'CONTROL_CAPACITY');
    // There are only three one-shot control methods. Buffering START must not
    // swallow cancellation after its sticky reservation. Never resend a write.
    if (command === 'cancel') {
      outbound = outbound.filter(row => row.command !== 'handoff');
      const at = outbound.findIndex(row => row.command === 'release');
      outbound.splice(at < 0 ? outbound.length : at, 0, {bytes, command});
    } else outbound.push({bytes, command});
    flush();
  }
  function control(command) {
    need(ready && startSent, 'NOT_STARTED');
    write({schema: 'owned-zip-worker-control/1', workerLifetime: ready.workerLifetime, binding, command}, 4096, command);
  }
  owner = Object.freeze({
    status,
    waitFor: wait,
    async start() {
      need(!startAttempted && !cancelAttempted && !releaseAttempted && occupied === null, 'START_REFUSED');
      startAttempted = true; occupied = owner;
      try {
        runtime(); expectedSources = sources();
        child = spawn(PYTHON, ['-I', '-S', '-B', path.join(HERE, 'owned-zip-worker.py')], {
          cwd: HERE, env: {SystemRoot: process.env.SystemRoot}, windowsHide: true, stdio: ['pipe','pipe','pipe'],
        });
        terminal = childTerminal.observeChildTerminal(child,binding);
        for (const stream of [child.stdin,child.stdout,child.stderr]) stream.on('close',wake);
        child.stdout.on('data', data);
        child.stderr.on('data', bytes => {stderrBytes = Math.min(8193, stderrBytes+bytes.length); if (stderrBytes > 8192) fail('STDERR_LIMIT');});
        child.stdin.on('error', () => {if (!releaseAttempted) fail('CONTROL_CLOSED');});
        child.on('error', () => fail('SPAWN_FAILED'));
        child.on('close', (code, signal) => {
          childClosed = true; outbound = []; seen.add('closed'); if (occupied === owner && terminalClosed()) occupied = null;
          if (pending.length) firstError ||= 'TRUNCATED_FRAME';
          if (startSent && !seen.has('released')) firstError ||= 'CUSTODY_LOST';
          if (seen.has('released') && (code !== 0 || signal !== null)) firstError ||= 'RELEASE_EXIT_FAILED';
          wake();
        });
        await wait('ready');
        if (staging && !cancelAttempted && !releaseAttempted) {
          const stage = request.plan.context.stagingPath;
          const check = () => {
            need(scopeIO.ancestry(stage), 'STAGING_CONTEXT_CHANGED');
            const stat=fs.lstatSync(stage,{bigint:true});
            need(stat.isDirectory() && !stat.isSymbolicLink()
              && `${stat.dev}:${stat.ino}`===request.plan.context.filesystemIds.stagingPath,'STAGING_CONTEXT_CHANGED');
          };
          check();
          write({schema:'owned-zip-worker-prepare-destination/1',workerLifetime:ready.workerLifetime,binding,
            destination:{parent:stage,leaf:request.plan.package.expectedModId}},4096);
          await wait('destination_prepared'); check();
        }
        if (cancelAttempted || releaseAttempted) {
          releaseAttempted = true;
          write({schema: 'owned-zip-worker-abort/1', workerLifetime: ready.workerLifetime}, 4096);
          await wait('closed'); throw error('CANCELLED_BEFORE_START');
        }
        const packet = {schema: staging ? 'owned-zip-worker-start/2' : 'owned-zip-worker-start/1', workerLifetime: ready.workerLifetime,
          binding, archive, payload: request.plan.package.payload, total: request.plan.package.expectedUncompressedBytes,
          ...(staging ? {destination} : {})};
        const bytes = Buffer.from(JSON.stringify(packet)); need(bytes.length+1 <= START_MAX, 'START_LIMIT');
        packetSHA256 = sha(bytes);
        const held = journal.begin(Buffer.from(JSON.stringify(request)), ready.workerLifetime, packetSHA256);
        need(held.state === 'reserved' && held.workerLifetime === ready.workerLifetime && held.packetSHA256 === packetSHA256, 'JOURNAL_NOT_BOUND');
        // Read-only preflight. Only the child may create these directories,
        // relative to retained native parent handles rather than a raced path.
        scopeIO.ancestry(WORK_BASE);
        startSent = true; write(packet, START_MAX);
        return await wait('accepted');
      } catch (e) {
        if (!child) {if (occupied === owner) occupied = null;}
        e.owner = owner; throw e;
      }
    },
    copyProof() {
      const observation = terminal?.read();
      need(staging && copiedProof !== null && !childClosed && !firstError && last?.phase==='copied'
        && !cancelAttempted && !releaseAttempted && observation?.spawnObserved
        && !observation.exitObserved && !observation.closeObserved && !observation.childErrorObserved
        && !observation.held, 'COPY_PROOF_UNAVAILABLE');
      return structuredClone(copiedProof);
    },
    cancel() {
      need(!releaseAttempted, 'RELEASE_PENDING');
      if (!startSent) {cancelAttempted = true; return Promise.resolve(status());}
      if (!cancelAttempted) {cancelAttempted = true; control('cancel');}
      return wait('cancelled');
    },
    handoff() {
      need(!handoffAttempted && !cancelAttempted && !releaseAttempted && !firstError
        && last?.phase === 'extracted', 'HANDOFF_REFUSED');
      handoffAttempted = true; control('handoff'); return wait('copied');
    },
    async release() {
      if (childClosed && seen.has('released')) return await wait('closed');
      if (!startSent) {
        if (!startAttempted) {releaseAttempted = true; return status();}
        if (childClosed) return await wait('closed');
        if (!ready && inertLifetime) {
          if (!releaseAttempted) {
            releaseAttempted = true;
            write({schema: 'owned-zip-worker-abort/1', workerLifetime: inertLifetime}, 4096);
          }
          return await wait('closed');
        }
        if (!ready && child && !childClosed) {releaseAttempted = true; return await wait('closed');}
        need(ready && child && !childClosed, 'NO_INERT_BINDING');
        if (!releaseAttempted) {
          releaseAttempted = true;
          write({schema: 'owned-zip-worker-abort/1', workerLifetime: ready.workerLifetime}, 4096);
        }
        return await wait('closed');
      }
      need(['extracted','copied','cancelled','held'].includes(last?.phase)
        && (last?.phase !== 'held' || cancelAttempted)
        && (!handoffAttempted || seen.has('copied') || ['cancelled','held'].includes(last?.phase)), 'RELEASE_REFUSED');
      if (!releaseAttempted) {releaseAttempted = true; control('release');}
      await wait('released'); child.stdin.end();
      const closed=await wait('closed'); need(closed.workerTerminal?.exitSucceeded===true,'RELEASE_EXIT_FAILED'); return closed;
    },
    async retireInert() {
      // Explicit retirement of this exact child only. Once start was attempted
      // on the pipe, even a lost acknowledgement permanently forbids this route.
      need(!startSent && !handoffAttempted, 'RETIRE_ACTIVE_REFUSED');
      releaseAttempted = true;
      if (!child) return status();
      if (childClosed) return await wait('closed');
      need(expectedSources !== null && child.kill('SIGTERM'), 'INERT_RETIRE_FAILED');
      return await wait('closed');
    },
    inspectIntent() {
      need(packetSHA256, 'NO_INTENT_BINDING');
      return journal.read(binding.operationId, requestSHA256, binding.nativeJobId, packetSHA256);
    },
  });
  return owner;
}
