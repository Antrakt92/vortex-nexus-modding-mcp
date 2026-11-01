import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {captureNativeSDKSources, readCapturedNativeSDKSource, NATIVE_SDK_SOURCE_NAMES as names,
  NATIVE_SDK_CAPTURE_LIMITS as limits} from './native-sdk-capture.mjs';
import {RELAY_SOURCE_NAMES} from './owned-zip-relay-client.mjs';
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-sdk-capture-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const sdk = path.join(root, 'sdk'); fs.mkdirSync(sdk);
  const pins = Object.create(null), bytes = new Map();
  for (const name of names) {
    const b = Buffer.from('// inert fixture ' + name + '\n');
    fs.writeFileSync(path.join(sdk, name), b); pins[name] = sha(b); bytes.set(name, b);
  }
  return {root, sdk, pins, bytes};
}
function patched(name, replacement, body) {
  const original = fs[name]; fs[name] = (...args) => replacement(original, ...args);
  try {return body();} finally {fs[name] = original;}
}

test('fixed capture names match the existing fifteen-file SDK and receipt identifies exact bytes', t => {
  assert.deepEqual(names, RELAY_SOURCE_NAMES); assert(Object.isFrozen(names));
  const f = fixture(t), capture = captureNativeSDKSources(f.sdk, f.pins);
  assert(Object.isFrozen(capture)); assert(Object.isFrozen(capture.receipt));
  assert(Object.isFrozen(capture.receipt.sourceSHA256));
  assert.equal(capture.receipt.sourceCount, 15);
  assert.equal(capture.receipt.javascriptSourceCount, names.filter(n => !n.endsWith('.py')).length);
  assert.equal(capture.receipt.pythonSourceCount, 3);
  assert.equal(capture.receipt.totalBytes, [...f.bytes.values()].reduce((n,b) => n+b.length, 0));
  assert.equal(capture.receipt.sourceTupleSHA256, sha(Buffer.from(JSON.stringify(f.pins))));
  assert.equal(capture.receipt.effectsAllowed, false); assert.equal(capture.receipt.nativeAdmission, false);
  for (const name of names) assert.deepEqual(readCapturedNativeSDKSource(capture, name), f.bytes.get(name));
});

test('post-capture source replacement and sibling churn cannot alter captured code or trigger disk reads', t => {
  const f = fixture(t), capture = captureNativeSDKSources(f.sdk, f.pins);
  fs.renameSync(f.sdk, path.join(f.root, 'old-sdk')); fs.mkdirSync(f.sdk);
  for (const name of names) fs.writeFileSync(path.join(f.sdk, name), 'replacement');
  fs.mkdirSync(path.join(f.root, 'unrelated'));
  for (const method of ['openSync', 'readSync', 'readFileSync', 'lstatSync']) {
    patched(method, () => assert.fail('Filesystem reopened after capture'), () => {
      for (const name of names) assert.deepEqual(readCapturedNativeSDKSource(capture, name), f.bytes.get(name));
    });
  }
  const detached = readCapturedNativeSDKSource(capture, names[0]); detached.fill(0);
  assert.deepEqual(readCapturedNativeSDKSource(capture, names[0]), f.bytes.get(names[0]));
  f.pins[names[0]] = '0'.repeat(64);
  assert.equal(capture.receipt.sourceSHA256[names[0]], sha(f.bytes.get(names[0])));
});

test('foreign captures, getters, proxies, traversal and extra arguments remain inert', t => {
  const f = fixture(t); let touched = 0;
  const getter = {...f.pins}; Object.defineProperty(getter, names[0], {enumerable:true, get(){touched++; throw Error('getter');}});
  const proxy = new Proxy(f.pins, {ownKeys(){touched++; throw Error('proxy');}});
  for (const pins of [null, {}, getter, proxy, Object.create(f.pins), {...f.pins, extra:'0'.repeat(64)}]) {
    assert.throws(() => captureNativeSDKSources(f.sdk, pins), /NATIVE_SDK_CAPTURE_PINS/);
  }
  assert.equal(touched, 0);
  const capture = captureNativeSDKSources(f.sdk, f.pins);
  for (const foreign of [null, {}, Object.create(capture), new Proxy(capture,{get(){assert.fail('proxy');}})]) {
    assert.throws(() => readCapturedNativeSDKSource(foreign, names[0]), /NATIVE_SDK_CAPTURE_CAPTURE/);
  }
  for (const name of ['../paths.cjs', 'other.mjs', null, Symbol('source')]) {
    assert.throws(() => readCapturedNativeSDKSource(capture, name), /NATIVE_SDK_CAPTURE_NAME/);
  }
  assert.throws(() => captureNativeSDKSources(f.sdk, f.pins, true), /ARGUMENTS/);
  assert.throws(() => readCapturedNativeSDKSource(capture, names[0], true), /ARGUMENTS/);
});

test('missing, hash-changed, empty, over-limit and invalid UTF-8 sources cannot be captured', t => {
  const f = fixture(t), file = path.join(f.sdk, names[0]), original = f.bytes.get(names[0]);
  fs.unlinkSync(file); assert.throws(() => captureNativeSDKSources(f.sdk, f.pins), /ENOENT/);
  for (const b of [Buffer.from('wrong'), Buffer.alloc(0), Buffer.alloc(limits.fileBytes+1)]) {
    fs.writeFileSync(file, b); assert.throws(() => captureNativeSDKSources(f.sdk, f.pins), /HASH|LIMIT/);
  }
  const invalid = Buffer.from([0xc3, 0x28]); fs.writeFileSync(file, invalid); f.pins[names[0]] = sha(invalid);
  assert.throws(() => captureNativeSDKSources(f.sdk, f.pins), /encoded data|encoding/i);
  fs.writeFileSync(file, original); f.pins[names[0]] = sha(original);
  assert.equal(captureNativeSDKSources(f.sdk, f.pins).receipt.sourceCount, 15);
});

test('mutation while reading and previously read leaf replacement are refused; descriptors always close', t => {
  const f = fixture(t), first = path.join(f.sdk, names[0]); let fired = false, opened = 0, closed = 0;
  patched('openSync', (original,...args) => {opened++; return original(...args);}, () =>
    patched('closeSync', (original,...args) => {closed++; return original(...args);}, () =>
      patched('readSync', (original,...args) => {
        const n = original(...args);
        if (!fired) {fired = true; fs.appendFileSync(first, 'changed');}
        return n;
      }, () => assert.throws(() => captureNativeSDKSources(f.sdk, f.pins), /CHANGED/))));
  assert(fired); assert.equal(opened, closed);
  fs.writeFileSync(first, f.bytes.get(names[0])); fired = false;
  patched('openSync', (original, file,...args) => {
    if (file === path.join(f.sdk, names[1])) {
      fired = true; fs.renameSync(first, first+'.old'); fs.writeFileSync(first, f.bytes.get(names[0]));
    }
    return original(file,...args);
  }, () => assert.throws(() => captureNativeSDKSources(f.sdk, f.pins), /CHANGED/));
  assert(fired);
});

test('source directory junction cannot redirect capture to otherwise valid bytes', t => {
  const f = fixture(t), link = path.join(f.root, 'link');
  fs.symlinkSync(f.sdk, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => captureNativeSDKSources(link, f.pins), /DIRECTORY/);
});

test('unselected on-disk files never join the captured namespace', t => {
  const f = fixture(t), extra = 'not-admitted.cjs';
  fs.writeFileSync(path.join(f.sdk, extra), 'throw Error("must never execute");');
  const capture = captureNativeSDKSources(f.sdk, f.pins);
  assert.equal(capture.receipt.sourceCount, 15);
  assert.equal(Object.hasOwn(capture.receipt.sourceSHA256, extra), false);
  patched('readFileSync', () => assert.fail('Unselected file opened'), () =>
    assert.throws(() => readCapturedNativeSDKSource(capture, extra), /NATIVE_SDK_CAPTURE_NAME/));
});
