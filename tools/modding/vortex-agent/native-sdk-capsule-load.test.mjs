import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
const {loadNativeSDKCapsule: load} = require('./native-sdk-capsule-load.cjs');
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const names = [
  'owned-zip-relay-client.mjs', 'owned-zip-relay-runner.mjs', 'child-terminal-observer.cjs',
  'owned-zip-worker-client.mjs', 'owned-zip-worker.py', 'owned-file-transfer.py',
  'owned-zip-extractor.py', 'native-executor-journal.mjs', 'native-intent-journal.mjs',
  'immutable-records.mjs', 'paths.cjs', 'paths-core.cjs', 'native-dispatch-contract.cjs',
  'install-job-contract.cjs', 'strict-json.cjs',
];
const modules = [
  ['native-executor-journal.mjs', ['createNativeExecutorJournal', 'appendNativeExecutorTerminalAnchored']],
  ['owned-zip-relay-client.mjs', ['createBoundOwnedZipRelay', 'validateRelayCopyProof', 'relayCopyProofBytes',
    'validateRelaySDKStatus', 'validateRelayWorkerTerminal', 'validateRelayPreparedReceipt',
    'snapshotNativeExecutorRuntimeBinding']],
  ['owned-zip-worker-client.mjs', ['snapshotOwnedStagingZipInputs']],
  ['native-dispatch-contract.cjs', ['parseDispatchRequest', 'dispatchRequestDigest']],
  ['install-job-contract.cjs', ['installPayloadDigest']],
];
const binding = {
  schema: 'native-executor-runtime-binding/1', workspaceRoot: 'F:/Own/Capsule',
  relayNodeSHA256: '5c976096e04e5c2c1f091938926234cc9fbebfe9787ddd149351b3b0ecc707b5',
  sourceSHA256: Object.fromEntries(names.map((name, i) => [name, sha(Buffer.from('source' + i))])),
};
const bindingBytes = () => Buffer.from(JSON.stringify(binding));
function code(prefix = '', suffix = '') {
  return `${prefix}\nconst modules=Object.create(null);\n` + modules.map(([name, funcs]) =>
    `modules[${JSON.stringify(name)}]=Object.freeze({${funcs.map(f => `${f}:function ${f}(){return ${JSON.stringify(f)};}`).join(',')},LIMITS:Object.freeze({n:1,names:Object.freeze(['one'])})});`).join('\n')
    + `\n${suffix}\nmodule.exports=Object.freeze({modules:Object.freeze(modules)});`;
}
function artifact(source = code()) {
  const bytes = Buffer.from(source);
  return {
    schema: 'native-sdk-capsule/1', binding: structuredClone(binding),
    main: {code: bytes.toString('base64'), sha256: sha(bytes)},
    relay: {codeSHA256: sha(Buffer.from('relay')), envelopeSHA256: sha(Buffer.from('envelope'))},
    python: {
      originalSHA256: Object.fromEntries(names.filter(n => n.endsWith('.py')).map(n => [n, binding.sourceSHA256[n]])),
      executionSHA256: Object.fromEntries(names.filter(n => n.endsWith('.py')).map(n => [n, sha(Buffer.from(n))])),
    },
    transformedJavaScriptSHA256: Object.fromEntries(names.filter(n => !n.endsWith('.py')).map(n => [n, sha(Buffer.from(n))])),
  };
}
function invoke(value = artifact(), bound = bindingBytes()) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
  return load(bytes, sha(bytes), bound);
}
const refusal = /NATIVE_SDK_CAPSULE_LOAD_/;

test('loads an inert fixed CJS capsule and preserves functions plus detached frozen constants', () => {
  const result = invoke();
  assert(Object.isFrozen(result)); assert(Object.isFrozen(result.binding));
  assert(Object.isFrozen(result.binding.sourceSHA256)); assert(Object.isFrozen(result.modules));
  assert.deepEqual(Object.keys(result.modules), modules.map(([name]) => name));
  for (const [name, funcs] of modules) {
    const ns = result.modules[name];
    assert(Object.isFrozen(ns)); assert.equal(Object.getPrototypeOf(ns), null);
    for (const fn of funcs) assert.equal(ns[fn](), fn);
    assert(Object.isFrozen(ns.LIMITS)); assert(Object.isFrozen(ns.LIMITS.names));
    assert.deepEqual([...ns.LIMITS.names], ['one']);
  }
  assert.equal(result.binding.workspaceRoot, binding.workspaceRoot);
});

test('hash, binding, raw source pins and every artifact digest validate before evaluation', () => {
  globalThis.__capsuleLoaderExecuted = 0;
  const original = artifact(code('globalThis.__capsuleLoaderExecuted++;'));
  const bytes = Buffer.from(JSON.stringify(original));
  assert.throws(() => load(bytes, '0'.repeat(64), bindingBytes()), /ARTIFACT_HASH/);
  const badBinding = structuredClone(binding); badBinding.workspaceRoot = 'F:/Different';
  assert.throws(() => load(bytes, sha(bytes), Buffer.from(JSON.stringify(badBinding))), /BINDING/);
  for (const mutate of [
    v => {v.main.sha256 = 'f'.repeat(64);},
    v => {v.python.originalSHA256['owned-zip-worker.py'] = 'f'.repeat(64);},
    v => {v.python.executionSHA256['owned-file-transfer.py'] = 'INVALID';},
    v => {v.transformedJavaScriptSHA256['paths.cjs'] = 'INVALID';},
    v => {v.relay.envelopeSHA256 = 'INVALID';},
    v => {v.binding.sourceSHA256['strict-json.cjs'] = 'f'.repeat(64);},
  ]) {const value = structuredClone(original); mutate(value); assert.throws(() => invoke(value), refusal);}
  assert.equal(globalThis.__capsuleLoaderExecuted, 0);
  delete globalThis.__capsuleLoaderExecuted;
});

test('rejects duplicate keys, whitespace, BOM, invalid UTF8 and noncanonical base64', () => {
  const a = artifact(), raw = JSON.stringify(a);
  for (const bad of [Buffer.from(' '+raw), Buffer.from('\uFEFF'+raw),
    Buffer.from(raw.replace('"schema":"native-sdk-capsule/1"', '"schema":"ignored","schema":"native-sdk-capsule/1"')),
    Buffer.concat([Buffer.from(raw), Buffer.from([255])])]) assert.throws(() => invoke(bad));
  for (const value of [a.main.code+'\n', a.main.code.replace(/=+$/, '')+'===', '%%%%', '']) {
    const bad = structuredClone(a); bad.main.code = value; assert.throws(() => invoke(bad), refusal);
  }
  assert.throws(() => invoke(a, Buffer.from(JSON.stringify(binding)+'\n')), /CANONICAL/);
});

test('all fixed maps and closed shapes refuse extras, omissions and source order drift', () => {
  for (const mutate of [
    v => {v.extra = false;}, v => {delete v.relay;}, v => {v.main.extra = 'x';},
    v => {v.python.originalSHA256.extra = 'a'.repeat(64);},
    v => {delete v.transformedJavaScriptSHA256['paths.cjs'];},
    v => {v.binding.sourceSHA256 = Object.fromEntries(Object.entries(v.binding.sourceSHA256).reverse());},
  ]) {const value = artifact(); mutate(value); assert.throws(() => invoke(value), refusal);}
  for (const root of ['relative', '/rooted', 'F:/Own/../Other', 'F:/Own//Other', 'F:/Own/',
    ' F:/Own', '//?/F:/Own', '//./F:/Own', 'F:\\Own']) {
    const value = artifact(); value.binding.workspaceRoot = root;
    assert.throws(() => invoke(value, Buffer.from(JSON.stringify(value.binding))), /BINDING/);
  }
});

test('byte inputs use intrinsic copy and reject Proxy, shared, resizable, accessors and size limits', () => {
  const bytes = Buffer.from(JSON.stringify(artifact())); let getters = 0;
  const shadow = new Uint8Array(bytes);
  Object.defineProperty(shadow, 'byteLength', {get() {getters++; throw Error('getter');}});
  for (const bad of [new Proxy(bytes, {}), shadow, new Uint8Array(new SharedArrayBuffer(bytes.length)),
    new Uint8Array(new ArrayBuffer(bytes.length, {maxByteLength: bytes.length+1})),
    new Uint8Array(4*1024*1024+1), new Uint8Array(0), {}])
    assert.throws(() => load(bad, sha(bytes), bindingBytes()), refusal);
  assert.equal(getters, 0);
  assert.throws(() => load(bytes, sha(bytes), new Uint8Array(8193)), refusal);
  const original = Buffer.from(bytes), result = load(bytes, sha(bytes), bindingBytes());
  bytes.fill(0); assert.equal(result.modules['install-job-contract.cjs'].installPayloadDigest(), 'installPayloadDigest');
  assert.equal(result.artifactSHA256, sha(original));
});

test('closed require supports only the fixed builtin aliases and refuses filesystem/ESM resolution', () => {
  const allowed = ['node:fs','node:path','node:crypto','node:util','node:util/types',
    'node:child_process','node:url','node:net','node:events','url'];
  invoke(artifact(code(allowed.map(n => `require(${JSON.stringify(n)});`).join('\n'))));
  for (const id of ['./side.cjs', './side.mjs', 'F:/side.cjs', 'node:module', 'module', 'fs', 'node:vm', 'https://invalid/'])
    assert.throws(() => invoke(artifact(code(`require(${JSON.stringify(id)});`))), /IMPORT/);
  assert.throws(() => invoke(artifact('import x from "./side.mjs";')), SyntaxError);
});

test('dynamic import never receives a resolver fallback', async () => {
  const source = code('', `modules['install-job-contract.cjs']=Object.freeze({installPayloadDigest:()=>import('./side.mjs')});`);
  const result = invoke(artifact(source));
  await assert.rejects(result.modules['install-job-contract.cjs'].installPayloadDigest(),
    /NATIVE_SDK_CAPSULE_LOAD_DYNAMIC_IMPORT|ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING_FLAG/);
});

test('namespace validation refuses getters/proxies, unfrozen exports, malformed maps and nested accessors', () => {
  globalThis.__capsuleGetterCalls = 0;
  const getter = `Object.freeze(Object.defineProperty({},'installPayloadDigest',{enumerable:true,get(){globalThis.__capsuleGetterCalls++;throw Error('getter');}}))`;
  for (const expression of [getter,
    'new Proxy(Object.freeze({installPayloadDigest(){}}),{})',
    'Object.freeze({installPayloadDigest:new Proxy(function(){},{})})',
    '{installPayloadDigest(){}}',
    'Object.freeze({installPayloadDigest(){},LIMITS:{n:1}})',
    `Object.freeze({installPayloadDigest(){},LIMITS:Object.freeze(Object.defineProperty({},'n',{enumerable:true,get(){globalThis.__capsuleGetterCalls++;}}))})`,
    'Object.freeze({wrongFunction(){}})',
    'Object.freeze({installPayloadDigest(){},extra:undefined})',
  ]) assert.throws(() => invoke(artifact(code('', `modules['install-job-contract.cjs']=${expression};`))), refusal);
  assert.equal(globalThis.__capsuleGetterCalls, 0); delete globalThis.__capsuleGetterCalls;
  assert.throws(() => invoke(artifact(code('', "modules.extra=Object.freeze({});"))), /SHAPE/);
  assert.throws(() => invoke(artifact('module.exports={modules:{}};')), refusal);
  assert.throws(() => invoke(artifact('module.exports=Object.freeze({get modules(){throw Error("getter called");}});')), /SHAPE/);
});

test('bounded namespace traversal and independent load instances do not share a cache', () => {
  const deep = 'Object.freeze({n:'.repeat(10)+'1'+'})'.repeat(10);
  assert.throws(() => invoke(artifact(code('', `modules['install-job-contract.cjs']=Object.freeze({installPayloadDigest(){},LIMITS:${deep}});`))), /NAMESPACE_LIMIT/);
  const huge = `Object.freeze(Array.from({length:4096},()=>1))`;
  assert.throws(() => invoke(artifact(code('', `modules['install-job-contract.cjs']=Object.freeze({installPayloadDigest(){},LIMITS:${huge}});`))), /NAMESPACE/);
  const first = invoke(), second = invoke();
  assert.notEqual(first.modules['install-job-contract.cjs'].installPayloadDigest,
    second.modules['install-job-contract.cjs'].installPayloadDigest);
});

test('actual code byte limit accepts a two-MiB inert bundle and rejects one byte more', () => {
  const base = code(), source = base + '\n//' + ' '.repeat(2*1024*1024-Buffer.byteLength(base)-3);
  assert.equal(Buffer.byteLength(source), 2*1024*1024);
  assert.equal(invoke(artifact(source)).modules['install-job-contract.cjs'].installPayloadDigest(), 'installPayloadDigest');
  assert.throws(() => invoke(artifact(source+' ')), /BASE64|CODE_HASH/);
});
