'use strict';

const {createHash} = require('node:crypto');
const SCHEMA = 'installed-candidate-assessment/1';
const STATUSES = Object.freeze(['compatible_installed_variant', 'conflict', 'insufficient_evidence']);
const REASONS = Object.freeze(['COLLECTION_REVISION_MISMATCH', 'TARGET_NOT_INSTALLED', 'TARGET_TYPE_MISMATCH',
  'SELECTED_RULE_NOT_FOUND', 'SELECTED_RULE_AMBIGUOUS', 'RULE_ID_UNAVAILABLE', 'NATIVE_API_UNAVAILABLE',
  'NATIVE_MATCH_FAILED', 'NATIVE_MATCH_INVALID', 'RULE_METADATA_UNKNOWN', 'IGNORED_REQUIREMENT_REVIEW_REQUIRED',
  'OLD_INSTALL_SPEC_MISMATCH', 'CANDIDATE_IDENTITY_CONFLICT',
  'CANDIDATE_INSTALL_SPEC_CONFLICT', 'CUSTOMIZATIONS_REVIEW_REQUIRED', 'PREFERENCES_REVIEW_REQUIRED',
  'OVERRIDES_REVIEW_REQUIRED', 'OUTGOING_RULES_REVIEW_REQUIRED', 'CANDIDATE_REQUIRES_REVIEW_REQUIRED',
  'PROFILE_FLAGS_UNKNOWN', 'PROFILE_PENDING_REMOVE', 'PROFILE_PENDING_REMOVE_UNKNOWN']);
const LIMITS = Object.freeze({comparisons: 20, profiles: 2000, mods: 10000, allGameMods: 20000,
  rules: 50000, matcherChecks: 200000, incomingRequires: 5000, archiveReferences: 5000,
  profileReferences: 5000, responseBytes: 2 * 1024 * 1024, snapshotBytes: 16 * 1024 * 1024,
  cloneBytes: 512 * 1024, cloneNodes: 100000, cloneDepth: 16, stringBytes: 65536,
  nativeCloneBytes: 64 * 1024 * 1024, nativeCloneNodes: 1000000, fingerprintBytes: 64 * 1024 * 1024});
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v)
  && [Object.prototype, null].includes(Object.getPrototypeOf(v));
const id = v => typeof v === 'string' && v.length > 0 && v.length <= 200 && !/[\x00-\x1f\x7f]/.test(v);
const positive = v => Number.isSafeInteger(v) && v > 0;
const need = (ok, code) => {if (!ok) throw Error('ASSESSMENT_' + code);};
const own = (v, k) => Object.hasOwn(v, k);
const nonempty = v => v !== undefined && v !== null && (typeof v === 'object' ? Object.keys(v).length > 0 : v !== '');
// Exact fields consumed by the reviewed 2.9.1 modAttributesToLookupInfo and
// modMatchesInstallSpec; variant is additionally retained for migration review.
const nativeFields = ['source', 'modId', 'fileId', 'fileMD5', 'fileSize', 'fileName', 'modName', 'name',
  'logicalFileName', 'additionalLogicalFileNames', 'customFileName', 'version', 'modVersion', 'game',
  'referenceTag', 'referenceTags', 'installerChoices', 'fileList', 'patches', 'variant'];

// Read only plain data descriptors. Bound the work before building JSON, and do
// not hand Redux objects (or a previous helper's mutable arguments) to native code.
function cloner(maxBytes = LIMITS.cloneBytes, ledger) {
  let bytes = 0, nodes = 0;
  const chain = new Set();
  const charge = n => {
    bytes += n; need(bytes <= maxBytes, 'READ_LIMIT');
    if (ledger) {ledger.bytes += n; need(ledger.bytes <= LIMITS.nativeCloneBytes, 'READ_LIMIT');}
  };
  function clone(v, depth = 0) {
    need(++nodes <= LIMITS.cloneNodes && depth <= LIMITS.cloneDepth, 'READ_LIMIT');
    if (ledger) need(++ledger.nodes <= LIMITS.nativeCloneNodes, 'READ_LIMIT');
    if (v === null || typeof v === 'boolean') {charge(5); return v;}
    if (typeof v === 'number') {need(Number.isFinite(v), 'STATE_INVALID'); charge(24); return v;}
    if (typeof v === 'string') {
      const n = Buffer.byteLength(v); need(n <= LIMITS.stringBytes, 'READ_LIMIT'); charge(n + 2); return v;
    }
    need(Array.isArray(v) || object(v), 'STATE_INVALID');
    need(!chain.has(v), 'STATE_INVALID'); chain.add(v); charge(2);
    const result = Array.isArray(v) ? [] : {};
    const keys = Reflect.ownKeys(v);
    need(keys.every(k => typeof k === 'string') && keys.length <= LIMITS.cloneNodes, 'READ_LIMIT');
    if (Array.isArray(v)) {
      need(v.length <= LIMITS.cloneNodes && keys.length === v.length + 1, 'STATE_INVALID');
      for (let i = 0; i < v.length; i++) {
        const d = Object.getOwnPropertyDescriptor(v, String(i));
        need(d && own(d, 'value') && d.enumerable, 'STATE_INVALID');
        result.push(clone(d.value, depth + 1));
      }
    } else for (const key of keys.sort()) {
      const d = Object.getOwnPropertyDescriptor(v, key);
      need(d && own(d, 'value') && d.enumerable && d.value !== undefined, 'STATE_INVALID');
      charge(Buffer.byteLength(key) + 3);
      Object.defineProperty(result, key, {value: clone(d.value, depth + 1), enumerable: true, writable: true, configurable: true});
    }
    chain.delete(v); return result;
  }
  return clone;
}
function data(v, key) {
  const d = Object.getOwnPropertyDescriptor(v, key);
  need(!d || own(d, 'value') && d.enumerable, 'STATE_INVALID');
  return d?.value;
}
function pick(v, fields, clone) {
  need(object(v), 'STATE_INVALID');
  const result = {};
  for (const key of fields) {const value = data(v, key); if (value !== undefined) result[key] = clone(value);}
  return result;
}
function validateArgs(args) {
  const plainFields = (value, allowed) => object(value) && Reflect.ownKeys(value).every(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return allowed.includes(key) && descriptor && own(descriptor, 'value') && descriptor.enumerable;
  });
  need(plainFields(args, ['gameId', 'profileId', 'collectionModId', 'expectedRevisionId', 'comparisons'])
    && [args.gameId, args.profileId, args.collectionModId].every(id)
    && (args.expectedRevisionId === undefined || positive(args.expectedRevisionId))
    && Array.isArray(args.comparisons) && args.comparisons.length > 0 && args.comparisons.length <= LIMITS.comparisons,
  'INVALID_REQUEST');
  const seen = new Set();
  for (const row of args.comparisons) {
    need(plainFields(row, ['oldModId', 'candidateModId', 'ruleId'])
      && id(row.oldModId) && id(row.candidateModId) && row.oldModId !== row.candidateModId
      && (row.ruleId === undefined || typeof row.ruleId === 'string' && row.ruleId.trim().length > 0
        && row.ruleId.length <= 4096 && !/[\x00-\x1f\x7f]/.test(row.ruleId)), 'INVALID_REQUEST');
    const key = JSON.stringify([row.oldModId, row.candidateModId, row.ruleId ?? null]);
    need(!seen.has(key), 'INVALID_REQUEST'); seen.add(key);
  }
}

function validateSpecMetadata(spec) {
  need(spec.installerChoices === undefined || object(spec.installerChoices), 'STATE_INVALID');
  need(spec.fileList === undefined || Array.isArray(spec.fileList)
    && spec.fileList.every(v => object(v) && typeof v.path === 'string'), 'STATE_INVALID');
  need(spec.patches === undefined || object(spec.patches) && Object.values(spec.patches).every(v => typeof v === 'string'), 'STATE_INVALID');
}
function validateModMetadata(record) {
  const attrs = record.attributes;
  for (const key of ['source', 'fileMD5', 'fileName', 'modName', 'name', 'logicalFileName', 'customFileName',
    'version', 'modVersion', 'referenceTag', 'variant']) need(attrs[key] === undefined || typeof attrs[key] === 'string', 'STATE_INVALID');
  for (const key of ['modId', 'fileId']) need(attrs[key] === undefined || Number.isSafeInteger(attrs[key]) && attrs[key] >= 0
    || typeof attrs[key] === 'string' && /^\d+$/.test(attrs[key]) && Number.isSafeInteger(Number(attrs[key])), 'STATE_INVALID');
  need(attrs.fileSize === undefined || Number.isSafeInteger(attrs.fileSize) && attrs.fileSize >= 0, 'STATE_INVALID');
  for (const value of [attrs.game, attrs.additionalLogicalFileNames, attrs.referenceTags, record.fileOverrides, record.enabledINITweaks]) {
    need(value === undefined || Array.isArray(value) && value.every(v => typeof v === 'string'), 'STATE_INVALID');
  }
  validateSpecMetadata(attrs);
}

function capture(api, selectors, args) {
  const state = api.getState();
  need(state && selectors.activeGameId(state) === args.gameId && selectors.activeProfileId(state) === args.profileId,
    'CONTEXT_MISMATCH');
  const mods = state.persistent?.mods, profiles = state.persistent?.profiles;
  need(object(mods) && object(profiles) && object(data(mods, args.gameId))
    && object(data(profiles, args.profileId)) && data(profiles[args.profileId], 'gameId') === args.gameId, 'CONTEXT_MISMATCH');
  const clone = cloner(LIMITS.snapshotBytes), targets = new Set(args.comparisons.flatMap(r => [r.oldModId, r.candidateModId]));
  const snapshot = {mods: Object.create(null), profiles: [], archives: [], counts: {profiles: 0, mods: 0, allGameMods: 0, rules: 0}};
  const games = Object.keys(mods).sort(); need(games.length <= LIMITS.allGameMods, 'READ_LIMIT');
  for (const gameId of games) {
    need(id(gameId) && object(mods[gameId]), 'STATE_INVALID');
    const keys = Object.keys(mods[gameId]).sort();
    need(snapshot.counts.allGameMods + keys.length <= LIMITS.allGameMods, 'READ_LIMIT');
    for (const modId of keys) {
      const record = data(mods[gameId], modId);
      need(id(modId) && object(record), 'STATE_INVALID'); snapshot.counts.allGameMods++;
      const archiveId = data(record, 'archiveId');
      need(archiveId === undefined || archiveId === null || typeof archiveId === 'string'
        && /^[A-Za-z0-9_-]{1,128}$/.test(archiveId), 'STATE_INVALID');
      snapshot.archives.push({gameId, modId, archiveId: archiveId ?? null});
      if (gameId !== args.gameId) continue;
      need(++snapshot.counts.mods <= LIMITS.mods, 'READ_LIMIT');
      const projected = pick(record, ['state', 'type', 'fileOverrides', 'enabledINITweaks'], clone);
      need(id(projected.state) && typeof projected.type === 'string' && projected.type.length <= 200
        && !/[\x00-\x1f\x7f]/.test(projected.type), 'STATE_INVALID');
      projected.id = modId; projected.archiveId = archiveId ?? null;
      const attrs = data(record, 'attributes');
      // The supported input is an installed IMod, not a lookup-info object.
      // A root game array changes native modAttributesToLookupInfo's branch.
      need(data(record, 'game') === undefined && (attrs !== undefined
        || nativeFields.every(key => data(record, key) === undefined)), 'STATE_INVALID');
      projected.attributes = attrs === undefined ? {} : pick(attrs, [...nativeFields,
        ...(modId === args.collectionModId ? ['collectionId', 'revisionId', 'revisionNumber'] : [])], clone);
      validateModMetadata(projected);
      const rules = data(record, 'rules');
      need(rules === undefined || Array.isArray(rules), 'STATE_INVALID');
      need(snapshot.counts.rules + (rules?.length ?? 0) <= LIMITS.rules, 'READ_LIMIT');
      snapshot.counts.rules += rules?.length ?? 0;
      if (rules !== undefined) need(Reflect.ownKeys(rules).length === rules.length + 1, 'STATE_INVALID');
      projected.rules = Array.from({length: rules?.length ?? 0}, (_, index) => {
        const rule = data(rules, String(index));
        const selected = pick(rule, ['type', 'reference', 'ignored', 'installerChoices', 'fileList', 'patches', 'phase', 'extra'], clone);
        need(typeof selected.type === 'string' && selected.type.length <= 200, 'STATE_INVALID');
        if (selected.type === 'requires') need(object(selected.reference), 'STATE_INVALID');
        validateSpecMetadata(selected);
        if (selected.extra !== undefined) {
          need(object(selected.extra), 'STATE_INVALID');
          validateSpecMetadata({patches: selected.extra.patches});
          need(selected.extra.fileOverrides === undefined || Array.isArray(selected.extra.fileOverrides)
            && selected.extra.fileOverrides.every(value => typeof value === 'string'), 'STATE_INVALID');
        }
        return selected;
      });
      snapshot.mods[modId] = projected;
    }
  }
  const keys = Object.keys(profiles).sort(); need(keys.length <= LIMITS.profiles, 'READ_LIMIT');
  for (const profileId of keys) {
    snapshot.counts.profiles++;
    const profile = data(profiles, profileId);
    need(id(profileId) && object(profile) && id(data(profile, 'gameId')), 'STATE_INVALID');
    if (profile.gameId !== args.gameId) continue;
    const flags = data(profile, 'modState'); need(flags === undefined || object(flags), 'STATE_INVALID');
    const pending = data(profile, 'pendingRemove');
    const row = {id: profileId, pendingRemove: pending === undefined ? false : typeof pending === 'boolean' ? pending : null, flags: Object.create(null)};
    for (const modId of targets) {
      const present = flags !== undefined && own(flags, modId), flag = present ? data(flags, modId) : undefined;
      const enabled = object(flag) ? data(flag, 'enabled') : undefined;
      row.flags[modId] = {present, enabled: !present ? false : typeof enabled === 'boolean' ? enabled : null};
    }
    snapshot.profiles.push(row);
  }
  const collection = snapshot.mods[args.collectionModId];
  need(collection?.state === 'installed' && collection.type === 'collection'
    && positive(collection.attributes.collectionId) && positive(collection.attributes.revisionId)
    && (collection.attributes.revisionNumber === undefined || positive(collection.attributes.revisionNumber)), 'COLLECTION_INVALID');
  return snapshot;
}

function runAssessment(api, selectors, util, args) {
  validateArgs(args);
  need(typeof api?.getState === 'function' && typeof selectors?.activeGameId === 'function'
    && typeof selectors?.activeProfileId === 'function', 'CONTEXT_UNAVAILABLE');
  const nativeLedger = {bytes: 0, nodes: 0}, detached = value => cloner(LIMITS.cloneBytes, nativeLedger)(value);
  let hashedBytes = 0;
  const fingerprintOf = value => {
    const bytes = JSON.stringify(value);
    hashedBytes += Buffer.byteLength(bytes); need(hashedBytes <= LIMITS.fingerprintBytes, 'READ_LIMIT');
    return createHash('sha256').update(bytes).digest('hex');
  };
  const ruleFingerprints = new WeakMap();
  const nativeIdFingerprints = new Map();
  const nativeIdFingerprintOf = key => {
    if (!nativeIdFingerprints.has(key)) nativeIdFingerprints.set(key, fingerprintOf(key));
    return nativeIdFingerprints.get(key);
  };
  const ruleFingerprintOf = rule => {
    if (!ruleFingerprints.has(rule)) ruleFingerprints.set(rule, fingerprintOf(rule));
    return ruleFingerprints.get(rule);
  };
  const snapshot = capture(api, selectors, args), before = fingerprintOf(snapshot), counts = {...snapshot.counts, matcherChecks: 0};
  const collection = snapshot.mods[args.collectionModId], incoming = Object.entries(snapshot.mods)
    .flatMap(([ownerId, record]) => record.rules.filter(r => r.type === 'requires').map(rule => ({ownerId, rule})));
  let incomingCount = 0, archiveCount = 0, profileCount = 0;
  const comparisons = args.comparisons.map(comparison => {
    const reasons = new Set(), add = code => reasons.add(code);
    let conflict = false;
    const invoke = (name, makeArgs, valid) => {
      if (typeof util?.[name] !== 'function') {add('NATIVE_API_UNAVAILABLE'); return {known: false};}
      need(++counts.matcherChecks <= LIMITS.matcherChecks, 'READ_LIMIT');
      const inputs = makeArgs();
      let value, validResult;
      try {value = util[name](...inputs);}
      catch {add('NATIVE_MATCH_FAILED'); return {known: false};}
      try {validResult = valid(value);}
      catch (error) {if (error?.message === 'ASSESSMENT_READ_LIMIT') throw error; validResult = false;}
      if (!validResult) {add('NATIVE_MATCH_INVALID'); return {known: false};}
      return {known: true, value};
    };
    const identity = (mod, rule) => invoke('testModReference', () => [detached(mod), detached(rule.reference)], v => typeof v === 'boolean');
    const nativeId = rule => {
      // Native modRuleId may fall back to a description or an undefined marker.
      // Its raw text is never returned; uniqueness is checked before hashing.
      const marker = ['tag', 'fileMD5', 'id', 'logicalFileName', 'fileExpression', 'description']
        .map(key => rule.reference[key]).find(Boolean);
      if (typeof marker !== 'string' || marker.trim().length === 0) {add('RULE_ID_UNAVAILABLE'); return null;}
      const result = invoke('modRuleId', () => [detached(rule)], v => typeof v === 'string'
        && v.trim().length > 0 && v.length <= 4096 && !/[\x00-\x1f\x7f]/.test(v));
      return result.known ? result.value : null;
    };
    const profileRows = modId => snapshot.profiles.filter(p => p.id === args.profileId || p.flags[modId].present)
      .map(p => {need(++profileCount <= LIMITS.profileReferences, 'READ_LIMIT'); return {id: p.id, ...p.flags[modId], pendingRemove: p.pendingRemove};});
    const archiveRows = record => record?.archiveId ? snapshot.archives.filter(r => r.archiveId === record.archiveId)
      .map(({gameId, modId}) => {need(++archiveCount <= LIMITS.archiveReferences, 'READ_LIMIT'); return {gameId, modId};}) : [];
    const old = snapshot.mods[comparison.oldModId], candidate = snapshot.mods[comparison.candidateModId];
    const profiles = {old: profileRows(comparison.oldModId), candidate: profileRows(comparison.candidateModId)};
    const archiveReferences = {old: archiveRows(old), candidate: archiveRows(candidate)};
    const review = {customizations: false, preferences: false, overrides: false, outgoingRules: false,
      candidateRequires: false, profileFlags: false, pendingRemove: false};
    for (const p of [...profiles.old, ...profiles.candidate]) {
      if (p.enabled === null) {review.profileFlags = true; add('PROFILE_FLAGS_UNKNOWN');}
      if (p.pendingRemove === null) {review.pendingRemove = true; add('PROFILE_PENDING_REMOVE_UNKNOWN');}
      else if (p.pendingRemove) {review.pendingRemove = true; add('PROFILE_PENDING_REMOVE');}
    }
    const inspectCustomization = record => {
      if (!record) return;
      if (['installerChoices', 'fileList', 'patches'].some(k => nonempty(record.attributes[k]))) review.customizations = true;
      if (nonempty(record.enabledINITweaks) || nonempty(record.attributes.variant)) review.preferences = true;
      if (nonempty(record.fileOverrides)) review.overrides = true;
      if (record.rules.some(r => r.type !== 'requires')) review.outgoingRules = true;
    };
    inspectCustomization(old); inspectCustomization(candidate);
    review.candidateRequires = candidate?.rules.some(r => r.type === 'requires') ?? false;
    let selectedRule = null;
    const matches = [];
    if (args.expectedRevisionId !== undefined && args.expectedRevisionId !== collection.attributes.revisionId) add('COLLECTION_REVISION_MISMATCH');
    if (old?.state !== 'installed' || candidate?.state !== 'installed') add('TARGET_NOT_INSTALLED');
    else if (old.type !== candidate.type || old.type === 'collection') {conflict = true; add('TARGET_TYPE_MISMATCH');}
    else {
      const collectionIds = new Map();
      for (const rule of collection.rules.filter(r => r.type === 'requires')) {
        const key = nativeId(rule);
        if (key !== null) collectionIds.set(key, (collectionIds.get(key) ?? 0) + 1);
      }
      for (const {ownerId, rule} of incoming) {
        const oldMatch = identity(old, rule);
        if (!oldMatch.known || !oldMatch.value) continue;
        need(++incomingCount <= LIMITS.incomingRequires, 'READ_LIMIT');
        const key = nativeId(rule), ruleFingerprint = ruleFingerprintOf(rule), ignored = rule.ignored === undefined ? false
          : typeof rule.ignored === 'boolean' ? rule.ignored : null;
        if (ignored === null) add('RULE_METADATA_UNKNOWN');
        if (ignored === true) add('IGNORED_REQUIREMENT_REVIEW_REQUIRED');
        if (['installerChoices', 'fileList', 'patches'].some(key => nonempty(rule[key]))
          || nonempty(rule.extra?.patches)) review.customizations = true;
        if (nonempty(rule.extra?.fileOverrides)) review.overrides = true;
        const candidateMatch = identity(candidate, rule);
        let normalized;
        const spec = invoke('ruleInstallSpec', () => [detached(rule)], v => {
          if (!object(v)) return false;
          const fields = Reflect.ownKeys(v), clean = {};
          if (fields.length > 3 || fields.some(k => !['installerChoices', 'fileList', 'patches'].includes(k))) return false;
          for (const key of fields) {
            const descriptor = Object.getOwnPropertyDescriptor(v, key);
            if (!descriptor || !own(descriptor, 'value') || !descriptor.enumerable) return false;
            if (descriptor.value !== undefined) clean[key] = descriptor.value;
          }
          normalized = detached(clean);
          validateSpecMetadata(normalized);
          return true;
        });
        let specMatch = null, oldSpecMatch = null;
        if (spec.known) {
          if (Object.values(normalized).some(nonempty)) review.customizations = true;
          const withSpec = (record, modId) => invoke('findModByRef', () => [detached(rule.reference),
            {[modId]: detached(record)}, undefined, detached(normalized)],
          v => v === undefined || object(v) && (() => {const descriptor = Object.getOwnPropertyDescriptor(v, 'id');
            return descriptor && own(descriptor, 'value') && descriptor.value === modId;})());
          const oldResult = withSpec(old, comparison.oldModId);
          if (oldResult.known) oldSpecMatch = oldResult.value !== undefined;
          if (oldSpecMatch === false) add('OLD_INSTALL_SPEC_MISMATCH');
          const result = withSpec(candidate, comparison.candidateModId);
          if (result.known) specMatch = result.value !== undefined;
        }
        if (candidateMatch.known && !candidateMatch.value) {conflict = true; add('CANDIDATE_IDENTITY_CONFLICT');}
        if (candidateMatch.known && candidateMatch.value && specMatch === false) {conflict = true; add('CANDIDATE_INSTALL_SPEC_CONFLICT');}
        const row = {ownerId, ruleIdHash: key === null ? null : nativeIdFingerprintOf(key), fingerprint: ruleFingerprint, ignored,
          identityMatches: candidateMatch.known ? candidateMatch.value : null, installSpecMatches: specMatch,
          oldInstallSpecMatches: oldSpecMatch};
        matches.push(row);
        if (ownerId === args.collectionModId && (comparison.ruleId === undefined || comparison.ruleId === key)) {
          if (key !== null && collectionIds.get(key) === 1) {
            if (selectedRule) {selectedRule = null; add('SELECTED_RULE_AMBIGUOUS');}
            else if (!reasons.has('SELECTED_RULE_AMBIGUOUS')) selectedRule = {ruleIdHash: nativeIdFingerprintOf(key), fingerprint: ruleFingerprint, ignored};
          } else add('SELECTED_RULE_AMBIGUOUS');
        }
      }
      if (!selectedRule) add(reasons.has('SELECTED_RULE_AMBIGUOUS') ? 'SELECTED_RULE_AMBIGUOUS' : 'SELECTED_RULE_NOT_FOUND');
    }
    for (const [field, reason] of [['customizations', 'CUSTOMIZATIONS_REVIEW_REQUIRED'], ['preferences', 'PREFERENCES_REVIEW_REQUIRED'],
      ['overrides', 'OVERRIDES_REVIEW_REQUIRED'], ['outgoingRules', 'OUTGOING_RULES_REVIEW_REQUIRED'], ['candidateRequires', 'CANDIDATE_REQUIRES_REVIEW_REQUIRED']]) {
      if (review[field]) add(reason);
    }
    const orderedReasons = REASONS.filter(reason => reasons.has(reason));
    const status = conflict ? 'conflict' : orderedReasons.length > 0 ? 'insufficient_evidence' : 'compatible_installed_variant';
    const fingerprint = fingerprintOf({schema: SCHEMA, gameId: args.gameId, profileId: args.profileId,
      collectionModId: args.collectionModId, expectedRevisionId: args.expectedRevisionId ?? null,
      sourceSnapshotFingerprint: before, collection: collection.attributes, comparison: {
      oldModId: comparison.oldModId, candidateModId: comparison.candidateModId, ruleId: comparison.ruleId ?? null},
    selectedRule, profiles, archiveReferences, review, observations: matches});
    return {oldModId: comparison.oldModId, candidateModId: comparison.candidateModId, status, reasons: orderedReasons,
      selectedRule, incomingRequires: matches, profiles, archiveReferences, review, fingerprint};
  });
  need(fingerprintOf(capture(api, selectors, args)) === before, 'STATE_CHANGED');
  const result = {protocol: 'vortex-agent/1', schema: SCHEMA,
    status: comparisons.some(row => row.status === 'insufficient_evidence' || row.reasons.some(reason =>
      !['TARGET_TYPE_MISMATCH', 'CANDIDATE_IDENTITY_CONFLICT', 'CANDIDATE_INSTALL_SPEC_CONFLICT'].includes(reason))) ? 'partial' : 'ok',
    gameId: args.gameId, profileId: args.profileId, collection: {modId: args.collectionModId,
      collectionId: collection.attributes.collectionId, revisionId: collection.attributes.revisionId,
      revisionNumber: collection.attributes.revisionNumber ?? null}, metadataOnly: true, effectsAllowed: false,
    migrationReady: false, diskDeploymentVerified: false, limits: {...LIMITS}, counts, comparisons};
  need(Buffer.byteLength(JSON.stringify(result)) <= LIMITS.responseBytes, 'READ_LIMIT');
  return result;
}

function assessInstalledCandidates(api, selectors, util, args) {
  try {return runAssessment(api, selectors, util, args);}
  catch (error) {
    if (/^ASSESSMENT_[A-Z_]+$/.test(error?.message ?? '')) throw error;
    throw Error('ASSESSMENT_STATE_INVALID');
  }
}

module.exports = {assessInstalledCandidates, LIMITS, SCHEMA, STATUSES, REASONS};
