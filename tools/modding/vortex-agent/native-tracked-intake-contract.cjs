'use strict';
// Pure intake data only. Evidence hashes are claims, not native observations.
// No persistence, ID allocation, archive I/O, dispatch or capability providers.
const {createHash} = require('node:crypto');
const types = require('node:util').types;
const {parseStrictJSON} = require('./strict-json.cjs');
const {LIMITS: PLAN_LIMITS, validateInstallPlan, installPlanId} = require('./install-job-contract.cjs');
const SCHEMA = 'native-tracked-intake/1';
const LIMITS = Object.freeze({bytes: PLAN_LIMITS.bytes + 1024,
  depth: PLAN_LIMITS.depth + 1, tokens: PLAN_LIMITS.nodes + 16});
const need = (ok, code) => {if (!ok) throw Error(code);};
const typed = Object.getPrototypeOf(Uint8Array.prototype);
const byteLength = Object.getOwnPropertyDescriptor(typed, 'byteLength').get;
const buffer = Object.getOwnPropertyDescriptor(typed, 'buffer').get;
const resizable = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resizable')?.get;
const set = Uint8Array.prototype.set;

function snapshotEnvelope(input) {
  need(input !== null && typeof input === 'object' && !types.isProxy(input)
    && !Array.isArray(input), 'NATIVE_TRACKED_INTAKE_INVALID');
  const proto = Object.getPrototypeOf(input);
  need(proto === Object.prototype || proto === null, 'NATIVE_TRACKED_INTAKE_INVALID');
  const keys = Reflect.ownKeys(input), names = ['schema', 'requestId', 'plan'];
  need(keys.length === names.length && keys.every(k => typeof k === 'string' && names.includes(k)),
    'NATIVE_TRACKED_INTAKE_INVALID');
  const snapshot = Object.create(null);
  for (const name of names) {
    const property = Object.getOwnPropertyDescriptor(input, name);
    need(property && property.enumerable && Object.hasOwn(property, 'value'), 'NATIVE_TRACKED_INTAKE_INVALID');
    snapshot[name] = property.value;
  }
  // Same stable public request-ID convention as guard.cjs/serialization.cjs.
  need(snapshot.schema === SCHEMA && typeof snapshot.requestId === 'string'
    && snapshot.requestId.length >= 8 && snapshot.requestId.length <= 80
    && !/[^a-zA-Z0-9_-]/.test(snapshot.requestId), 'NATIVE_TRACKED_INTAKE_INVALID');
  return snapshot;
}

function validateTrackedIntake(input) {
  const snapshot = snapshotEnvelope(input);
  // Existing validator owns all plan schema, traversal budgets and safe copying.
  snapshot.plan = validateInstallPlan(snapshot.plan);
  return Object.freeze(snapshot);
}

function parseTrackedIntake(bytes) {
  let value;
  try {
    need(!types.isProxy(bytes) && types.isUint8Array(bytes), 'INVALID_BYTES');
    const proto = Object.getPrototypeOf(bytes);
    need(proto === Uint8Array.prototype || proto === Buffer.prototype, 'INVALID_BYTES');
    const length = byteLength.call(bytes), backing = buffer.call(bytes);
    need(length > 0 && length <= LIMITS.bytes && types.isArrayBuffer(backing)
      && !types.isSharedArrayBuffer(backing) && !(resizable && resizable.call(backing)), 'INVALID_BYTES');
    // The carrier is intrinsic bytes; unrelated own metadata is never read.
    const copy = new Uint8Array(length); set.call(copy, bytes);
    need(!(copy[0] === 0xef && copy[1] === 0xbb && copy[2] === 0xbf), 'INVALID_BYTES');
    value = parseStrictJSON(copy, {maxBytes: LIMITS.bytes, maxDepth: LIMITS.depth, maxTokens: LIMITS.tokens});
  } catch {throw Error('NATIVE_TRACKED_INTAKE_INVALID_JSON');}
  return validateTrackedIntake(value);
}

function trackedIntakeDigest(input) {
  const value = snapshotEnvelope(input);
  // Unambiguous semantic tuple; plan hashing stays owned by the job contract.
  return createHash('sha256').update(JSON.stringify([SCHEMA, value.requestId, installPlanId(value.plan)])).digest('hex');
}
module.exports = {SCHEMA, LIMITS, validateTrackedIntake, parseTrackedIntake, trackedIntakeDigest};
