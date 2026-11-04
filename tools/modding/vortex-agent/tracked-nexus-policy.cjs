'use strict';
const { isNativeModId, isDownloadId } = require('./install-settlement.cjs');
const { isProxy } = require('node:util/types');
const crypto = require('node:crypto');
const path = require('node:path').win32;
const need = (value, code) => { if (!value) throw Error(code); };
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const positive = value => Number.isSafeInteger(value) && value > 0;
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\x00-\x1f\x7f]/.test(value);

function createScopePolicy(input) {
  need(input && typeof input === 'object' && !Array.isArray(input), 'EXACT_NEXUS_SCOPE_REQUIRED');
  const pins = structuredClone(input), keys = Object.keys(pins);
  need(keys.length > 0 && keys.length <= 4, 'BOUNDED_NEXUS_SCOPE_REQUIRED');
  for (const key of keys) {
    const p = pins[key];
    need(/^[1-9]\d*$/.test(key) && positive(Number(key)) && p
      && positive(p.nexusFileId) && positive(p.size) && sha(p.sha256) && text(p.version), 'INVALID_NEXUS_SCOPE_PIN');
  }
  function target(p) {
    const x = p && pins[p.nexusModId];
    need(positive(p?.nexusModId) && x && p.nexusFileId === x.nexusFileId
      && p.bytes === x.size && p.sha256 === x.sha256 && p.version === x.version
      && p.key === `${p.nexusModId}-${p.nexusFileId}`, 'EXACT_TRACKED_NEXUS_SCOPE_REQUIRED');
    need(text(p.version) && Array.isArray(p.acceptedVersions) && p.acceptedVersions.includes(p.version)
      && p.acceptedVersions.every(v => typeof v === 'string' && v.length <= 200 && !/[\x00-\x1f\x7f]/.test(v)), 'FRESH_SELECTED_VERSION_REQUIRED');
    need(isDownloadId(p.requiredDownloadId) && isNativeModId(p.expectedModId)
      && typeof p.expectedType === 'string' && p.expectedType.length <= 100 && !/[\x00-\x1f\x7f]/.test(p.expectedType)
      && /^[a-f0-9]{32}$/.test(p.md5 || '') && p.payload && !Array.isArray(p.payload)
      && Object.keys(p.payload).length > 0 && p.crcVerified === true, 'FINAL_TRACKED_PACKAGE_PINS_REQUIRED');
    for (const [name, digest] of Object.entries(p.payload)) {
      need(typeof name === 'string' && name.length <= 1000 && !/[\\:\x00-\x1f\x7f]/.test(name)
        && !name.startsWith('/') && name.split('/').every(v => v && v !== '.' && v !== '..')
        && sha(digest), 'EXACT_PAYLOAD_MAP_REQUIRED');
    }
    need(p.expectedPreviousCaptured === true && Object.hasOwn(p, 'expectedPreviousModId')
      && (p.expectedPreviousModId === null || isNativeModId(p.expectedPreviousModId))
      && typeof p.expectedEnabled === 'boolean' && Array.isArray(p.oldEnabledModIds)
      && p.oldEnabledModIds.every(isNativeModId) && new Set(p.oldEnabledModIds).size === p.oldEnabledModIds.length
      && !p.oldEnabledModIds.includes(p.expectedModId) && p.nativeSelectorInputs
      && sha(p.expectedNativeRulesDigest) && sha(p.expectedNativeOverridesDigest), 'FRESH_NATIVE_PROVIDER_CAPTURE_REQUIRED');
    need(p.expectedEnabled ? p.expectedPreviousModId !== null && p.oldEnabledModIds.length === 1
      && p.oldEnabledModIds[0] === p.expectedPreviousModId : p.oldEnabledModIds.length === 0,
      'EXACT_NATIVE_FLAG_TRANSFER_REQUIRED');
    need(p.sameIdCollisionChecked === true && p.expectedTargetAbsent === true
      && p.previousStagePreservationReviewed === true && p.activePatchedOwnerProtectionReviewed === true
      && sha(p.nativeSelectionEvidenceSHA256) && sha(p.actualInstallationProjectionSHA256), 'REPLACEMENT_AND_MAPPING_REVIEW_REQUIRED');
  }
  function completeScope(rows) {
    need(Array.isArray(rows) && rows.length === keys.length, 'EXACT_TRACKED_NEXUS_COUNT_REQUIRED');
    const seen = new Set(), ids = new Set(), targets = new Set();
    for (const p of rows) {
      target(p);
      need(!seen.has(p.nexusModId) && !ids.has(p.requiredDownloadId)
        && !targets.has(p.expectedModId.toLowerCase()), 'DUPLICATE_TRACKED_NEXUS_TARGET');
      seen.add(p.nexusModId); ids.add(p.requiredDownloadId); targets.add(p.expectedModId.toLowerCase());
    }
    need(keys.every(key => seen.has(Number(key))), 'EXACT_TRACKED_NEXUS_SCOPE_REQUIRED');
    need(rows.every(p => !p.oldEnabledModIds.some(id => targets.has(id.toLowerCase()))
      && (p.expectedPreviousModId === null || !targets.has(p.expectedPreviousModId.toLowerCase()))), 'BATCH_TRANSFER_TARGET_COLLISION');
    return true;
  }
  function captureScope(rows) {
    need(Array.isArray(rows) && rows.length === keys.length, 'EXACT_TRACKED_CAPTURE_COUNT_REQUIRED');
    const seen = new Set(), downloads = new Set(), targets = new Set();
    for (const p of rows) {
      const x = pins[p?.nexusModId];
      need(x && !seen.has(p.nexusModId) && p.nexusFileId === x.nexusFileId
        && p.bytes === x.size && p.sha256 === x.sha256 && p.version === x.version
        && p.key === `${p.nexusModId}-${p.nexusFileId}` && isDownloadId(p.requiredDownloadId)
        && isNativeModId(p.expectedModId) && typeof p.archive === 'string' && p.archive.length <= 4096
        && !/[\x00-\x1f\x7f]/.test(p.archive) && path.isAbsolute(p.archive) && p.crcVerified === true
        && /^[a-f0-9]{32}$/.test(p.md5 || ''), 'EXACT_TRACKED_CAPTURE_INPUT_REQUIRED');
      need(!downloads.has(p.requiredDownloadId) && !targets.has(p.expectedModId.toLowerCase()), 'DUPLICATE_TRACKED_CAPTURE_TARGET');
      seen.add(p.nexusModId); downloads.add(p.requiredDownloadId); targets.add(p.expectedModId.toLowerCase());
    }
    need(keys.every(k => seen.has(Number(k))), 'EXACT_TRACKED_CAPTURE_INPUT_REQUIRED');
    return true;
  }
  return { target, completeScope, captureScope };
}
// Private proof domain: preserve absent/undefined/null, reject getters and proxies.
// The output serializer is deliberately not used for native preservation proofs.
function snapshot(input) {
  let nodes = 0; const ancestors = new Set();
  function copy(v, depth) {
    need(++nodes <= 200000 && depth <= 32, 'DOWNLOAD_PROOF_LIMIT');
    if (v === null || v === undefined || typeof v === 'boolean') return v;
    if (typeof v === 'string') { need(v.length <= 4 * 1024 * 1024, 'DOWNLOAD_PROOF_LIMIT'); return v; }
    if (typeof v === 'number') { need(Number.isFinite(v), 'DOWNLOAD_PROOF_VALUE'); return v; }
    need(typeof v === 'object' && !isProxy(v) && !ancestors.has(v), 'DOWNLOAD_PROOF_VALUE');
    const array = Array.isArray(v), proto = Object.getPrototypeOf(v);
    need(array ? proto === Array.prototype : proto === null || proto === Object.prototype, 'DOWNLOAD_PROOF_PROTOTYPE');
    const keys = Reflect.ownKeys(v); need(keys.length <= 20001 && keys.every(k => typeof k === 'string'), 'DOWNLOAD_PROOF_KEYS');
    if (array) need(v.length <= 20000 && keys.every(k => k === 'length' || /^(0|[1-9][0-9]*)$/.test(k) && Number(k) < v.length), 'DOWNLOAD_PROOF_ARRAY');
    ancestors.add(v); const out = array ? new Array(v.length) : Object.create(null);
    for (const k of keys) {
      if (array && k === 'length') continue;
      const d = Object.getOwnPropertyDescriptor(v, k);
      need(d?.enumerable && Object.hasOwn(d, 'value'), 'DOWNLOAD_PROOF_ACCESSOR');
      Object.defineProperty(out, k, { value: copy(d.value, depth + 1), enumerable: true, writable: true, configurable: true });
    }
    ancestors.delete(v); return out;
  }
  return copy(input, 0);
}
function proofDigest(input) {
  function encode(v) {
    if (v === null) return ['null']; if (v === undefined) return ['undefined'];
    if (typeof v === 'object') return [Array.isArray(v) ? 'array' : 'object',
      ...(Array.isArray(v) ? [v.length] : []), Object.keys(v).sort().map(k => [k, encode(v[k])])];
    return [typeof v, Object.is(v, -0) ? '-0' : v];
  }
  return crypto.createHash('sha256').update(JSON.stringify(encode(snapshot(input)))).digest('hex');
}
const sameProof = (a, b) => proofDigest(a) === proofDigest(b);
const ownShape = (v, k) => Object.hasOwn(v, k) ? { present: true, value: v[k] } : { present: false };

function nativeInstallContract(info, pkg, { gameId, profileId, mode = 'direct', nativeIdentity } = {}) {
  info = snapshot(info); pkg = snapshot(pkg); nativeIdentity = snapshot(nativeIdentity);
  need(['direct', 'collection'].includes(mode) && text(gameId) && text(profileId), 'NATIVE_CONTRACT_CONTEXT');
  const keys = mode === 'direct' ? ['choices', 'download', 'modReference', 'profileId'] : ['choices', 'download', 'modReference', 'patches'];
  need(sameProof(Object.keys(info).sort(), keys.sort()), 'NATIVE_CONTRACT_INFO_SHAPE');
  const d = info.download;
  need(d?.state === 'finished' && d.fileMD5 === pkg.md5 && d.size === pkg.bytes && typeof d.localPath === 'string'
    && isDownloadId(pkg.requiredDownloadId) && isNativeModId(pkg.expectedModId) && sha(pkg.sha256), 'NATIVE_CONTRACT_ARCHIVE');
  need([].concat(d.game ?? []).length === 1 && [].concat(d.game)[0] === gameId, 'NATIVE_CONTRACT_GAME');
  need(String(nativeIdentity?.modId) === String(pkg.nexusModId) && String(nativeIdentity?.fileId) === String(pkg.nexusFileId), 'NATIVE_CONTRACT_NEXUS');
  if (mode === 'direct') need(info.profileId === profileId, 'NATIVE_CONTRACT_PROFILE');
  return { schema: 'tracked-native-install-contract/1', sourceDownloadId: pkg.requiredDownloadId,
    archiveSHA256: pkg.sha256, md5: d.fileMD5, bytes: d.size, localPath: d.localPath, game: ownShape(d, 'game'),
    nativeIdentity, expectedModId: pkg.expectedModId, choices: ownShape(info, 'choices'), patches: ownShape(info, 'patches'),
    modReference: ownShape(info, 'modReference'), profileId: ownShape(info, 'profileId') };
}

function createDownloadLifecycle({ beforeDownloads, packages, gameId, profileId, mode = 'direct' }) {
  beforeDownloads = snapshot(beforeDownloads); packages = snapshot(packages);
  need(beforeDownloads && typeof beforeDownloads === 'object' && !Array.isArray(beforeDownloads)
    && text(gameId) && text(profileId) && ['direct', 'collection'].includes(mode)
    && Array.isArray(packages) && packages.length > 0 && packages.length <= 4, 'DOWNLOAD_LIFECYCLE_SCOPE');
  const keys = Object.keys(beforeDownloads).sort(), models = new Map(), seen = new Set(), nativeIds = new Set();
  for (const p of packages) {
    need(isDownloadId(p.requiredDownloadId) && isNativeModId(p.expectedModId) && !models.has(p.requiredDownloadId) && !nativeIds.has(p.expectedModId), 'DOWNLOAD_LIFECYCLE_IDENTITY');
    nativeIds.add(p.expectedModId);
    const before = beforeDownloads[p.requiredDownloadId];
    need(before?.state === 'finished' && before.fileMD5 === p.md5 && before.size === p.bytes && sha(p.sha256), 'DOWNLOAD_LIFECYCLE_ARCHIVE');
    const queued = snapshot(before), tag = p.sourceTag;
    if (mode === 'collection') {
      need(text(tag), 'DOWNLOAD_LIFECYCLE_TAG');
      const mi = queued.modInfo ?? {}, tags = new Set(Array.isArray(mi.referenceTags) ? mi.referenceTags : []);
      if (typeof mi.referenceTag === 'string') tags.add(mi.referenceTag);
      if (!tags.has(tag)) { queued.modInfo = { ...mi, referenceTags: [...tags, tag] }; if (mi.referenceTag === undefined) queued.modInfo.referenceTag = tag; }
    }
    const installed = snapshot(queued); installed.installed = { gameId, modId: p.expectedModId };
    const expectedInfo = mode === 'direct'
      ? { download: queued, choices: p.choices, profileId, modReference: undefined }
      : { download: queued, choices: p.choices, patches: p.patches, modReference: p.modReference };
    const contract = nativeInstallContract(expectedInfo, p, { gameId, profileId, mode, nativeIdentity: p.nativeSelectorInputs });
    models.set(p.requiredDownloadId, { p, before: proofDigest(before), queued: proofDigest(queued), installed: proofDigest(installed), contract: proofDigest(contract) });
  }
  function will(downloadId, info, nativeIdentity) {
    const m = models.get(downloadId); need(m && !seen.has(downloadId), 'DOWNLOAD_LIFECYCLE_WILL_IDENTITY');
    info = snapshot(info); need(proofDigest(info.download) === m.queued, 'DOWNLOAD_LIFECYCLE_WILL_NOT_QUEUED');
    need(proofDigest(nativeInstallContract(info, m.p, { gameId, profileId, mode, nativeIdentity })) === m.contract, 'NATIVE_INSTALL_CONTRACT_CHANGED');
    seen.add(downloadId); return true;
  }
  function check(actual, { ownResumeObserved = false, sessionBound = false, final = false } = {}) {
    actual = snapshot(actual); need(sameProof(Object.keys(actual).sort(), keys), 'DOWNLOAD_LIFECYCLE_RECORD_SET');
    const states = [];
    for (const id of keys) {
      const h = proofDigest(actual[id]), m = models.get(id);
      if (!m) { need(h === proofDigest(beforeDownloads[id]), 'UNRELATED_DOWNLOAD_CHANGED'); continue; }
      let state;
      if (final) { need(seen.has(id) && h === m.installed, 'FINAL_NATIVE_DOWNLOAD_CHANGED'); state = 'installed'; }
      else if (h === m.before && (!seen.has(id) || m.before === m.queued)) state = 'before';
      else if (seen.has(id) && h === m.installed) state = 'installed';
      else { need(mode === 'collection' && ownResumeObserved && sessionBound && h === m.queued, 'UNREVIEWED_NATIVE_DOWNLOAD_CHANGED'); state = 'queued'; }
      states.push({ downloadId: id, modId: m.p.expectedModId, state });
    }
    return { schema: 'tracked-download-lifecycle/1', states, unrelatedRecordsExact: true, noWriteback: true,
      beforeDigest: proofDigest(beforeDownloads), afterDigest: proofDigest(actual), normalizedAfterDigest: proofDigest(beforeDownloads),
      beforeRecordDigests: Object.fromEntries(keys.map(id => [id, proofDigest(beforeDownloads[id])])),
      afterRecordDigests: Object.fromEntries(keys.map(id => [id, proofDigest(actual[id])])),
      installedMarkersAdded: states.filter(r => r.state === 'installed').map(r => ({ downloadId: r.downloadId, modId: r.modId, gameId })) };
  }
  return Object.freeze({ will, check });
}
module.exports = { createScopePolicy, createDownloadLifecycle, nativeInstallContract };
