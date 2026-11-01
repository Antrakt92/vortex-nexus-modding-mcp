// Build-time source capture only. No SDK loading, process start or native permit.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {isProxy} from 'node:util/types';

export const NATIVE_SDK_SOURCE_NAMES = Object.freeze([
  'owned-zip-relay-client.mjs', 'owned-zip-relay-runner.mjs', 'child-terminal-observer.cjs',
  'owned-zip-worker-client.mjs', 'owned-zip-worker.py', 'owned-file-transfer.py',
  'owned-zip-extractor.py', 'native-executor-journal.mjs', 'native-intent-journal.mjs',
  'immutable-records.mjs', 'paths.cjs', 'paths-core.cjs', 'native-dispatch-contract.cjs',
  'install-job-contract.cjs', 'strict-json.cjs',
]);
export const NATIVE_SDK_CAPTURE_LIMITS = Object.freeze({fileBytes: 512*1024, totalBytes: 8*1024*1024});
const captures = new WeakMap();
const need = (ok, code) => {if (!ok) throw Error('NATIVE_SDK_CAPTURE_' + code);};
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const generation = stat => ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'nlink'].map(k => String(stat[k])).join(':');

function pinsSnapshot(input) {
  need(input !== null && typeof input === 'object' && !isProxy(input), 'PINS');
  need([null, Object.prototype].includes(Object.getPrototypeOf(input)), 'PINS');
  const descriptors = Object.getOwnPropertyDescriptors(input), keys = Reflect.ownKeys(descriptors);
  need(keys.length === NATIVE_SDK_SOURCE_NAMES.length
    && NATIVE_SDK_SOURCE_NAMES.every(n => Object.hasOwn(descriptors, n)), 'PINS');
  const pins = Object.create(null);
  for (const name of NATIVE_SDK_SOURCE_NAMES) {
    const d = descriptors[name];
    need(Object.hasOwn(d, 'value') && d.enumerable && typeof d.value === 'string'
      && /^[a-f0-9]{64}$/.test(d.value), 'PINS');
    pins[name] = d.value;
  }
  return Object.freeze(pins);
}

/** Retain verified bytes; subsequent bundling must not reopen their source paths. */
export function captureNativeSDKSources(sourceDirectory, expectedSourceSHA256) {
  need(arguments.length === 2, 'ARGUMENTS');
  need(typeof sourceDirectory === 'string' && sourceDirectory.length > 0
    && sourceDirectory.length <= 32768 && !/[\x00-\x1f]/.test(sourceDirectory)
    && path.isAbsolute(sourceDirectory), 'ROOT');
  const pins = pinsSnapshot(expectedSourceSHA256), root = path.resolve(sourceDirectory);
  const directories = new Map(), leaves = new Map(), sources = new Map();
  for (let current = root, depth = 0;; current = path.dirname(current)) {
    need(++depth <= 128, 'DEPTH');
    const s = fs.lstatSync(current, {bigint: true});
    need(s.isDirectory() && !s.isSymbolicLink(), 'DIRECTORY');
    directories.set(current, generation(s));
    if (current === path.dirname(current)) break;
  }
  let totalBytes = 0;
  for (const name of NATIVE_SDK_SOURCE_NAMES) {
    const file = path.join(root, name), before = fs.lstatSync(file, {bigint: true});
    need(before.isFile() && !before.isSymbolicLink(), 'FILE');
    need(before.size > 0n && before.size <= BigInt(NATIVE_SDK_CAPTURE_LIMITS.fileBytes), 'LIMIT');
    const size = Number(before.size), stamp = generation(before);
    totalBytes += size; need(totalBytes <= NATIVE_SDK_CAPTURE_LIMITS.totalBytes, 'LIMIT');
    const fd = fs.openSync(file, 'r');
    let bytes;
    try {
      need(generation(fs.fstatSync(fd, {bigint: true})) === stamp, 'CHANGED');
      const buffer = Buffer.alloc(size+1); let used = 0;
      while (used < buffer.length) {
        const count = fs.readSync(fd, buffer, used, Math.min(65536, buffer.length-used), used);
        if (count === 0) break;
        used += count;
      }
      need(used === size && generation(fs.fstatSync(fd, {bigint: true})) === stamp
        && generation(fs.lstatSync(file, {bigint: true})) === stamp, 'CHANGED');
      bytes = Buffer.from(buffer.subarray(0, used));
      need(sha(bytes) === pins[name], 'HASH');
      // Source decoding is strict; an invalid byte sequence must never be silently replaced.
      new TextDecoder('utf-8', {fatal: true}).decode(bytes);
    } finally {fs.closeSync(fd);}
    leaves.set(file, stamp); sources.set(name, bytes);
  }
  for (const [file, stamp] of leaves) {
    const s = fs.lstatSync(file, {bigint: true});
    need(s.isFile() && !s.isSymbolicLink() && generation(s) === stamp, 'CHANGED');
  }
  for (const [directory, stamp] of directories) {
    const s = fs.lstatSync(directory, {bigint: true});
    need(s.isDirectory() && !s.isSymbolicLink() && generation(s) === stamp, 'CHANGED');
  }
  const receipt = Object.freeze({schema: 'native-sdk-source-capture/1', sourceSHA256: pins,
    totalBytes, sourceCount: 15, javascriptSourceCount: 12, pythonSourceCount: 3,
    sourceTupleSHA256: sha(Buffer.from(JSON.stringify(pins))),
    nativeAdmission: false, effectsAllowed: false});
  const capture = Object.freeze({receipt});
  captures.set(capture, sources);
  return capture;
}

/** Detached byte copies from the branded capture, with no filesystem lookup. */
export function readCapturedNativeSDKSource(capture, name) {
  need(arguments.length === 2, 'ARGUMENTS');
  need(capture !== null && typeof capture === 'object' && !isProxy(capture)
    && captures.has(capture), 'CAPTURE');
  need(typeof name === 'string' && NATIVE_SDK_SOURCE_NAMES.includes(name), 'NAME');
  return Buffer.from(captures.get(capture).get(name));
}
