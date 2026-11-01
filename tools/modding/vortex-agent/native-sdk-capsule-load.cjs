'use strict';
// Private compiled-Main input only. This is a closed loader, not a sandbox for
// untrusted JavaScript. The independently compiled artifact digest is authority.
const crypto = require('node:crypto');
const Module = require('node:module');
const vm = require('node:vm');
const types = require('node:util').types;

const SOURCES = Object.freeze([
  'owned-zip-relay-client.mjs', 'owned-zip-relay-runner.mjs',
  'child-terminal-observer.cjs', 'owned-zip-worker-client.mjs',
  'owned-zip-worker.py', 'owned-file-transfer.py', 'owned-zip-extractor.py',
  'native-executor-journal.mjs', 'native-intent-journal.mjs',
  'immutable-records.mjs', 'paths.cjs', 'paths-core.cjs',
  'native-dispatch-contract.cjs', 'install-job-contract.cjs', 'strict-json.cjs',
]);
const MODULES = Object.freeze([
  'native-executor-journal.mjs', 'owned-zip-relay-client.mjs',
  'owned-zip-worker-client.mjs', 'native-dispatch-contract.cjs', 'install-job-contract.cjs',
]);
const REQUIRED = Object.freeze([
  ['createNativeExecutorJournal', 'appendNativeExecutorTerminalAnchored'],
  ['createBoundOwnedZipRelay', 'validateRelayCopyProof', 'relayCopyProofBytes',
    'validateRelaySDKStatus', 'validateRelayWorkerTerminal', 'validateRelayPreparedReceipt',
    'snapshotNativeExecutorRuntimeBinding'],
  ['snapshotOwnedStagingZipInputs'],
  ['parseDispatchRequest', 'dispatchRequestDigest'],
  ['installPayloadDigest'],
]);
const BUILTINS = new Set(['node:fs', 'node:path', 'node:crypto', 'node:util',
  'node:util/types', 'node:child_process', 'node:url', 'node:net', 'node:events', 'url']);
const NODE_SHA256 = '5c976096e04e5c2c1f091938926234cc9fbebfe9787ddd149351b3b0ecc707b5';
const typed = Object.getPrototypeOf(Uint8Array.prototype);
const byteLength = Object.getOwnPropertyDescriptor(typed, 'byteLength').get;
const backingBuffer = Object.getOwnPropertyDescriptor(typed, 'buffer').get;
const arrayResizable = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resizable')?.get;
const setBytes = Uint8Array.prototype.set;
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const need = (ok, code) => { if (!ok) throw Error('NATIVE_SDK_CAPSULE_LOAD_' + code); };
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

function copyBytes(value, max) {
  need(types.isUint8Array(value) && !types.isProxy(value), 'BYTES');
  for (const key of ['buffer', 'byteLength', 'byteOffset', 'length', Symbol.iterator])
    need(Object.getOwnPropertyDescriptor(value, key) === undefined, 'BYTES');
  const n = byteLength.call(value), backing = backingBuffer.call(value);
  need(n > 0 && n <= max && !types.isSharedArrayBuffer(backing)
    && (!arrayResizable || !arrayResizable.call(backing)), 'BYTES');
  const result = new Uint8Array(n);
  setBytes.call(result, value);
  return Buffer.from(result);
}
function plain(value) {
  return value !== null && typeof value === 'object' && !types.isProxy(value)
    && (Object.getPrototypeOf(value) === null || Object.getPrototypeOf(value) === Object.prototype);
}
function exact(value, keys) {
  need(plain(value), 'SHAPE');
  const own = Reflect.ownKeys(value);
  need(own.length === keys.length && keys.every((key, i) => own[i] === key), 'SHAPE');
  for (const key of keys) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    need(d && Object.hasOwn(d, 'value') && d.enumerable, 'SHAPE');
  }
}
function canonical(bytes) {
  const text = bytes.toString('utf8');
  need(Buffer.from(text, 'utf8').equals(bytes), 'ENCODING');
  const value = JSON.parse(text);
  need(Buffer.from(JSON.stringify(value), 'utf8').equals(bytes), 'CANONICAL');
  return value;
}
function pinMap(value, names) {
  exact(value, names);
  for (const name of names) need(digest(value[name]), 'DIGEST');
}
function binding(value) {
  exact(value, ['schema', 'workspaceRoot', 'relayNodeSHA256', 'sourceSHA256']);
  need(value.schema === 'native-executor-runtime-binding/1'
    && value.relayNodeSHA256 === NODE_SHA256, 'BINDING');
  const root = value.workspaceRoot;
  need(typeof root === 'string' && root.length > 0 && root.length <= 4096
    && root.trim() === root && !/[\x00-\x1f\\]/.test(root)
    && /^(?:[A-Za-z]:\/|\/\/[^/]+\/[^/]+(?:\/|$))/.test(root)
    && !root.startsWith('//?/') && !root.startsWith('//./')
    && !root.split('/').some(part => part === '.' || part === '..')
    && !root.slice(root.startsWith('//') ? 2 : 3).includes('//')
    && (!root.endsWith('/') || /^[A-Za-z]:\/$/.test(root)
      || /^\/\/[^/]+\/[^/]+\/$/.test(root)), 'BINDING');
  pinMap(value.sourceSHA256, SOURCES);
}
function snapshot(value, budget, depth = 0, allowFunction = false) {
  need(++budget.nodes <= 4096 && depth <= 8, 'NAMESPACE_LIMIT');
  if (typeof value === 'function') {
    need(allowFunction && !types.isProxy(value), 'NAMESPACE');
    return value;
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'string'
    || typeof value === 'number' && Number.isFinite(value)) return value;
  need(value !== null && typeof value === 'object' && !types.isProxy(value)
    && Object.isFrozen(value), 'NAMESPACE');
  const array = Array.isArray(value);
  need(array ? Object.getPrototypeOf(value) === Array.prototype : plain(value), 'NAMESPACE');
  const keys = Reflect.ownKeys(value);
  need(keys.length <= 4096 && keys.every(key => typeof key === 'string'), 'NAMESPACE');
  const result = array ? [] : Object.create(null);
  if (array) need(keys.length === value.length + 1
    && keys[keys.length - 1] === 'length', 'NAMESPACE');
  for (const key of keys) {
    if (array && key === 'length') continue;
    if (array) need(key === String(result.length), 'NAMESPACE');
    const d = Object.getOwnPropertyDescriptor(value, key);
    need(d && Object.hasOwn(d, 'value') && d.enumerable, 'NAMESPACE');
    const copied = snapshot(d.value, budget, depth + 1, allowFunction && depth === 0);
    Object.defineProperty(result, key, {value: copied, enumerable: true});
  }
  return Object.freeze(result);
}

function loadNativeSDKCapsule(artifactBytes, expectedArtifactSHA256, canonicalRuntimeBindingBytes) {
  need(arguments.length === 3, 'ARGUMENTS');
  // No supplied object or byte accessor is evaluated before both inputs detach.
  const bytes = copyBytes(artifactBytes, 4 * 1024 * 1024);
  const runtimeBytes = copyBytes(canonicalRuntimeBindingBytes, 8192);
  need(digest(expectedArtifactSHA256) && sha(bytes) === expectedArtifactSHA256, 'ARTIFACT_HASH');
  const expected = canonical(runtimeBytes); binding(expected);
  const artifact = canonical(bytes);
  exact(artifact, ['schema', 'binding', 'main', 'relay', 'python', 'transformedJavaScriptSHA256']);
  need(artifact.schema === 'native-sdk-capsule/1', 'SCHEMA');
  binding(artifact.binding);
  need(JSON.stringify(artifact.binding) === runtimeBytes.toString('utf8'), 'BINDING');
  exact(artifact.main, ['code', 'sha256']);
  exact(artifact.relay, ['codeSHA256', 'envelopeSHA256']);
  exact(artifact.python, ['originalSHA256', 'executionSHA256']);
  const py = SOURCES.filter(name => name.endsWith('.py'));
  pinMap(artifact.python.originalSHA256, py);
  pinMap(artifact.python.executionSHA256, py);
  pinMap(artifact.transformedJavaScriptSHA256, SOURCES.filter(name => !name.endsWith('.py')));
  need(py.every(name => artifact.python.originalSHA256[name] === expected.sourceSHA256[name])
    && digest(artifact.main.sha256) && digest(artifact.relay.codeSHA256)
    && digest(artifact.relay.envelopeSHA256), 'DIGEST');
  const encoded = artifact.main.code;
  need(typeof encoded === 'string' && encoded.length > 0 && encoded.length <= 2796204
    && encoded.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(encoded), 'BASE64');
  const code = Buffer.from(encoded, 'base64');
  need(code.length > 0 && code.length <= 2 * 1024 * 1024
    && code.toString('base64') === encoded && sha(code) === artifact.main.sha256, 'CODE_HASH');
  const text = code.toString('utf8');
  need(Buffer.from(text, 'utf8').equals(code) && !text.startsWith('\uFEFF'), 'ENCODING');
  const module = {exports: {}};
  const fixedRequire = id => {
    need(typeof id === 'string' && BUILTINS.has(id), 'IMPORT');
    return require(id);
  };
  const filename = '<native-sdk-capsule/main.cjs>';
  const script = new vm.Script(Module.wrap(text), {filename,
    importModuleDynamically() { throw Error('NATIVE_SDK_CAPSULE_LOAD_DYNAMIC_IMPORT'); }});
  const execute = script.runInThisContext();
  execute.call(module.exports, module.exports, fixedRequire, module, filename, '<native-sdk-capsule>');
  const exported = module.exports;
  exact(exported, ['modules']);
  need(Object.isFrozen(exported), 'NAMESPACE');
  exact(exported.modules, MODULES);
  need(Object.isFrozen(exported.modules), 'NAMESPACE');
  const modules = Object.create(null), budget = {nodes: 0};
  for (let i = 0; i < MODULES.length; i++) {
    const ns = exported.modules[MODULES[i]];
    need(plain(ns) && Object.isFrozen(ns), 'NAMESPACE');
    const result = snapshot(ns, budget, 0, true);
    for (const name of REQUIRED[i])
      need(typeof Object.getOwnPropertyDescriptor(result, name)?.value === 'function', 'NAMESPACE');
    modules[MODULES[i]] = result;
  }
  return Object.freeze({artifactSHA256: expectedArtifactSHA256,
    binding: Object.freeze({...expected, sourceSHA256: Object.freeze({...expected.sourceSHA256})}),
    modules: Object.freeze(modules)});
}

module.exports = Object.freeze({loadNativeSDKCapsule});
