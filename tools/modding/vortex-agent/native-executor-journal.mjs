import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {types} from 'node:util';
import paths from './paths-core.cjs';
import dispatch from './native-dispatch-contract.cjs';
import {createNativeIntentJournal} from './native-intent-journal.mjs';
import {createImmutableRecordIO, identity, generation} from './immutable-records.mjs';
import strictJSON from './strict-json.cjs';

const need = (ok, code) => {if (!ok) throw Error('NATIVE_EXECUTOR_' + code);};
const id = (value, prefix) => typeof value === 'string' && new RegExp('^' + prefix + '_[a-f0-9]{32}$').test(value);
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const BINDING_KEYS = ['schema', 'operationId', 'nativeJobId', 'requestSHA256', 'packetSHA256',
  'workerLifetime', 'rootId', 'jobsRootId', 'directoryId'];
const io = createImmutableRecordIO({maxBytes: 8192, prefix: 'NATIVE_EXECUTOR_'});
export const INVENTORY_LIMITS = Object.freeze({records: 1024, bytes: 32 * 1024 * 1024});
const EVIDENCE_KEYS = ['schema', 'outcome', 'fullRecordSHA256', 'registrationObservationSHA256',
  'adoptionObservationSHA256', 'workerClosureObservationSHA256', 'releaseObservationSHA256'];
const TERMINAL_KEYS = ['schema', ...BINDING_KEYS.slice(1, 6), 'rootId', 'jobsRootId', 'jobDirectoryId',
  'terminalsRootId', 'directoryId', ...EVIDENCE_KEYS.slice(1), 'evidenceSHA256'];
const encoded = value => Buffer.from(JSON.stringify(value) + '\n');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const rootId = value => typeof value === 'string' && /^[0-9]+:[0-9]+$/.test(value) && value.length <= 100;
function codeOf(error) {
  if (error === null || typeof error !== 'object' || types.isProxy(error)) return 'NATIVE_EXECUTOR_IO_FAILED';
  const descriptor = Object.getOwnPropertyDescriptor(error, 'message');
  const value = descriptor && 'value' in descriptor ? descriptor.value : undefined;
  if (typeof value !== 'string') return 'NATIVE_EXECUTOR_IO_FAILED';
  if (/^NATIVE_EXECUTOR_[A-Z_]+$/.test(value)) return value;
  const intent = /^NATIVE_INTENT_([A-Z_]+)$/.exec(value);
  return intent ? 'NATIVE_EXECUTOR_INTENT_' + intent[1] : 'NATIVE_EXECUTOR_IO_FAILED';
}
function bindingSnapshot(value) {
  need(value !== null && typeof value === 'object' && !types.isProxy(value), 'INVALID_BINDING');
  const keys = ['operationId', 'nativeJobId', 'requestSHA256', 'packetSHA256', 'workerLifetime'];
  const descriptors = Object.getOwnPropertyDescriptors(value);
  need(Reflect.ownKeys(descriptors).length === keys.length && keys.every(key => descriptors[key]
    && 'value' in descriptors[key] && descriptors[key].enumerable), 'INVALID_BINDING');
  const result = Object.fromEntries(keys.map(key => [key, descriptors[key].value]));
  need(id(result.operationId, 'op') && id(result.nativeJobId, 'exec') && id(result.workerLifetime, 'worker')
    && sha(result.requestSHA256) && sha(result.packetSHA256), 'INVALID_BINDING');
  return Object.freeze(result);
}
function evidenceSnapshot(bytes) {
  try {
    need(types.isUint8Array(bytes) && !types.isProxy(bytes), 'INVALID_TERMINAL');
    const prototype = Object.getPrototypeOf(Uint8Array.prototype);
    const size = Object.getOwnPropertyDescriptor(prototype, 'byteLength').get.call(bytes);
    const backing = Object.getOwnPropertyDescriptor(prototype, 'buffer').get.call(bytes);
    need(size > 0 && size <= 8192 && !types.isSharedArrayBuffer(backing), 'INVALID_TERMINAL');
    const copy = new Uint8Array(size); Uint8Array.prototype.set.call(copy, bytes);
    const value = strictJSON.parseStrictJSON(copy, {maxBytes: 8192, maxDepth: 4, maxTokens: 100});
    need(exact(value, EVIDENCE_KEYS) && value.schema === 'native-executor-terminal-evidence/1'
      && value.outcome === 'committed_adopted_closed' && EVIDENCE_KEYS.slice(2).every(key => sha(value[key])), 'INVALID_TERMINAL');
    const result = Object.fromEntries(EVIDENCE_KEYS.map(key => [key, value[key]]));
    need(Buffer.from(copy).equals(Buffer.from(JSON.stringify(result))), 'INVALID_TERMINAL');
    return Object.freeze(result);
  } catch {throw Error('NATIVE_EXECUTOR_INVALID_TERMINAL');}
}
function anchorSnapshot(bytes) {
  try {
    need(types.isUint8Array(bytes) && !types.isProxy(bytes), 'INVALID_ANCHOR');
    const prototype = Object.getPrototypeOf(Uint8Array.prototype);
    const size = Object.getOwnPropertyDescriptor(prototype, 'byteLength').get.call(bytes);
    const backing = Object.getOwnPropertyDescriptor(prototype, 'buffer').get.call(bytes);
    need(size > 0 && size <= 1024 && !types.isSharedArrayBuffer(backing), 'INVALID_ANCHOR');
    const copy = new Uint8Array(size); Uint8Array.prototype.set.call(copy, bytes);
    const value = strictJSON.parseStrictJSON(copy, {maxBytes: 1024, maxDepth: 2, maxTokens: 20});
    need(exact(value, ['schema', 'rootId', 'inventorySHA256']) && value.schema === 'native-executor-anchor/1'
      && rootId(value.rootId) && sha(value.inventorySHA256), 'INVALID_ANCHOR');
    const result = {schema: value.schema, rootId: value.rootId, inventorySHA256: value.inventorySHA256};
    need(Buffer.from(copy).equals(Buffer.from(JSON.stringify(result))), 'INVALID_ANCHOR');
    return Object.freeze(result);
  } catch {throw Error('NATIVE_EXECUTOR_INVALID_ANCHOR');}
}

function safe(fn) {
  try {return fn();}
  catch (error) {
    throw Error(codeOf(error));
  }
}
function checked(bytes) {
  try {return dispatch.parseDispatchRequest(bytes);}
  catch {throw Error('NATIVE_EXECUTOR_INVALID_REQUEST');}
}
function names(dir) {
  const handle = fs.opendirSync(dir), entries = [];
  try {
    let entry;
    while ((entry = handle.readSync()) !== null) {
      entries.push(entry.name); if (entries.length > 1) break;
    }
  } finally {handle.closeSync();}
  return entries;
}

// Both indexes are permanent holds. Observation is never a dispatch or cleanup
// permit, including when only one side survived an interrupted publication.
export function createNativeExecutorJournal(options = {}) {
  need(exact(options, []) || exact(options, ['root']), 'INVALID_OPTIONS');
  const candidate = options.root ?? path.join(paths.resolvePaths().build, 'native-install-executor');
  need(typeof candidate === 'string' && candidate.length <= 4096 && path.isAbsolute(candidate)
    && !/[\x00-\x1f]/.test(candidate), 'INVALID_ROOT');
  const root = path.resolve(candidate), jobsRoot = path.join(root, 'jobs'), terminalsRoot = path.join(root, 'terminals');
  const intents = createNativeIntentJournal({root: path.join(root, 'operations')});
  const seenJobs = new Set();
  let rootPins, jobsPins, terminalsPins, pendingReservationInProgress = false;
  let provisionPhase = 'unused';
  function writable() {
    if (provisionPhase === 'checking') provisionPhase = 'held';
    need(provisionPhase !== 'held', 'PROVISION_HELD');
  }
  function roots(create) {
    const current = io.ancestry(root, create);
    if (rootPins) {need(current, 'PATH_CHANGED'); io.sameAncestry(root, rootPins);}
    else if (current) rootPins = current;
    return current;
  }
  function jobs(create) {
    const current = io.ancestry(jobsRoot, create);
    io.sameAncestry(root, rootPins);
    if (jobsPins) {need(current, 'PATH_CHANGED'); io.sameAncestry(jobsRoot, jobsPins);}
    else if (current) jobsPins = current;
    return current;
  }
  function result(operationId, nativeJobId, intent = null, binding = null) {
    const intentObserved = intent?.state === 'intent_observed';
    const jobReservationObserved = binding !== null;
    return Object.freeze({schema: 'native-executor-status/1', operationId, nativeJobId,
      state: intentObserved ? jobReservationObserved ? 'reserved' : 'intent_only'
        : jobReservationObserved ? 'reservation_only' : 'not_observed',
      intentObserved, jobReservationObserved, request: intentObserved ? intent.request : null,
      requestSHA256: intentObserved ? intent.requestSHA256 : binding?.requestSHA256 ?? null,
      packetSHA256: binding?.packetSHA256 ?? null, workerLifetime: binding?.workerLifetime ?? null,
      dispatchState: 'unknown', reconcileRequired: true, canReplay: false,
      effectsAllowed: false, powerLossPersistenceVerified: false});
  }
  function reservation(operationId, requestSHA256, nativeJobId, packetSHA256) {
    if (!jobs(false)) return null;
    const dir = path.join(jobsRoot, nativeJobId); let stat;
    try {stat = fs.lstatSync(dir, {bigint: true});}
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      need(!seenJobs.has(nativeJobId), 'PATH_CHANGED'); return null;
    }
    seenJobs.add(nativeJobId);
    need(stat.isDirectory() && !stat.isSymbolicLink(), 'UNSAFE_PATH');
    const pins = io.ancestry(dir);
    // Do not adopt replacement ancestors discovered while finding the child.
    io.sameAncestry(root, rootPins); io.sameAncestry(jobsRoot, jobsPins);
    need(JSON.stringify(names(dir)) === '["binding.json"]', 'CORRUPT');
    const observations = new Map(), file = path.join(dir, 'binding.json');
    const record = io.readJSON(file, observations);
    need(exact(record, BINDING_KEYS) && record.schema === 'native-executor-binding/1'
      && id(record.operationId, 'op') && id(record.nativeJobId, 'exec')
      && id(record.workerLifetime, 'worker') && sha(record.requestSHA256) && sha(record.packetSHA256)
      && record.rootId === rootPins.get(root) && record.jobsRootId === jobsPins.get(jobsRoot)
      && record.directoryId === identity(stat), 'CORRUPT');
    need(record.operationId === operationId && record.nativeJobId === nativeJobId
      && record.requestSHA256 === requestSHA256 && record.packetSHA256 === packetSHA256, 'BINDING_MISMATCH');
    io.sameAncestry(dir, pins);
    need(JSON.stringify(names(dir)) === '["binding.json"]'
      && generation(fs.lstatSync(file, {bigint: true})) === observations.get(file), 'CHANGED');
    io.sameAncestry(dir, pins);
    return record;
  }
  function read(operationId, expectedRequestSHA256, expectedNativeJobId, expectedPacketSHA256) {
    return safe(() => {
      need(id(operationId, 'op') && id(expectedNativeJobId, 'exec'), 'INVALID_ID');
      need(sha(expectedRequestSHA256) && sha(expectedPacketSHA256), 'INVALID_BINDING');
      if (!roots(false)) return result(operationId, expectedNativeJobId);
      const intent = intents.read(operationId, expectedRequestSHA256);
      io.sameAncestry(root, rootPins);
      if (intent.state === 'intent_observed')
        need(intent.request.nativeJobId === expectedNativeJobId, 'JOB_BINDING_MISMATCH');
      const binding = reservation(operationId, expectedRequestSHA256, expectedNativeJobId, expectedPacketSHA256);
      io.sameAncestry(root, rootPins);
      if (jobsPins) io.sameAncestry(jobsRoot, jobsPins);
      return result(operationId, expectedNativeJobId, intent, binding);
    });
  }
  function begin(requestBytes, workerLifetime, packetSHA256) {
    return safe(() => {
      writable();
      const request = checked(requestBytes);
      need(id(workerLifetime, 'worker'), 'INVALID_WORKER_LIFETIME');
      need(sha(packetSHA256), 'INVALID_BINDING');
      const canonicalBytes = Buffer.from(JSON.stringify(request));
      const requestSHA256 = dispatch.dispatchRequestDigest(canonicalBytes);
      roots(true);
      // Publish the operation hold first. A failed job reservation must never
      // refund it, remove either index, or authorize another worker attempt.
      intents.begin(canonicalBytes);
      io.sameAncestry(root, rootPins);
      jobs(true);
      const dir = path.join(jobsRoot, request.nativeJobId);
      try {fs.mkdirSync(dir, {mode: 0o700});}
      catch (error) {if (error.code === 'EEXIST') throw Error('NATIVE_EXECUTOR_JOB_EXISTS_HOLD'); throw error;}
      seenJobs.add(request.nativeJobId);
      const pins = io.ancestry(dir);
      io.sameAncestry(root, rootPins); io.sameAncestry(jobsRoot, jobsPins);
      const bytes = Buffer.from(JSON.stringify({schema: 'native-executor-binding/1',
        operationId: request.operationId, nativeJobId: request.nativeJobId, requestSHA256,
        packetSHA256, workerLifetime, rootId: rootPins.get(root),
        jobsRootId: jobsPins.get(jobsRoot), directoryId: pins.get(dir)}) + '\n');
      need(bytes.length <= 8192, 'LIMIT');
      const guard = () => {
        io.sameAncestry(root, rootPins); io.sameAncestry(jobsRoot, jobsPins);
        io.sameAncestry(dir, pins); need(names(dir).length === 0, 'CHANGED');
      };
      io.publish(dir, 'binding.json', bytes, pins, guard);
      const observed = read(request.operationId, requestSHA256, request.nativeJobId, packetSHA256);
      need(observed.state === 'reserved' && observed.workerLifetime === workerLifetime, 'CHANGED');
      return observed;
    });
  }
  function terminals(create) {
    const current = io.ancestry(terminalsRoot, create);
    io.sameAncestry(root, rootPins);
    if (terminalsPins) {need(current, 'PATH_CHANGED'); io.sameAncestry(terminalsRoot, terminalsPins);}
    else if (current) terminalsPins = current;
    return current;
  }
  function terminalRecord(binding, job, reader = (file, observations) => io.readJSON(file, observations)) {
    if (!terminals(false)) return null;
    const dir = path.join(terminalsRoot, binding.operationId); let stat;
    try {stat = fs.lstatSync(dir, {bigint: true});}
    catch (error) {if (error.code === 'ENOENT') return null; throw error;}
    need(stat.isDirectory() && !stat.isSymbolicLink(), 'UNSAFE_PATH');
    const pins = io.ancestry(dir), observations = new Map(), file = path.join(dir, 'terminal.json');
    io.sameAncestry(root, rootPins); io.sameAncestry(terminalsRoot, terminalsPins);
    need(JSON.stringify(names(dir)) === '["terminal.json"]', 'TERMINAL_CORRUPT');
    const record = reader(file, observations);
    need(exact(record, TERMINAL_KEYS) && record.schema === 'native-executor-terminal/1'
      && Object.keys(binding).every(key => record[key] === binding[key])
      && record.rootId === rootPins.get(root) && record.jobsRootId === jobsPins.get(jobsRoot)
      && record.jobDirectoryId === job.directoryId && record.terminalsRootId === terminalsPins.get(terminalsRoot)
      && record.directoryId === identity(stat) && sha(record.evidenceSHA256), 'TERMINAL_BINDING_MISMATCH');
    const evidence = Object.fromEntries(EVIDENCE_KEYS.map(key => [key,
      key === 'schema' ? 'native-executor-terminal-evidence/1' : record[key]]));
    evidenceSnapshot(Buffer.from(JSON.stringify(evidence)));
    need(hash(Buffer.from(JSON.stringify(evidence))) === record.evidenceSHA256, 'TERMINAL_CORRUPT');
    io.sameAncestry(dir, pins);
    need(JSON.stringify(names(dir)) === '["terminal.json"]'
      && generation(fs.lstatSync(file, {bigint: true})) === observations.get(file), 'CHANGED');
    io.sameAncestry(dir, pins); io.sameAncestry(root, rootPins);
    io.sameAncestry(terminalsRoot, terminalsPins); io.sameAncestry(jobsRoot, jobsPins);
    return record;
  }
  function appendTerminal(originalBinding, evidenceBytes) {
    return safe(() => {
      writable();
      const binding = bindingSnapshot(originalBinding), evidence = evidenceSnapshot(evidenceBytes);
      const status = read(binding.operationId, binding.requestSHA256, binding.nativeJobId, binding.packetSHA256);
      need(status.state === 'reserved' && status.workerLifetime === binding.workerLifetime, 'TERMINAL_NOT_RESERVED');
      const job = reservation(binding.operationId, binding.requestSHA256, binding.nativeJobId, binding.packetSHA256);
      need(job && job.workerLifetime === binding.workerLifetime, 'TERMINAL_BINDING_MISMATCH');
      terminals(true);
      const dir = path.join(terminalsRoot, binding.operationId);
      try {fs.mkdirSync(dir, {mode: 0o700});}
      catch (error) {if (error.code === 'EEXIST') throw Error('NATIVE_EXECUTOR_TERMINAL_EXISTS_HOLD'); throw error;}
      const pins = io.ancestry(dir);
      io.sameAncestry(root, rootPins); io.sameAncestry(jobsRoot, jobsPins); io.sameAncestry(terminalsRoot, terminalsPins);
      const record = {schema: 'native-executor-terminal/1', ...binding,
        rootId: rootPins.get(root), jobsRootId: jobsPins.get(jobsRoot), jobDirectoryId: job.directoryId,
        terminalsRootId: terminalsPins.get(terminalsRoot), directoryId: pins.get(dir),
        ...Object.fromEntries(EVIDENCE_KEYS.slice(1).map(key => [key, evidence[key]])),
        evidenceSHA256: hash(Buffer.from(JSON.stringify(evidence)))};
      const guard = () => {
        io.sameAncestry(dir, pins); io.sameAncestry(root, rootPins); io.sameAncestry(jobsRoot, jobsPins);
        io.sameAncestry(terminalsRoot, terminalsPins); need(names(dir).length === 0, 'CHANGED');
        const current = read(binding.operationId, binding.requestSHA256, binding.nativeJobId, binding.packetSHA256);
        need(current.state === 'reserved' && current.workerLifetime === binding.workerLifetime, 'TERMINAL_BINDING_MISMATCH');
      };
      io.publish(dir, 'terminal.json', encoded(record), pins, guard);
      const observed = terminalRecord(binding, job);
      need(observed && JSON.stringify(observed) === JSON.stringify(record), 'CHANGED');
      const final = inventory({expectedRootId: rootPins.get(root)});
      need(final.complete && final.records.some(row => row.operationId === binding.operationId
        && row.state === 'historical_closed' && row.evidenceSHA256 === record.evidenceSHA256), 'CHANGED');
      return Object.freeze({schema: 'native-executor-terminal-observation/1', ...binding,
        state: 'historical_closed', evidenceSHA256: record.evidenceSHA256,
        historicalOnly: true, independentCompletionVerified: false, currentStateVerified: false,
        canReplay: false, effectsAllowed: false, installationPermit: false, powerLossPersistenceVerified: false});
    });
  }
  function inspectInventory(options = {}) {
    let expectedRootId, expectedInventorySHA256;
    safe(() => {
      need(options !== null && typeof options === 'object' && !types.isProxy(options), 'INVALID_OPTIONS');
      const descriptors = Object.getOwnPropertyDescriptors(options), keys = Reflect.ownKeys(descriptors);
      need(keys.length <= 2 && keys.every(key => ['expectedRootId', 'expectedInventorySHA256'].includes(key)
        && 'value' in descriptors[key]), 'INVALID_OPTIONS');
      expectedRootId = descriptors.expectedRootId?.value;
      expectedInventorySHA256 = descriptors.expectedInventorySHA256?.value;
      need(expectedRootId === undefined || rootId(expectedRootId), 'INVALID_ROOT_ID');
      need(expectedInventorySHA256 === undefined || sha(expectedInventorySHA256), 'INVALID_INVENTORY_SHA');
    });
    let observedRootId = null;
    const response = (complete, rows, code = null, observedInventorySHA256 = null) => {
      const closed = rows.filter(row => row.state === 'historical_closed').length;
      const rootIdentityVerified = complete && expectedRootId !== undefined && expectedRootId === observedRootId;
      const historySealVerified = rootIdentityVerified && expectedInventorySHA256 !== undefined
        && expectedInventorySHA256 === observedInventorySHA256;
      return {observation: Object.freeze({schema: 'native-executor-inventory/1', complete, observedRootId, rootIdentityVerified,
        observedInventorySHA256, historySealVerified,
        startupHoldRequired: !complete || !historySealVerified || closed !== rows.length,
        observedEmpty: complete && rows.length === 0,
        records: Object.freeze(rows), closedCount: closed, unresolvedCount: rows.length - closed, code,
        historicalOnly: true, independentCompletionVerified: false, currentStateVerified: false,
        discoveryPermit: false, canReplay: false, effectsAllowed: false, installationPermit: false,
        powerLossPersistenceVerified: false}), census: null};
    };
    try {
      if (!roots(false)) return response(false, [], 'NATIVE_EXECUTOR_ROOT_MISSING');
      observedRootId = rootPins.get(root);
      need(expectedRootId === undefined || expectedRootId === observedRootId, 'ROOT_ID_MISMATCH');
      const directories = new Map(), observations = new Map(); let bytes = 0;
      function consume(size) {
        need(size >= 0n && size <= BigInt(INVENTORY_LIMITS.bytes), 'INVENTORY_LIMIT');
        bytes += Number(size) + 1; need(bytes <= INVENTORY_LIMITS.bytes, 'INVENTORY_LIMIT');
      }
      function list(dir, cap) {
        const before = fs.lstatSync(dir, {bigint: true});
        need(before.isDirectory() && !before.isSymbolicLink(), 'UNSAFE_PATH');
        const entries = [], handle = fs.opendirSync(dir);
        try {let entry; while ((entry = handle.readSync()) !== null) {
          need(entries.length < cap, 'INVENTORY_LIMIT'); entries.push(entry.name);
        }} finally {handle.closeSync();}
        entries.sort();
        need(generation(fs.lstatSync(dir, {bigint: true})) === generation(before), 'CHANGED');
        const pins = io.ancestry(dir); io.sameAncestry(root, rootPins);
        directories.set(dir, {stamp: generation(before), entries, pins});
        return entries;
      }
      function readRecord(file, maxBytes) {
        const stat = fs.lstatSync(file, {bigint: true});
        need(stat.size > 0n && stat.size <= BigInt(maxBytes), 'INVENTORY_LIMIT');
        consume(stat.size);
        // The I/O layer's own admission must not grow beyond this admitted
        // generation or the charged byte count, even if the path changes now.
        const reader = createImmutableRecordIO({maxBytes: Number(stat.size), prefix: 'NATIVE_EXECUTOR_'});
        const value = reader.readJSON(file, observations), stamp = observations.get(file);
        need(stamp === generation(stat), 'CHANGED');
        // Records produced by this journal have one exact compact JSON encoding.
        consume(stat.size); const again = new Map(); reader.readJSON(file, again, encoded(value));
        need(again.get(file) === stamp, 'CHANGED');
        return value;
      }
      const top = list(root, 3);
      need(top.every(name => ['operations', 'jobs', 'terminals'].includes(name)), 'INVENTORY_CORRUPT');
      const records = {operations: new Map(), jobs: new Map(), terminals: new Map()};
      for (const kind of top) {
        const parent = path.join(root, kind), entries = list(parent, INVENTORY_LIMITS.records);
        for (const name of entries) {
          need(id(name, kind === 'jobs' ? 'exec' : 'op'), 'INVENTORY_CORRUPT');
          const dir = path.join(parent, name), fileName = kind === 'operations' ? 'intent.json'
            : kind === 'jobs' ? 'binding.json' : 'terminal.json';
          need(JSON.stringify(list(dir, 1)) === JSON.stringify([fileName]), 'INVENTORY_CORRUPT');
          const file = path.join(dir, fileName), max = kind === 'operations' ? dispatch.LIMITS.bytes + 4096 : 8192;
          const record = readRecord(file, max);
          records[kind].set(name, {record, file, digest: hash(encoded(record))});
        }
      }
      const operationIds = new Set(records.operations.keys()), jobsByOperation = new Map();
      for (const [jobId, {record}] of records.jobs) {
        need(exact(record, BINDING_KEYS) && record.schema === 'native-executor-binding/1'
          && record.nativeJobId === jobId && id(record.operationId, 'op') && id(record.workerLifetime, 'worker')
          && sha(record.requestSHA256) && sha(record.packetSHA256) && record.rootId === rootPins.get(root)
          && record.jobsRootId === directories.get(jobsRoot).pins.get(jobsRoot)
          && record.directoryId === directories.get(path.join(jobsRoot, jobId)).pins.get(path.join(jobsRoot, jobId)), 'INVENTORY_CORRUPT');
        need(!jobsByOperation.has(record.operationId), 'INVENTORY_CORRUPT');
        seenJobs.add(jobId);
        jobsByOperation.set(record.operationId, records.jobs.get(jobId));
        operationIds.add(record.operationId);
      }
      for (const opId of records.terminals.keys()) operationIds.add(opId);
      for (const jobId of seenJobs) need(records.jobs.has(jobId), 'PATH_CHANGED');
      need(operationIds.size <= INVENTORY_LIMITS.records, 'INVENTORY_LIMIT');
      const rows = [], census = [], boundJobsSeen = new Set();
      for (const opId of [...operationIds].sort()) {
        const intent = records.operations.get(opId); let request = null, requestSHA256 = null;
        if (intent) {
          request = checked(Buffer.from(JSON.stringify(intent.record.request)));
          requestSHA256 = dispatch.dispatchRequestDigest(Buffer.from(JSON.stringify(request)));
          need(exact(intent.record, ['schema', 'operationId', 'requestSHA256', 'rootId', 'directoryId', 'request'])
            && intent.record.schema === 'native-intent-record/1' && intent.record.operationId === opId
            && intent.record.rootId === directories.get(path.join(root, 'operations')).pins.get(path.join(root, 'operations'))
            && intent.record.directoryId === directories.get(path.dirname(intent.file)).pins.get(path.dirname(intent.file))
            && request.operationId === opId && intent.record.requestSHA256 === requestSHA256, 'INVENTORY_CORRUPT');
        }
        const job = jobsByOperation.get(opId);
        census.push({operationId: opId, nativeJobId: request?.nativeJobId ?? job?.record.nativeJobId ?? null,
          requestSHA256: requestSHA256 ?? job?.record.requestSHA256 ?? null,
          packetSHA256: job?.record.packetSHA256 ?? null, workerLifetime: job?.record.workerLifetime ?? null,
          intentRecordSHA256: intent?.digest ?? null, jobRecordSHA256: job?.digest ?? null,
          terminalRecordSHA256: records.terminals.get(opId)?.digest ?? null});
        if (!intent || !job) {
          need(!records.terminals.has(opId), 'TERMINAL_NOT_RESERVED');
          rows.push(Object.freeze({operationId: opId, nativeJobId: request?.nativeJobId ?? job?.record.nativeJobId ?? null,
            requestSHA256, packetSHA256: job?.record.packetSHA256 ?? null, state: 'unresolved',
            reason: intent ? 'intent_only' : 'reservation_only'}));
          continue;
        }
        need(!boundJobsSeen.has(job.record.nativeJobId), 'INVENTORY_CORRUPT'); boundJobsSeen.add(job.record.nativeJobId);
        const binding = bindingSnapshot({operationId: opId, nativeJobId: request.nativeJobId, requestSHA256,
          packetSHA256: job.record.packetSHA256, workerLifetime: job.record.workerLifetime});
        need(job.record.nativeJobId === binding.nativeJobId && job.record.requestSHA256 === requestSHA256, 'BINDING_MISMATCH');
        let terminal = null;
        if (records.terminals.has(opId)) {
          const cached = records.terminals.get(opId); terminal = cached.record;
          need(exact(terminal, TERMINAL_KEYS) && terminal.schema === 'native-executor-terminal/1'
            && Object.keys(binding).every(key => terminal[key] === binding[key])
            && terminal.rootId === observedRootId
            && terminal.jobsRootId === directories.get(jobsRoot).pins.get(jobsRoot)
            && terminal.jobDirectoryId === job.record.directoryId
            && terminal.terminalsRootId === directories.get(terminalsRoot).pins.get(terminalsRoot)
            && terminal.directoryId === directories.get(path.dirname(cached.file)).pins.get(path.dirname(cached.file))
            && sha(terminal.evidenceSHA256), 'TERMINAL_BINDING_MISMATCH');
          const evidence = Object.fromEntries(EVIDENCE_KEYS.map(key => [key,
            key === 'schema' ? 'native-executor-terminal-evidence/1' : terminal[key]]));
          evidenceSnapshot(Buffer.from(JSON.stringify(evidence)));
          need(hash(Buffer.from(JSON.stringify(evidence))) === terminal.evidenceSHA256, 'TERMINAL_CORRUPT');
        }
        rows.push(Object.freeze({...binding, state: terminal ? 'historical_closed' : 'unresolved',
          reason: terminal ? null : 'terminal_missing', evidenceSHA256: terminal?.evidenceSHA256 ?? null}));
      }
      // The complete census and every initially read file must remain unchanged.
      for (const [dir, snapshot] of directories) {
        io.sameAncestry(dir, snapshot.pins);
        need(generation(fs.lstatSync(dir, {bigint: true})) === snapshot.stamp, 'CHANGED');
        const handle = fs.opendirSync(dir), found = [];
        try {let entry; while ((entry = handle.readSync()) !== null) {
          need(found.length < snapshot.entries.length, 'CHANGED'); found.push(entry.name);
        }} finally {handle.closeSync();}
        need(JSON.stringify(found.sort()) === JSON.stringify(snapshot.entries), 'CHANGED');
        io.sameAncestry(dir, snapshot.pins);
      }
      for (const [file, stamp] of observations)
        need(generation(fs.lstatSync(file, {bigint: true})) === stamp, 'CHANGED');
      for (const [dir, snapshot] of directories) {
        io.sameAncestry(dir, snapshot.pins);
        need(generation(fs.lstatSync(dir, {bigint: true})) === snapshot.stamp, 'CHANGED');
      }
      io.sameAncestry(root, rootPins);
      const document = {schema: 'native-executor-census/1', rootId: observedRootId, indexes: top, records: census};
      const observedInventorySHA256 = hash(Buffer.from(JSON.stringify(document)));
      const result = response(true, rows, expectedInventorySHA256 !== undefined && expectedInventorySHA256 !== observedInventorySHA256
        ? 'NATIVE_EXECUTOR_INVENTORY_MISMATCH' : null, observedInventorySHA256);
      result.census = document;
      return result;
    } catch (error) {return response(false, [], codeOf(error));}
  }
  function inventory(options = {}) {return inspectInventory(options).observation;}
  // The caller supplies the independently retained main anchor, never a seal
  // discovered and automatically echoed from this journal. This verifies only
  // the disk transition; main must still COMMIT/read back its successor anchor.
  function reservePending(requestBytes, workerLifetime, packetSHA256, anchorBytes) {
    return safe(() => {
      writable();
      const anchor = anchorSnapshot(anchorBytes), request = checked(requestBytes);
      need(id(workerLifetime, 'worker') && sha(packetSHA256), 'INVALID_BINDING');
      need(!pendingReservationInProgress, 'RESERVATION_BUSY');
      pendingReservationInProgress = true;
      try {
        const before = inspectInventory({expectedRootId: anchor.rootId, expectedInventorySHA256: anchor.inventorySHA256});
        need(before.observation.complete && before.observation.historySealVerified
          && !before.observation.startupHoldRequired && before.census !== null, 'PREDECESSOR_NOT_SEALED');
        need(before.census.records.length < INVENTORY_LIMITS.records, 'INVENTORY_LIMIT');
        need(!before.census.records.some(row => row.operationId === request.operationId || row.nativeJobId === request.nativeJobId), 'RESERVATION_CONSUMED');
        const reservation = begin(Buffer.from(JSON.stringify(request)), workerLifetime, packetSHA256);
        const after = inspectInventory({expectedRootId: anchor.rootId});
        need(after.observation.complete && after.census !== null, 'RESERVATION_TRANSITION_CHANGED');
        const expectedIndexes = [...new Set([...before.census.indexes, 'operations', 'jobs'])].sort();
        need(JSON.stringify(after.census.indexes) === JSON.stringify(expectedIndexes)
          && after.census.records.length === before.census.records.length + 1, 'RESERVATION_TRANSITION_CHANGED');
        for (const prior of before.census.records) {
          const current = after.census.records.find(row => row.operationId === prior.operationId);
          need(current && JSON.stringify(current) === JSON.stringify(prior), 'RESERVATION_TRANSITION_CHANGED');
        }
        const added = after.census.records.find(row => row.operationId === request.operationId);
        need(added && added.nativeJobId === request.nativeJobId && added.requestSHA256 === reservation.requestSHA256
          && added.packetSHA256 === packetSHA256 && added.workerLifetime === workerLifetime
          && sha(added.intentRecordSHA256) && sha(added.jobRecordSHA256) && added.terminalRecordSHA256 === null,
        'RESERVATION_TRANSITION_CHANGED');
        return Object.freeze({schema: 'native-executor-pending-reservation/1', reservation,
          transition: Object.freeze({schema: 'native-executor-pending-transition/1', rootId: anchor.rootId,
            previousInventorySHA256: anchor.inventorySHA256, inventorySHA256: after.observation.observedInventorySHA256,
            operationId: request.operationId, nativeJobId: request.nativeJobId, requestSHA256: reservation.requestSHA256,
            packetSHA256, workerLifetime})});
      } finally {pendingReservationInProgress = false;}
    });
  }
  // Exclusive genesis observation only. The existing ordinary parent is a
  // caller setup precondition; this method never recursively creates/adopts it.
  // Main must independently CAS the returned anchor before any pending START.
  function provision() {
    return safe(() => {
      if (provisionPhase !== 'unused') {provisionPhase = 'held'; need(false, 'PROVISION_REFUSED');}
      provisionPhase = 'checking';
      const current = () => need(provisionPhase === 'checking', 'PROVISION_HELD');
      try {
        const parent = path.dirname(root), parentPins = io.ancestry(parent);
        current(); need(parentPins !== null, 'PROVISION_PARENT_MISSING');
        // EEXIST is terminal: even an empty existing directory is not ours.
        fs.mkdirSync(root, {mode: 0o700});
        current(); io.sameAncestry(parent, parentPins);
        const made = fs.lstatSync(root, {bigint: true});
        need(made.isDirectory() && !made.isSymbolicLink(), 'UNSAFE_PATH');
        const madeId = identity(made), madeGeneration = generation(made);
        need(rootId(madeId), 'INVALID_ROOT_ID');
        const pins = io.ancestry(root); current();
        need(pins !== null && pins.get(root) === madeId, 'PATH_CHANGED');
        if (rootPins) io.sameAncestry(root, rootPins);
        rootPins = pins;
        const first = inspectInventory({expectedRootId: madeId}); current();
        need(first.observation.complete && first.observation.observedEmpty
          && first.observation.records.length === 0 && first.census !== null
          && first.census.indexes.length === 0 && first.census.records.length === 0
          && first.observation.observedRootId === madeId && sha(first.observation.observedInventorySHA256),
        'PROVISION_CENSUS_FAILED');
        const anchor = Object.freeze({schema: 'native-executor-anchor/1', rootId: madeId,
          inventorySHA256: first.observation.observedInventorySHA256});
        const second = inspectInventory({expectedRootId: madeId, expectedInventorySHA256: anchor.inventorySHA256});
        current();
        need(second.observation.complete && second.observation.historySealVerified
          && second.observation.observedEmpty && !second.observation.startupHoldRequired
          && second.census !== null && second.census.indexes.length === 0 && second.census.records.length === 0,
        'PROVISION_CENSUS_FAILED');
        io.sameAncestry(parent, parentPins); io.sameAncestry(root, pins); current();
        need(generation(fs.lstatSync(root, {bigint: true})) === madeGeneration && names(root).length === 0,
          'PROVISION_CHANGED');
        io.sameAncestry(parent, parentPins); io.sameAncestry(root, pins); current();
        need(generation(fs.lstatSync(root, {bigint: true})) === madeGeneration, 'PROVISION_CHANGED');
        const receipt = Object.freeze({schema: 'native-executor-genesis-observation/1', anchor,
          effectsAllowed: false, installationPermit: false, powerLossPersistenceVerified: false});
        provisionPhase = 'complete';
        return receipt;
      } catch (error) {provisionPhase = 'held'; throw error;}
    });
  }
  return Object.freeze({begin, read, appendTerminal, inventory, reservePending, provision});
}
