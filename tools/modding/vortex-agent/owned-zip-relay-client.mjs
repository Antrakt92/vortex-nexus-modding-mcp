// Internal fixed standalone-Node relay. No MCP dispatch or executable/options seam.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isUint8Array, isSharedArrayBuffer, isProxy } from 'node:util/types';
import strict from './strict-json.cjs';
import dispatch from './native-dispatch-contract.cjs';
import paths from './paths-core.cjs';
import terminal from './child-terminal-observer.cjs';
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const RELAY_NODE = 'C:/Program Files/nodejs/node.exe';
export const RELAY_NODE_SHA256 = '5c976096e04e5c2c1f091938926234cc9fbebfe9787ddd149351b3b0ecc707b5';
export const RELAY_SOURCE_NAMES = Object.freeze([
    'owned-zip-relay-client.mjs', 'owned-zip-relay-runner.mjs', 'child-terminal-observer.cjs',
    'owned-zip-worker-client.mjs', 'owned-zip-worker.py', 'owned-file-transfer.py', 'owned-zip-extractor.py', 'native-executor-journal.mjs',
    'native-intent-journal.mjs', 'immutable-records.mjs', 'paths.cjs', 'paths-core.cjs', 'native-dispatch-contract.cjs', 'install-job-contract.cjs', 'strict-json.cjs'
]);
const MAX_START = 2 * 1024 * 1024 + 32768, MAX_STATUS = 65536, MAX_PROOF = 4 * 1024 * 1024 + 16384;
const PHASES = new Set([
    'starting', 'extracting', 'extracted', 'copying', 'copied', 'cancelled', 'held', 'releasing', 'released'
]);
const need = (v, c) => {
    if (!v)
        throw Error('OWNED_ZIP_RELAY_' + c);
};
const exact = (v, k) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === k.length && k.every(n => Object.hasOwn(v, n));
const digest = b => crypto.createHash('sha256').update(b).digest('hex');
const equal = (a, b) => isDeepStrictEqual(a, b);
const code = v => v === null || typeof v === 'string' && /^[A-Z][A-Z0-9_]{0,99}$/.test(v);
const label = (v, p) => typeof v === 'string' && new RegExp('^' + p + '_[a-f0-9]{32}$').test(v);
const generation = s => [
    'dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'nlink'
].map(k => String(s[k])).join(':');
function ancestry(file) {
    const rows = [];
    for (let p = path.dirname(path.resolve(file));; p = path.dirname(p)) {
        const s = fs.lstatSync(p, {
            bigint: true
        });
        need(s.isDirectory() && !s.isSymbolicLink(), 'UNSAFE_SOURCE');
        rows.push([p, generation(s)]);
        if (p === path.dirname(p))
            return rows;
    }
}
function hashFile(file, max) {
    const dirs = ancestry(file), before = fs.lstatSync(file, {
        bigint: true
    });
    need(before.isFile() && !before.isSymbolicLink() && before.size > 0n && before.size <= BigInt(max), 'SOURCE_LIMIT');
    const stamp = generation(before), fd = fs.openSync(file, 'r');
    try {
        need(generation(fs.fstatSync(fd, {
            bigint: true
        })) === stamp, 'SOURCE_CHANGED');
        const h = crypto.createHash('sha256'), chunk = Buffer.alloc(65536), size = Number(before.size);
        let n = 0;
        while (n <= size) {
            const got = fs.readSync(fd, chunk, 0, Math.min(chunk.length, size + 1 - n), n);
            if (got === 0)
                break;
            n += got;
            need(n <= size, 'SOURCE_CHANGED');
            h.update(chunk.subarray(0, got));
        }
        need(n === size && generation(fs.fstatSync(fd, {
            bigint: true
        })) === stamp && generation(fs.lstatSync(file, {
            bigint: true
        })) === stamp, 'SOURCE_CHANGED');
        need(equal(ancestry(file), dirs), 'SOURCE_CHANGED');
        return {
            hash: h.digest('hex'), stamp, dirs
        };
    }
    finally {
        fs.closeSync(fd);
    }
}
/** Point observations of the exact physical closure, not an OS source lease/admission. */
export function readRelaySourceClosure() {
    const result = {}, rows = [];
    for (const name of RELAY_SOURCE_NAMES) {
        const file = path.join(HERE, name), r = hashFile(file, 512 * 1024);
        result[name] = r.hash;
        rows.push([file, r]);
    }
    for (const [file, r] of rows)
        need(generation(fs.lstatSync(file, {
            bigint: true
        })) === r.stamp, 'SOURCE_CHANGED');
    for (const [file, r] of rows)
        need(equal(ancestry(file), r.dirs), 'SOURCE_CHANGED');
    return Object.freeze(result);
}
export function verifyRelayNode() {
    need(process.platform === 'win32' && process.arch === 'x64', 'UNSUPPORTED_RUNTIME');
    need(hashFile(RELAY_NODE, 128 * 1024 * 1024).hash === RELAY_NODE_SHA256, 'NODE_SOURCE_MISMATCH');
    return RELAY_NODE_SHA256;
}
function bytesCopy(value, max) {
    try {
        need(isUint8Array(value) && !isProxy(value), 'REQUEST');
        const typed = Object.getPrototypeOf(Uint8Array.prototype), n = Object.getOwnPropertyDescriptor(typed, 'byteLength').get.call(value), backing = Object.getOwnPropertyDescriptor(typed, 'buffer').get.call(value);
        need(n > 0 && n <= max && !isSharedArrayBuffer(backing), 'REQUEST');
        const copy = new Uint8Array(n);
        Uint8Array.prototype.set.call(copy, value);
        return Buffer.from(copy);
    }
    catch {
        throw Error('OWNED_ZIP_RELAY_REQUEST');
    }
}
export function validateRelayWorkerTerminal(value, binding) {
    if (value === null)
        return;
    need(exact(value, [
        'schema', 'binding', 'spawnObserved', 'exitObserved', 'closeObserved', 'childErrorObserved', 'childErrorCode', 'exitCode', 'exitSignal', 'closeCode', 'closeSignal', 'pipes', 'childResourcesClosed', 'held', 'reasonCode', 'outcome', 'exitSucceeded', 'nativeInstallAccepted', 'persistenceVerified', 'descendantsVerified'
    ]) && value.schema === 'child-terminal-observation/1' && equal(value.binding, binding), 'WORKER_TERMINAL');
    for (const k of [
        'spawnObserved', 'exitObserved', 'closeObserved', 'childErrorObserved', 'childResourcesClosed', 'held', 'exitSucceeded'
    ])
        need(typeof value[k] === 'boolean', 'WORKER_TERMINAL');
    for (const k of ['childErrorCode', 'reasonCode'])
        need(code(value[k]), 'WORKER_TERMINAL');
    for (const k of ['exitCode', 'closeCode'])
        need(value[k] === null || Number.isSafeInteger(value[k]) && value[k] >= -2147483648 && value[k] <= 4294967295, 'WORKER_TERMINAL');
    for (const k of ['exitSignal', 'closeSignal'])
        need(value[k] === null || typeof value[k] === 'string' && /^SIG[A-Z0-9]{1,16}$/.test(value[k]), 'WORKER_TERMINAL');
    need(exact(value.pipes, ['stdin', 'stdout', 'stderr']), 'WORKER_TERMINAL');
    for (const p of Object.values(value.pipes))
        need(exact(p, ['closeObserved', 'errorObserved', 'errorCode']) && typeof p.closeObserved === 'boolean' && typeof p.errorObserved === 'boolean' && code(p.errorCode), 'WORKER_TERMINAL');
    need(['pending', 'held', 'exited', 'spawnFailed'].includes(value.outcome) && value.nativeInstallAccepted === false && value.persistenceVerified === false && value.descendantsVerified === false, 'WORKER_TERMINAL');
}
function nativeIdentity(v) {
    return exact(v, ['schema', 'volumeSerialNumber', 'fileId']) && v.schema === 'win-file-id128/1' && [['volumeSerialNumber', 64n], ['fileId', 128n]].every(([key, bits]) => typeof v[key] === 'string' && /^[1-9][0-9]{0,38}$/.test(v[key]) && BigInt(v[key]) < 2n ** bits);
}
export function validateRelaySDKStatus(v, binding, mode = 'scratch') {
    need(exact(v, [
        'schema', 'binding', 'packetSHA256', 'workerLifetime', 'workerPid', 'creationTime', 'startAttempted', 'startSent', 'handoffAttempted', 'cancelAttempted', 'releaseAttempted', 'childClosed', 'phase', 'childExitCode', 'childSignal', 'worker', 'destination', 'copyProof', 'workerTerminal', 'errorCode', 'stderrObserved', 'effectsAllowed', 'nativeInstallAccepted', 'powerLossPersistenceVerified'
    ]) && v.schema === 'owned-zip-coordinator-status/1' && equal(v.binding, binding), 'SDK_STATUS');
    need(v.packetSHA256 === null || /^[a-f0-9]{64}$/.test(v.packetSHA256), 'SDK_STATUS');
    need(v.workerLifetime === null || label(v.workerLifetime, 'worker'), 'SDK_STATUS');
    need(v.workerPid === null || Number.isSafeInteger(v.workerPid) && v.workerPid > 0, 'SDK_STATUS');
    need(v.creationTime === null || typeof v.creationTime === 'string' && /^[1-9][0-9]{0,19}$/.test(v.creationTime), 'SDK_STATUS');
    for (const k of [
        'startAttempted', 'startSent', 'handoffAttempted', 'cancelAttempted', 'releaseAttempted', 'childClosed', 'stderrObserved'
    ])
        need(typeof v[k] === 'boolean', 'SDK_STATUS');
    need(v.phase !== 'releasing' && ['not_started', 'ready', ...PHASES].includes(v.phase) && code(v.errorCode) && v.effectsAllowed === false && v.nativeInstallAccepted === false && v.powerLossPersistenceVerified === false, 'SDK_STATUS');
    need(v.childExitCode === null || Number.isSafeInteger(v.childExitCode) && v.childExitCode >= -2147483648 && v.childExitCode <= 4294967295, 'SDK_STATUS');
    need(v.childSignal === null || typeof v.childSignal === 'string' && /^SIG[A-Z0-9]{1,16}$/.test(v.childSignal), 'SDK_STATUS');
    validateRelayWorkerTerminal(v.workerTerminal, binding);
    if (v.destination !== null)
        need(mode === 'staging' && exact(v.destination, ['parent', 'leaf', 'parentIdentity', 'directoryIdentity']) && typeof v.destination.parent === 'string' && path.isAbsolute(v.destination.parent) && v.destination.parent.length <= 512 && typeof v.destination.leaf === 'string' && v.destination.leaf.length <= 255 && nativeIdentity(v.destination.parentIdentity) && (v.destination.directoryIdentity === null || nativeIdentity(v.destination.directoryIdentity)), 'SDK_DESTINATION');
    if (v.copyProof !== null)
        need(mode === 'staging' && exact(v.copyProof, ['identity', 'bytes', 'sha256', 'files', 'totalBytes']) && nativeIdentity(v.copyProof.identity) && Number.isSafeInteger(v.copyProof.bytes) && v.copyProof.bytes > 0 && v.copyProof.bytes <= 4 * 1024 * 1024 && typeof v.copyProof.sha256 === 'string' && /^[a-f0-9]{64}$/.test(v.copyProof.sha256) && Number.isSafeInteger(v.copyProof.files) && v.copyProof.files > 0 && Number.isSafeInteger(v.copyProof.totalBytes) && v.copyProof.totalBytes > 0, 'SDK_PROOF');
    if (v.worker !== null) {
        const w = v.worker;
        need(exact(w, [
            'schema', 'workerLifetime', 'binding', 'packetSHA256', 'sequence', 'phase', 'zipStatus', 'copiedFiles', 'workRoot', 'errorCode', 'effectsAllowed', 'nativeInstallAccepted', 'persistenceVerified', ...(mode === 'staging' ? ['destination', 'copyProof'] : [])
        ]) && w.schema === (mode === 'staging' ? 'owned-zip-worker-status/2' : 'owned-zip-worker-status/1') && equal(w.binding, binding) && w.workerLifetime === v.workerLifetime && w.packetSHA256 === v.packetSHA256 && Number.isSafeInteger(w.sequence) && w.sequence > 0 && PHASES.has(w.phase) && Number.isSafeInteger(w.copiedFiles) && w.copiedFiles >= 0 && (w.workRoot === null || typeof w.workRoot === 'string' && path.isAbsolute(w.workRoot) && w.workRoot.length <= 4096) && code(w.errorCode) && w.effectsAllowed === false && w.nativeInstallAccepted === false && w.persistenceVerified === false, 'SDK_STATUS');
        if (mode === 'staging')
            need(equal(w.destination, v.destination) && equal(w.copyProof, v.copyProof), 'SDK_STATUS');
        const z = w.zipStatus;
        if (z !== null) {
            need(exact(z, [
                'backend', 'startAttempted', 'started', 'completed', 'cancelled', 'poisoned', 'closed', 'errorCode', 'binding', 'createdFiles', 'verifiedFiles', 'writtenBytes', 'effectsAllowed', 'nativeInstallAccepted', 'persistenceVerified'
            ]) && z.backend === 'zip' && equal(z.binding, binding) && code(z.errorCode) && z.effectsAllowed === false && z.nativeInstallAccepted === false && z.persistenceVerified === false, 'SDK_STATUS');
            for (const key of [
                'startAttempted', 'started', 'completed', 'cancelled', 'poisoned', 'closed'
            ])
                need(typeof z[key] === 'boolean', 'SDK_STATUS');
            for (const key of ['createdFiles', 'verifiedFiles', 'writtenBytes'])
                need(Number.isSafeInteger(z[key]) && z[key] >= 0, 'SDK_STATUS');
        }
    }
}
// Python's fixed CopyProof writer uses sort_keys=True, ensure_ascii=True and
// compact separators. Call only for the validated, closed proof schema below.
export function relayCopyProofBytes(proof) {
    const json = JSON.stringify(proof, (_, value) => value && typeof value === 'object' && !Array.isArray(value)
        ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value);
    return Buffer.from(json.replace(/[\u007f-\uffff]/g, character => '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0')), 'utf8');
}
/** Validate only the closed proof projection already produced by the SDK. */
export function validateRelayCopyProof(proof, sdk, request, binding) {
    need(sdk?.phase === 'copied' && sdk.copyProof !== null && sdk.workerTerminal && !sdk.workerTerminal.exitObserved && !sdk.workerTerminal.closeObserved && !sdk.workerTerminal.childErrorObserved && !sdk.workerTerminal.childResourcesClosed && !sdk.workerTerminal.held, 'COPY_PROOF_UNAVAILABLE');
    need(exact(proof, [
        'schema', 'workerLifetime', 'binding', 'packetSHA256', 'destination', 'files', 'copiedFiles', 'totalBytes', 'effectsAllowed', 'nativeInstallAccepted', 'persistenceVerified'
    ]) && proof.schema === 'owned-zip-copy-proof/1' && proof.workerLifetime === sdk.workerLifetime && equal(proof.binding, binding) && proof.packetSHA256 === sdk.packetSHA256 && equal(proof.destination, sdk.destination) && proof.effectsAllowed === false && proof.nativeInstallAccepted === false && proof.persistenceVerified === false, 'COPY_PROOF_MISMATCH');
    const names = Object.keys(request.plan.package.payload).sort(), ids = new Set();
    let total = 0;
    need(Array.isArray(proof.files) && proof.files.length === names.length && proof.copiedFiles === names.length && proof.totalBytes === request.plan.package.expectedUncompressedBytes && proof.totalBytes === sdk.copyProof.totalBytes && sdk.copyProof.files === names.length, 'COPY_PROOF_MISMATCH');
    for (const [i, row] of proof.files.entries()) {
        need(exact(row, ['path', 'bytes', 'sha256', 'sourceIdentity', 'destinationIdentity']) && row.path === names[i] && row.sha256 === request.plan.package.payload[row.path] && Number.isSafeInteger(row.bytes) && row.bytes >= 0 && nativeIdentity(row.sourceIdentity) && nativeIdentity(row.destinationIdentity), 'COPY_PROOF_MISMATCH');
        const id = row.destinationIdentity.volumeSerialNumber + ':' + row.destinationIdentity.fileId;
        need(!ids.has(id), 'COPY_PROOF_MISMATCH');
        ids.add(id);
        total += row.bytes;
        need(Number.isSafeInteger(total), 'COPY_PROOF_MISMATCH');
    }
    need(total === proof.totalBytes, 'COPY_PROOF_MISMATCH');
    const canonical = relayCopyProofBytes(proof);
    need(canonical.length <= 4 * 1024 * 1024 && canonical.length === sdk.copyProof.bytes && digest(canonical) === sdk.copyProof.sha256, 'COPY_PROOF_DIGEST_MISMATCH');
}
export function validateRelayPreparedReceipt(value, binding, anchor) {
    need(exact(value, ['schema', 'binding', 'workerLifetime', 'workerPid', 'creationTime', 'packetSHA256', 'transition']) && value.schema === 'owned-zip-worker-prepared/1' && equal(value.binding, binding)
        && label(value.workerLifetime, 'worker') && Number.isSafeInteger(value.workerPid) && value.workerPid > 0 && typeof value.creationTime === 'string' && /^[1-9][0-9]{0,19}$/.test(value.creationTime)
        && typeof value.packetSHA256 === 'string' && /^[a-f0-9]{64}$/.test(value.packetSHA256), 'PREPARED_MISMATCH');
    const t = value.transition;
    need(exact(t, ['schema', 'rootId', 'previousInventorySHA256', 'inventorySHA256', 'operationId', 'nativeJobId', 'requestSHA256', 'packetSHA256', 'workerLifetime'])
        && t.schema === 'native-executor-pending-transition/1' && t.rootId === anchor.rootId && t.previousInventorySHA256 === anchor.inventorySHA256
        && typeof t.inventorySHA256 === 'string' && /^[a-f0-9]{64}$/.test(t.inventorySHA256)
        && t.operationId === binding.operationId && t.nativeJobId === binding.nativeJobId && t.requestSHA256 === binding.requestSHA256 && t.packetSHA256 === value.packetSHA256 && t.workerLifetime === value.workerLifetime, 'PREPARED_MISMATCH');
}
export function copyRelayAnchor(bytes) {
    const copy = bytesCopy(bytes, 1024), anchor = strict.parseStrictJSON(copy, {
        maxBytes: 1024, maxDepth: 2, maxTokens: 32
    });
    need(exact(anchor, ['schema', 'rootId', 'inventorySHA256']) && anchor.schema === 'native-executor-anchor/1' && typeof anchor.rootId === 'string' && anchor.rootId.length <= 100 && /^[0-9]+:[0-9]+$/.test(anchor.rootId) && typeof anchor.inventorySHA256 === 'string' && /^[a-f0-9]{64}$/.test(anchor.inventorySHA256)
        && Buffer.from(JSON.stringify({
            schema: anchor.schema, rootId: anchor.rootId, inventorySHA256: anchor.inventorySHA256
        })).equals(copy), 'INVALID_ANCHOR');
    return copy;
}
export function validateRelayProofEnvelope(v, lifetime, binding, startSHA256, sequence, nonce) {
    need(exact(v, [
        'schema', 'relayLifetime', 'binding', 'startSHA256', 'sequence', 'nonce', 'proof'
    ]) && v.schema === 'owned-zip-relay-copy-proof/1' && v.relayLifetime === lifetime && equal(v.binding, binding) && v.startSHA256 === startSHA256 && Number.isSafeInteger(v.sequence) && v.sequence > sequence && typeof v.nonce === 'string' && /^[a-f0-9]{32}$/.test(v.nonce) && v.nonce === nonce, 'COPY_PROOF_MISMATCH');
}
export function parseRelayOutput(bytes) {
    need(bytes.byteLength > 0 && bytes.byteLength <= MAX_PROOF, 'FRAME_LIMIT');
    const value = strict.parseStrictJSON(bytes, {
        maxBytes: MAX_PROOF, maxDepth: 24, maxTokens: 200000
    });
    need(value?.schema === 'owned-zip-relay-copy-proof/1' || bytes.byteLength <= MAX_STATUS, 'FRAME_LIMIT');
    return value;
}
const relayInertObservers = new WeakMap();
const relayInertGet = WeakMap.prototype.get;
const relayInertSet = WeakMap.prototype.set;
/** Source-owned observation only. Caller JSON/status/paths cannot create one. */
export function observeRelayInertCancellation(owner) {
    need(arguments.length === 1, 'INERT_CANCELLATION_ARGUMENTS');
    need(owner !== null && typeof owner === 'object' && !isProxy(owner), 'INERT_CANCELLATION_OWNER');
    const observe = Reflect.apply(relayInertGet, relayInertObservers, [owner]);
    need(typeof observe === 'function', 'INERT_CANCELLATION_OWNER');
    return observe();
}
function relayInertClosed(value, binding) {
    validateRelayWorkerTerminal(value, binding);
    need(value !== null && value.spawnObserved === true && value.exitObserved === true
        && value.closeObserved === true && value.childResourcesClosed === true && value.exitSucceeded === true
        && value.childErrorObserved === false && value.childErrorCode === null && value.held === false
        && value.reasonCode === null && value.outcome === 'exited'
        && value.exitCode === 0 && value.closeCode === 0 && value.exitSignal === null && value.closeSignal === null
        && Object.values(value.pipes).every(p => p.closeObserved === true && p.errorObserved === false && p.errorCode === null), 'INERT_CANCELLATION_TERMINAL');
    return Object.freeze({...value,binding:Object.freeze({...value.binding}),pipes:Object.freeze({
        stdin:Object.freeze({...value.pipes.stdin}),stdout:Object.freeze({...value.pipes.stdout}),stderr:Object.freeze({...value.pipes.stderr})})});
}
let occupied = null;
export function snapshotNativeExecutorRuntimeBinding(bytes) {
    const copy = bytesCopy(bytes, 8192);
    const value = strict.parseStrictJSON(copy, { maxBytes: 8192, maxDepth: 3, maxTokens: 200 });
    need(exact(value, ['schema', 'workspaceRoot', 'relayNodeSHA256', 'sourceSHA256'])
        && value.schema === 'native-executor-runtime-binding/1', 'RUNTIME_BINDING');
    need(typeof value.workspaceRoot === 'string' && !/^[\\/]{2}[?.][\\/]/.test(value.workspaceRoot), 'RUNTIME_BINDING');
    const workspaceRoot = paths.absolute(value.workspaceRoot, 'NATIVE_RUNTIME_WORKSPACE').replaceAll('\\', '/');
    need(value.workspaceRoot === workspaceRoot && value.workspaceRoot.trim() === value.workspaceRoot
        && value.relayNodeSHA256 === RELAY_NODE_SHA256
        && exact(value.sourceSHA256, RELAY_SOURCE_NAMES), 'RUNTIME_BINDING');
    const sourceSHA256 = {};
    for (const name of RELAY_SOURCE_NAMES) {
        need(typeof value.sourceSHA256[name] === 'string' && /^[a-f0-9]{64}$/.test(value.sourceSHA256[name]), 'RUNTIME_BINDING');
        sourceSHA256[name] = value.sourceSHA256[name];
    }
    const canonical = { schema: 'native-executor-runtime-binding/1', workspaceRoot,
        relayNodeSHA256: RELAY_NODE_SHA256, sourceSHA256 };
    need(copy.equals(Buffer.from(JSON.stringify(canonical), 'utf8')), 'RUNTIME_BINDING_CANONICAL');
    return Object.freeze({ ...canonical, sourceSHA256: Object.freeze(sourceSHA256) });
}

export function createBoundOwnedZipRelay(requestBytes, archiveBindingBytes, runtimeBindingBytes) {
    const runtime = snapshotNativeExecutorRuntimeBinding(runtimeBindingBytes);
    const normalize = value => {
        const resolved = path.resolve(value).replaceAll('\\', '/');
        return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    };
    need(normalize(HERE) === normalize(path.join(runtime.workspaceRoot, 'tools/modding/vortex-agent')), 'RUNTIME_LAYOUT');
    need(equal(readRelaySourceClosure(), runtime.sourceSHA256), 'RUNTIME_SOURCE');
    return createRelay(requestBytes, archiveBindingBytes, 'staging', runtime);
}

export function createOwnedZipRelay(requestBytes, archiveBindingBytes, mode = 'scratch') {
    return createRelay(requestBytes, archiveBindingBytes, mode, null);
}

function createRelay(requestBytes, archiveBindingBytes, mode, runtime) {
    need(mode === 'scratch' || mode === 'staging', 'MODE');
    const parsed = dispatch.parseDispatchRequest(bytesCopy(requestBytes, 1024 * 1024 + 4096)), requestJSON = JSON.stringify(parsed), requestSHA256 = dispatch.dispatchRequestDigest(Buffer.from(requestJSON));
    const archive = bytesCopy(archiveBindingBytes, 8192);
    strict.parseStrictJSON(archive, {
        maxBytes: 8192, maxDepth: 4, maxTokens: 100
    });
    const archiveJSON = archive.toString('utf8');
    if (mode === 'staging')
        for (const id of [parsed.plan.package.expectedModId, parsed.plan.package.downloadId])
            need(typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(id) && !['__proto__', 'constructor', 'prototype'].includes(id.toLowerCase()), 'STAGING_ID');
    const binding = terminal.copyChildBinding({
        operationId: parsed.operationId, nativeJobId: parsed.nativeJobId, requestSHA256, rendererGeneration: parsed.rendererGeneration
    });
    const workspace = runtime ? paths.absolute(runtime.workspaceRoot, 'NATIVE_RUNTIME_WORKSPACE') : paths.resolvePaths({ sourceDir: HERE,
        compiledWorkspace: typeof __NEXUS_WORKSPACE__ === 'undefined' ? undefined : __NEXUS_WORKSPACE__ }).workspace;
    let child = null, observer = null, ready = null, sources = null, firstError = null, last = null, startAttempted = false, startSent = false, cancelAttempted = false, handoffAttempted = false, releaseAttempted = false, closed = false, controllerEnded = false, sequence = 0, startSHA256 = null, pending = Buffer.alloc(0), stderrBytes = 0, writing = false, outbound = [], protocolBroken = false;
    const seen = new Set(), waiters = new Set();
    let preparedReceipt = null, preparedDigest = null, preparedAnchor = null, prepareNonce = null, explicitPrepare = false, startPreparedAttempted = false;
    let owner, proofFlight = null, proofCache = null, proofNonce = null, proofReceived = false, proofTimedOut = false;
    function proofLive() {
        const sdk = last?.sdk, relay = observer?.read();
        return relay?.spawnObserved === true && !relay.exitObserved && !relay.closeObserved && !relay.childErrorObserved && !relay.held && !relay.childResourcesClosed && mode === 'staging' && !firstError && !cancelAttempted && !releaseAttempted && !closed && sdk?.phase === 'copied' && sdk.workerTerminal && !sdk.workerTerminal.exitObserved && !sdk.workerTerminal.closeObserved && !sdk.workerTerminal.childErrorObserved && !sdk.workerTerminal.childResourcesClosed && !sdk.workerTerminal.held;
    }
    function invalidateProof() {
        proofCache = null;
        if (proofFlight) {
            clearTimeout(proofFlight.timer);
            proofFlight.reject(error('COPY_PROOF_UNAVAILABLE'));
            proofFlight = null;
        }
    }
    function error(c) {
        const e = Error('OWNED_ZIP_RELAY_' + c);
        e.owner = owner;
        return e;
    }
    function status() {
        return structuredClone({
            schema: 'owned-zip-relay-owner-status/1', binding, mode, relayLifetime: ready?.relayLifetime ?? null, relayPid: child?.pid ?? null, startSHA256, startAttempted, startSent, cancelAttempted, handoffAttempted, releaseAttempted, controllerEnded, phase: last?.phase ?? (ready ? 'ready' : 'not_started'), relayTerminal: observer?.read() ?? null, sdk: last?.sdk ?? null, errorCode: firstError, stderrObserved: stderrBytes > 0, effectsAllowed: false, nativeInstallAccepted: false, persistenceVerified: false
        });
    }
    function wake() {
        const physical = observer?.read();
        if (physical?.childResourcesClosed) {
            closed = true;
            seen.add('closed');
            if (occupied === owner)
                occupied = null;
        }
        for (const w of [...waiters]) {
            if (seen.has(w.phase)) {
                clearTimeout(w.timer);
                waiters.delete(w);
                w.resolve(status());
            }
            else if (last && ['held', 'cancelled'].includes(last.phase) && !['closed', 'held', 'cancelled', 'released'].includes(w.phase)) {
                clearTimeout(w.timer);
                waiters.delete(w);
                w.reject(error(firstError ?? 'WORKER_STOPPED'));
            }
            else if (closed || firstError && !['closed', 'held', 'cancelled', 'released'].includes(w.phase)) {
                clearTimeout(w.timer);
                waiters.delete(w);
                w.reject(error(firstError ?? 'RELAY_CLOSED'));
            }
        }
    }
    function fail(c) {
        invalidateProof();
        firstError ??= c;
        protocolBroken = true;
        wake();
    }
    function waitFor(phase, timeoutMs = 30000) {
        need(['ready', 'prepared', 'accepted', 'closed', ...PHASES].includes(phase) && Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 120000, 'OBSERVATION');
        wake();
        if (seen.has(phase))
            return Promise.resolve(status());
        if (closed || firstError && !['closed', 'held', 'cancelled', 'released'].includes(phase))
            return Promise.reject(error(firstError ?? 'RELAY_CLOSED'));
        need(waiters.size < 8, 'OBSERVER_CAPACITY');
        return new Promise((resolve, reject) => {
            const w = {
                phase, resolve, reject, timer: setTimeout(() => {
                    waiters.delete(w);
                    reject(error('OBSERVATION_TIMEOUT'));
                }, timeoutMs)
            };
            waiters.add(w);
        });
    }
    function frame(v) {
        if (ready === null) {
            need(exact(v, [
                'schema', 'relayLifetime', 'pid', 'nodeVersion', 'nodeSHA256', 'sourceSHA256', 'workspace'
            ]) && v.schema === 'owned-zip-relay-ready/1' && label(v.relayLifetime, 'relay') && v.pid === child.pid && v.nodeVersion === '24.20.0' && v.nodeSHA256 === RELAY_NODE_SHA256 && v.workspace === workspace && exact(v.sourceSHA256, RELAY_SOURCE_NAMES) && RELAY_SOURCE_NAMES.every(n => v.sourceSHA256[n] === sources[n]), 'READY_MISMATCH');
            need(equal(readRelaySourceClosure(), sources), 'SOURCE_CHANGED');
            ready = v;
            seen.add('ready');
            wake();
            return;
        }
        if (v.schema === 'owned-zip-relay-prepared/1') {
            need(explicitPrepare && prepareNonce !== null && preparedReceipt === null && exact(v, ['schema', 'relayLifetime', 'binding', 'startSHA256', 'sequence', 'nonce', 'preparedSHA256', 'prepared']) && v.relayLifetime === ready.relayLifetime && equal(v.binding, binding) && v.startSHA256 === startSHA256 && Number.isSafeInteger(v.sequence) && v.sequence > sequence && v.nonce === prepareNonce && digest(Buffer.from(JSON.stringify(v.prepared))) === v.preparedSHA256, 'PREPARED_MISMATCH');
            validateRelayPreparedReceipt(v.prepared, binding, preparedAnchor);
            sequence = v.sequence;
            preparedReceipt = structuredClone(v.prepared);
            preparedDigest = v.preparedSHA256;
            seen.add('prepared');
            wake();
            return;
        }
        if (v.schema === 'owned-zip-relay-copy-proof/1') {
            need(!proofReceived, 'COPY_PROOF_REPLAY');
            validateRelayProofEnvelope(v, ready.relayLifetime, binding, startSHA256, sequence, proofNonce);
            sequence = v.sequence;
            proofReceived = true;
            if (proofLive() && !proofTimedOut) {
                validateRelayCopyProof(v.proof, last.sdk, parsed, binding);
                proofCache = structuredClone(v.proof);
                if (proofFlight) {
                    clearTimeout(proofFlight.timer);
                    proofFlight.resolve(structuredClone(proofCache));
                    proofFlight = null;
                }
            }
            return;
        }
        need(exact(v, [
            'schema', 'relayLifetime', 'binding', 'startSHA256', 'sequence', 'phase', 'accepted', 'sdk', 'controllerEOF', 'errorCode', 'effectsAllowed', 'nativeInstallAccepted', 'persistenceVerified'
        ]) && v.schema === 'owned-zip-relay-status/1' && v.relayLifetime === ready.relayLifetime && equal(v.binding, binding) && v.startSHA256 === startSHA256 && Number.isSafeInteger(v.sequence) && v.sequence > sequence && PHASES.has(v.phase) && typeof v.accepted === 'boolean' && typeof v.controllerEOF === 'boolean' && code(v.errorCode) && v.effectsAllowed === false && v.nativeInstallAccepted === false && v.persistenceVerified === false, 'STATUS_MISMATCH');
        if (v.sdk !== null)
            validateRelaySDKStatus(v.sdk, binding, mode);
        need(!v.accepted || v.sdk?.startSent === true && /^[a-f0-9]{64}$/.test(v.sdk.packetSHA256), 'STATUS_MISMATCH');
        if (mode === 'staging' && v.sdk?.destination)
            need(path.resolve(v.sdk.destination.parent).toLowerCase() === path.resolve(parsed.plan.context.stagingPath).toLowerCase() && v.sdk.destination.leaf === parsed.plan.package.expectedModId, 'SDK_DESTINATION');
        if (v.phase === 'released' && startSent)
            need(releaseAttempted && ((v.sdk?.childClosed && v.sdk.workerTerminal?.childResourcesClosed && v.sdk.workerTerminal.exitSucceeded) || (v.sdk?.startAttempted === false && v.sdk.workerPid === null && v.sdk.workerTerminal === null)), 'RELEASE_MISMATCH');
        sequence = v.sequence;
        last = v;
        if (!proofLive())
            invalidateProof();
        if (v.accepted)
            seen.add('accepted');
        seen.add(v.phase);
        if (v.controllerEOF)
            firstError ??= 'CONTROLLER_EOF';
        if (v.errorCode)
            firstError ??= v.errorCode;
        wake();
    }
    function data(chunk) {
        if (protocolBroken)
            return;
        try {
            need(chunk.length <= MAX_PROOF, 'FRAME_LIMIT');
            pending = Buffer.concat([pending, chunk]);
            let at;
            while ((at = pending.indexOf(10)) !== -1) {
                need(at > 0 && at <= MAX_PROOF, 'FRAME_LIMIT');
                const b = pending.subarray(0, at);
                pending = pending.subarray(at + 1);
                frame(parseRelayOutput(b));
            }
            need(pending.length <= MAX_PROOF, 'FRAME_LIMIT');
        }
        catch (e) {
            fail(/^OWNED_ZIP_RELAY_([A-Z_]+)$/.exec(e?.message ?? '')?.[1] ?? 'PROTOCOL');
        }
    }
    function flush() {
        if (writing || outbound.length === 0 || closed)
            return;
        const b = outbound.shift();
        writing = true;
        try {
            child.stdin.write(b, e => {
                writing = false;
                if (e) {
                    fail('CONTROL_WRITE');
                    return;
                }
                flush();
            });
        }
        catch {
            writing = false;
            fail('CONTROL_WRITE');
        }
    }
    function write(value, max) {
        need(child && !closed && !controllerEnded && child.stdin.writable, 'CONTROL_CLOSED');
        const b = Buffer.from(JSON.stringify(value) + '\n');
        need(b.length <= max && outbound.length < 4, 'CONTROL_CAPACITY');
        outbound.push(b);
        flush();
        return b;
    }
    function control(command) {
        need(ready, 'NOT_READY');
        return write({
            schema: 'owned-zip-relay-control/1', relayLifetime: ready.relayLifetime, binding, command
        }, 4096);
    }
    async function beginRelay(anchorBytes, anchored) {
        need(!startAttempted && !cancelAttempted && !releaseAttempted && occupied === null, 'START_REFUSED');
        startAttempted = true;
        occupied = owner;
        try {
            const anchor = anchored ? copyRelayAnchor(anchorBytes) : null;
            explicitPrepare = anchored;
            preparedAnchor = anchor ? JSON.parse(anchor.toString('utf8')) : null;
            prepareNonce = anchored ? crypto.randomBytes(16).toString('hex') : null;
            verifyRelayNode();
            sources = runtime?.sourceSHA256 ?? readRelaySourceClosure();
            need(equal(readRelaySourceClosure(), sources), 'SOURCE_CHANGED');
            child = spawn(RELAY_NODE, [path.join(HERE, 'owned-zip-relay-runner.mjs')], {
                cwd: HERE, env: {
                    SystemRoot: process.env.SystemRoot, NEXUS_WORKSPACE: workspace
                }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']
            });
            observer = terminal.observeChildTerminal(child, binding);
            child.stdout.on('data', data);
            child.stderr.on('data', b => {
                stderrBytes = Math.min(8193, stderrBytes + b.length);
                if (stderrBytes > 8192)
                    fail('STDERR_LIMIT');
            });
            child.on('error', () => fail('SPAWN_FAILED'));
            child.stdin.on('error', () => {
                if (!releaseAttempted)
                    fail('CONTROL_CLOSED');
            });
            child.on('exit', () => {
                invalidateProof();
                wake();
            });
            child.on('close', () => {
                if (pending.length)
                    firstError ??= 'TRUNCATED_FRAME';
                if (startSent && !seen.has('released'))
                    firstError ??= 'CUSTODY_LOST';
                invalidateProof();
                setImmediate(wake);
            });
            for (const stream of [child.stdin, child.stdout, child.stderr])
                stream.on('close', () => setImmediate(wake));
            await waitFor('ready');
            if (cancelAttempted || releaseAttempted) {
                releaseAttempted = true;
                control('abort');
                await waitFor('released');
                controllerEnded = true;
                child.stdin.end();
                await waitFor('closed');
                throw error('CANCELLED_BEFORE_START');
            }
            need(equal(readRelaySourceClosure(), sources), 'SOURCE_CHANGED');
            const packet = {
                schema: anchored ? 'owned-zip-relay-prepare/1' : 'owned-zip-relay-start/1', relayLifetime: ready.relayLifetime, binding, mode, requestJSON, archiveJSON, ...(anchored ? {
                    anchorJSON: anchor.toString('utf8'), nonce: prepareNonce
                } : {})
            };
            const raw = Buffer.from(JSON.stringify(packet));
            need(raw.length + 1 <= MAX_START, 'START_LIMIT');
            startSHA256 = digest(raw);
            startSent = true;
            write(packet, MAX_START);
            if (anchored) {
                await waitFor('prepared');
                return structuredClone(preparedReceipt);
            }
            return await waitFor('accepted');
        }
        catch (e) {
            if (!child && occupied === owner)
                occupied = null;
            e.owner = owner;
            throw e;
        }
    }
    owner = Object.freeze({
        status, waitFor, async start() {
            need(mode === 'scratch', 'STAGING_PREPARE_REQUIRED');
            return beginRelay(null, false);
        },
        prepare(anchorBytes) {
            return beginRelay(anchorBytes, true);
        },
        async startPrepared() {
            need(explicitPrepare && preparedReceipt && !startPreparedAttempted && !cancelAttempted && !releaseAttempted && !firstError, 'START_PREPARED_REFUSED');
            startPreparedAttempted = true;
            need(equal(readRelaySourceClosure(), sources), 'SOURCE_CHANGED');
            const live = observer?.read();
            need(live?.spawnObserved && !live.exitObserved && !live.closeObserved && !live.childErrorObserved && !live.held && !live.childResourcesClosed, 'CUSTODY_LOST');
            write({
                schema: 'owned-zip-relay-control/1', relayLifetime: ready.relayLifetime, binding, command: 'startPrepared', preparedSHA256: preparedDigest
            }, 4096);
            return await waitFor('accepted');
        }, copyProof() {
            need(proofLive(), 'COPY_PROOF_UNAVAILABLE');
            if (proofCache)
                return Promise.resolve(structuredClone(proofCache));
            if (proofFlight)
                return proofFlight.promise;
            need(proofNonce === null, 'COPY_PROOF_ALREADY_REQUESTED');
            proofNonce = crypto.randomBytes(16).toString('hex');
            let resolve, reject;
            const promise = new Promise((a, b) => {
                resolve = a;
                reject = b;
            });
            proofFlight = {
                promise, resolve, reject, timer: setTimeout(() => {
                    proofCache = null;
                    proofTimedOut = true;
                    proofFlight?.reject(error('COPY_PROOF_TIMEOUT'));
                    proofFlight = null;
                }, 30000)
            };
            try {
                write({
                    schema: 'owned-zip-relay-control/1', relayLifetime: ready.relayLifetime, binding, command: 'copyProof', nonce: proofNonce
                }, 4096);
            }
            catch (e) {
                invalidateProof();
                throw e;
            }
            return promise;
        }, cancel() {
            invalidateProof();
            need(!releaseAttempted, 'RELEASE_PENDING');
            const was = cancelAttempted;
            cancelAttempted = true;
            if (!startSent)
                return Promise.resolve(status());
            if (!was)
                control('cancel');
            return waitFor('cancelled');
        }, handoff() {
            need(!handoffAttempted && !cancelAttempted && !releaseAttempted && !firstError && last?.phase === 'extracted', 'HANDOFF_REFUSED');
            handoffAttempted = true;
            control('handoff');
            return waitFor('copied');
        }, async release() {
            invalidateProof();
            if (closed && seen.has('released'))
                return status();
            need(!protocolBroken, 'HELD');
            if (!startAttempted) {
                releaseAttempted = true;
                return status();
            }
            need(ready, 'NOT_READY');
            if (!releaseAttempted) {
                releaseAttempted = true;
                control(startSent ? 'release' : 'abort');
            }
            await waitFor('released');
            if (!controllerEnded) {
                controllerEnded = true;
                child.stdin.end();
            }
            const result = await waitFor('closed');
            need(result.relayTerminal?.exitSucceeded, 'RELAY_EXIT_FAILED');
            return result;
        }, async retireInert() {
            need(!startSent, 'RETIRE_ACTIVE_REFUSED');
            releaseAttempted = true;
            if (!child || closed)
                return status();
            need(child.kill('SIGTERM'), 'INERT_RETIRE_FAILED');
            return waitFor('closed');
        }
    });
    Reflect.apply(relayInertSet, relayInertObservers, [owner, () => {
        // No external owner method/status callback is called: these are this
        // exact genuine owner's retained monotonic controls and parsed replies.
        const sdk = last?.sdk;
        need(mode === 'staging' && runtime !== null && explicitPrepare && preparedReceipt !== null
            && preparedDigest !== null && prepareNonce !== null && !startPreparedAttempted
            && startAttempted && startSent && cancelAttempted && releaseAttempted && controllerEnded && closed
            && !handoffAttempted && !protocolBroken && firstError === null && stderrBytes === 0
            && !writing && outbound.length === 0 && pending.length === 0
            && proofNonce === null && proofFlight === null && proofCache === null && !proofReceived && !proofTimedOut
            && last?.phase === 'released' && last.accepted === false && last.controllerEOF === false
            && last.errorCode === null && ready !== null, 'INERT_CANCELLATION_UNPROVEN');
        validateRelayPreparedReceipt(preparedReceipt, binding, preparedAnchor);
        need(digest(Buffer.from(JSON.stringify(preparedReceipt))) === preparedDigest, 'INERT_CANCELLATION_PREPARED');
        validateRelaySDKStatus(sdk, binding, mode);
        // This exact conjunction identifies SDK's private inertAbortAttempted
        // branch: no ordinary Python worker status can yield worker===null.
        need(sdk.phase === 'cancelled' && sdk.startAttempted === true && sdk.startSent === false
            && sdk.worker === null && sdk.cancelAttempted === true && sdk.handoffAttempted === false
            && sdk.childClosed === true && sdk.childExitCode === 0 && sdk.childSignal === null
            && sdk.errorCode === null && sdk.stderrObserved === false && sdk.copyProof === null
            && sdk.destination !== null && sdk.destination.directoryIdentity === null
            && sdk.workerLifetime === preparedReceipt.workerLifetime && sdk.workerPid === preparedReceipt.workerPid
            && sdk.creationTime === preparedReceipt.creationTime && sdk.packetSHA256 === preparedReceipt.packetSHA256,
            'INERT_CANCELLATION_UNPROVEN');
        const relayTerminal = relayInertClosed(observer?.read() ?? null, binding);
        const workerTerminal = relayInertClosed(sdk.workerTerminal, binding);
        return Object.freeze({schema:'owned-zip-relay-inert-cancellation/1',binding:Object.freeze({...binding}),
            preparedReceiptSHA256:preparedDigest,relayLifetime:ready.relayLifetime,relayPid:child.pid,
            workerLifetime:sdk.workerLifetime,workerPid:sdk.workerPid,creationTime:sdk.creationTime,packetSHA256:sdk.packetSHA256,
            cancelledBeforeStart:true,explicitStartAttempted:false,pythonStartSent:false,destinationAcquired:false,
            relayTerminal,workerTerminal,effectsAllowed:false,installationPermit:false,nativeAdmission:false,
            nativeInstallAccepted:false,powerLossPersistenceVerified:false});
    }]);
    return owner;
}
