'use strict';
const path = require('node:path');
const { PHASES, STATES, REASONS, WAITS } = require('./install-diagnostics.cjs');
const { SCHEMA: ASSESSMENT_SCHEMA, STATUSES: ASSESSMENT_STATUSES, REASONS: ASSESSMENT_REASONS } = require('./installed-candidate-assessment.cjs');
const OPERATIONS = new Set(['install_download', 'install_local_archive', 'set_mods_enabled', 'deploy_mods', 'download_nexus', 'advance_collection_wizard']);
const URI = /\b(?:[a-z][a-z0-9+.-]*:\/\/|[a-z][a-z0-9+.-]+:|[a-z]:(?![\\/]))[^\s"'<>]+/gi;
const PATH_FIELD = /^(?:game|staging|download)Path$/;
function insist(ok, code) { if (!ok) throw new Error(code); }

// Policies apply to exact positions in outputs of named curated producers. They
// are NOT a global exemption for arbitrary objects having a key named gameId/id.
function operational(kind, trail) {
  if (kind === 'read_collection_wizard' && trail.length === 1) {
    const key = trail[0];
    if (['protocol', 'gameId', 'profileId', 'modId'].includes(key)) return key;
    if (key === 'archiveId') return 'downloadId';
    if (key === 'schema') return 'wizardReadSchema';
    if (key === 'status') return 'wizardReadStatus';
    if (key === 'observedAtUTC') return 'at';
    if (['collectionId', 'revisionId', 'revisionNumber'].includes(key)) return 'wizardOptionalPositive';
    if (key === 'action') return 'wizardOptionalAction';
    if (key === 'phase') return 'wizardPhase';
    if (key === 'reason') return 'wizardReason';
    if (['sourceAdmitted', 'bindingReady', 'writesAvailable'].includes(key)) return 'wizardBoolean';
    if (key === 'nativeTransitionVerified') return 'wizardFalse';
  }
  if (kind === 'assess_installed_candidates') {
    if (trail.length === 1 && ['protocol','gameId','profileId'].includes(trail[0])) return trail[0];
    if (trail.length === 1 && trail[0] === 'schema') return 'assessmentSchema';
    if (trail.length === 1 && trail[0] === 'status') return 'assessmentReadStatus';
    if (trail.length === 2 && trail[0] === 'collection' && trail[1] === 'modId') return 'modId';
    if (trail[0] === 'comparisons' && /^\d+$/.test(trail[1])) {
      const part = trail.slice(2);
      if (part.length === 1 && ['oldModId','candidateModId'].includes(part[0])) return 'modId';
      if (part.length === 1 && part[0] === 'status') return 'assessmentStatus';
      if (part.length === 1 && part[0] === 'fingerprint') return 'sha256';
      if (part.length === 2 && part[0] === 'reasons' && /^\d+$/.test(part[1])) return 'assessmentReason';
      if (part.length === 2 && part[0] === 'selectedRule' && ['ruleIdHash','fingerprint'].includes(part[1])) return 'sha256';
      if (part.length === 3 && part[0] === 'incomingRequires' && /^\d+$/.test(part[1])) {
        if (part[2] === 'ownerId') return 'modId';
        if (['ruleIdHash','fingerprint'].includes(part[2])) return 'sha256';
      }
      if (part.length === 4 && part[0] === 'profiles' && ['old','candidate'].includes(part[1])
        && /^\d+$/.test(part[2]) && part[3] === 'id') return 'profileId';
      if (part.length === 4 && part[0] === 'archiveReferences' && ['old','candidate'].includes(part[1]) && /^\d+$/.test(part[2])) {
        if (part[3] === 'modId') return 'modId';
        if (part[3] === 'gameId') return 'gameId';
      }
    }
  }
  if (kind === 'install_diagnostics') {
    if (trail[0] === 'diagnostics') return operational('install_diagnostics', trail.slice(1));
    if (trail.length === 1 && trail[0] === 'schema') return 'installDiagnosticSchema';
    if (trail.length === 1 && ['operation', 'requestId'].includes(trail[0])) return trail[0];
    if (trail.length === 1 && trail[0] === 'attemptAt') return 'at';
    if (trail.length === 1 && ['phase', 'state', 'reason', 'waitReason'].includes(trail[0]))
      return 'installDiagnostic_' + trail[0];
  }
  if (['operation_status', 'reconcile_operation', 'install_local_archive'].includes(kind) && trail[0] === 'installDiagnostics')
    return operational('install_diagnostics', trail.slice(1));
  if (kind === 'read_native_preflight') {
    if (trail.length === 1 && trail[0] === 'protocol') return 'protocol';
    if (trail.length === 1 && trail[0] === 'schema') return 'nativePreflightSchema';
    if (trail.length === 1 && trail[0] === 'status') return 'nativePreflightStatus';
    if (trail.length === 1 && trail[0] === 'observedAtUTC') return 'at';
    if (trail[0] === 'context') {
      if (trail.length === 2 && ['gameId', 'profileId'].includes(trail[1])) return trail[1];
      if (trail.length === 2 && PATH_FIELD.test(trail[1])) return 'absolutePath';
      if (trail.length === 3 && trail[1] === 'filesystemIds' && PATH_FIELD.test(trail[2])) return 'filesystemId';
    }
    if (trail.length === 2 && trail[0] === 'appVersion' && trail[1] === 'value') return 'nativeAppVersion';
    if (trail.length === 2 && ['appVersion', 'updater'].includes(trail[0]) && trail[1] === 'code') return 'nativePreflightCode';
    if (trail.length === 2 && trail[0] === 'staging' && trail[1] === 'code') return 'nativeStagingCode';
    if (trail.length === 2 && trail[0] === 'staging' && trail[1] === 'tagStatus') return 'nativeStagingStatus';
    if (trail.length === 2 && trail[0] === 'updater' && trail[1] === 'state') return 'nativeUpdaterState';
    if (trail.length === 3 && trail[0] === 'deploymentTargets' && /^\d+$/.test(trail[1])) {
      if (trail[2] === 'typeId') return 'nativeTypeId';
      if (trail[2] === 'path') return 'absolutePath';
    }
  }
  if (kind === 'read_mod_lifecycle') {
    if (trail.length === 1 && ['protocol', 'gameId', 'profileId'].includes(trail[0])) return trail[0];
    if (trail[0] === 'mods' && /^\d+$/.test(trail[1])) {
      if (trail.length === 3 && trail[2] === 'id') return 'modId';
      if (trail.length === 3 && trail[2] === 'archiveId') return 'downloadId';
      if (trail.length === 5 && /^\d+$/.test(trail[3])) {
        if (trail[2] === 'profiles' && trail[4] === 'id') return 'profileId';
        if (['profiles', 'archiveReferences'].includes(trail[2]) && trail[4] === 'gameId') return 'gameId';
        if (trail[2] === 'incomingRequires' && trail[4] === 'ownerId') return 'modId';
        if (trail[2] === 'archiveReferences' && trail[4] === 'modId') return 'modId';
      }
    }
  }
  if (kind === 'health') {
    if (trail.length === 1 && ['protocol', 'extensionVersion', 'targetVortexVersion', 'gameId', 'profileId', 'security'].includes(trail[0])) return trail[0];
    if (trail.length === 1 && PATH_FIELD.test(trail[0])) return 'absolutePath';
    if (trail.length === 2 && trail[0] === 'filesystemIds' && PATH_FIELD.test(trail[1])) return 'filesystemId';
  }
  if (kind === 'parameters') {
    if (trail.length === 1 && trail[0] === 'archivePath') return 'absolutePath';
    if (trail.length === 1 && ['gameId', 'profileId', 'requestId', 'downloadId', 'sha256'].includes(trail[0])) return trail[0];
    if (trail.length === 1 && trail[0] === 'modId') return 'modId';
    if (trail.length === 1 && trail[0] === 'archiveId') return 'downloadId';
    if (trail.length === 1 && ['collectionId', 'revisionId', 'revisionNumber'].includes(trail[0])) return 'wizardPositive';
    if (trail.length === 1 && trail[0] === 'action') return 'wizardAction';
    if (trail.length === 1 && PATH_FIELD.test(trail[0])) return 'absolutePath';
    if (trail.length === 2 && trail[0] === 'modIds' && /^\d+$/.test(trail[1])) return 'modId';
    if (trail.length === 2 && trail[0] === 'filesystemIds' && PATH_FIELD.test(trail[1])) return 'filesystemId';
  }
  if (kind === 'receipt' || kind === 'operation_status' || OPERATIONS.has(kind)) {
    if (trail[0] === 'parameters') return operational('parameters', trail.slice(1));
    if (trail.length === 1 && ['protocol', 'operation', 'requestId', 'gameId', 'profileId', 'modId', 'downloadId', 'at'].includes(trail[0])) return trail[0];
    if (trail.length === 1 && trail[0] === 'archiveId') return 'downloadId';
    if (trail.length === 1 && ['collectionId', 'revisionId', 'revisionNumber'].includes(trail[0])) return 'wizardPositive';
    if (trail.length === 1 && trail[0] === 'action') return 'wizardAction';
    if (trail.length === 1 && trail[0] === 'transition') return 'wizardTransition';
    if (trail.length === 1 && trail[0] === 'nativeTransitionVerified') return 'wizardTrue';
    if (trail.length === 2 && trail[0] === 'modIds' && /^\d+$/.test(trail[1])) return 'modId';
  }
  if (kind === 'reconcile_operation') {
    if (trail.length === 2 && trail[0] === 'localInstall' && ['modId', 'downloadId'].includes(trail[1])) return trail[1];
    if (trail.length === 1 && trail[0] === 'protocol') return 'protocol';
    if (['attempt', 'completion', 'failure', 'interlock'].includes(trail[0])) return operational('receipt', trail.slice(1));
    if (trail.length === 3 && /^\d+$/.test(trail[1])) {
      if (trail[0] === 'enabledFlags' && trail[2] === 'modId') return 'modId';
      if (trail[0] === 'download' && trail[2] === 'id') return 'downloadId';
    }
  }
  if (['list_profiles', 'list_mods', 'list_downloads'].includes(kind) && trail.length === 2 && /^\d+$/.test(trail[0])) {
    if (trail[1] === 'id') return kind === 'list_profiles' ? 'profileId' : kind === 'list_mods' ? 'modId' : 'downloadId';
    if (['gameId', 'nexusDomain'].includes(trail[1])) return 'gameId';
    if (trail[1] === 'installedModId') return 'modId';
    if (trail[1] === 'version') return 'version';
  }
  if (['list_mod_rules', 'find_mod_dependents', 'list_known_mod_conflicts', 'list_unsolved_conflicts'].includes(kind)
      && trail.length === 2 && /^\d+$/.test(trail[0]) && ['id', 'modId', 'targetId', 'otherModId'].includes(trail[1])) return 'modId';
  if (kind === 'list_file_conflicts') {
    if (trail.length === 3 && trail[0] === 'conflicts' && /^\d+$/.test(trail[1]) && trail[2] === 'path') return 'relativePath';
    if (trail.length === 4 && trail[0] === 'conflicts' && /^\d+$/.test(trail[1]) && trail[2] === 'modIds' && /^\d+$/.test(trail[3])) return 'modId';
  }
  if (kind === 'list_external_changes' && trail.length === 2 && /^\d+$/.test(trail[0]) && trail[1] === 'filePath') return 'absolutePath';
  return null;
}
function validOperational(type, value) {
  if (type === 'wizardPositive') return Number.isSafeInteger(value) && value > 0;
  if (type === 'wizardOptionalPositive') return value === null || (Number.isSafeInteger(value) && value > 0);
  if (type === 'wizardBoolean') return typeof value === 'boolean';
  if (type === 'wizardTrue') return value === true;
  if (type === 'wizardFalse') return value === false;
  if (type === 'wizardReadSchema') return value === 'collection-wizard-readiness/1';
  if (type === 'wizardReadStatus') return ['ready', 'held', 'idle', 'ambiguous'].includes(value);
  if (type === 'wizardAction') return ['install_now', 'done'].includes(value);
  if (type === 'wizardOptionalAction') return value === null || ['install_now', 'done'].includes(value);
  if (type === 'wizardTransition') return ['started', 'finished'].includes(value);
  if (type === 'wizardPhase') return value === null || ['start', 'finish'].includes(value);
  if (type === 'wizardReason') return value === null || (typeof value === 'string' && /^COLLECTION_WIZARD_[A-Z0-9_]{1,100}$/.test(value));
  if (type === 'assessmentSchema') return value === ASSESSMENT_SCHEMA;
  if (type === 'assessmentReadStatus') return ['ok','partial'].includes(value);
  if (type === 'assessmentStatus') return ASSESSMENT_STATUSES.includes(value);
  if (type === 'assessmentReason') return ASSESSMENT_REASONS.includes(value);
  if (type === 'installDiagnosticSchema') return ['install-diagnostics/1','install-diagnostic-record/1'].includes(value);
  if (type === 'installDiagnostic_phase') return PHASES.includes(value);
  if (type === 'installDiagnostic_state') return STATES.includes(value);
  if (type === 'installDiagnostic_reason') return REASONS.includes(value);
  if (type === 'installDiagnostic_waitReason') return WAITS.includes(value);
  if (type === 'nativePreflightSchema') return value === 'native-preflight/1';
  if (type === 'nativePreflightStatus') return ['ok', 'partial'].includes(value);
  if (type === 'nativeAppVersion') return value.length <= 128 && /^\d{1,4}(?:\.\d{1,6}){2,3}(?:-[0-9A-Za-z][0-9A-Za-z.-]{0,63})?(?:\+[0-9A-Za-z][0-9A-Za-z.-]{0,31})?$/.test(value);
  if (type === 'nativeTypeId') return /^[A-Za-z0-9_-]{0,128}$/.test(value) && !['__proto__', 'constructor', 'prototype'].includes(value);
  if (type === 'nativePreflightCode') return /^NATIVE_PREFLIGHT_(?:APP_VERSION|UPDATER)_(?:TIMEOUT|INVALID|UNAVAILABLE)$/.test(value);
  if (type === 'nativeStagingCode') return /^NATIVE_PREFLIGHT_STAGING_TAG_(?:MISSING|UNAVAILABLE|UNSAFE|CHANGED)$/.test(value);
  if (type === 'nativeStagingStatus') return ['missing','present','unknown'].includes(value);
  if (type === 'nativeUpdaterState') return ['disabled', 'idle', 'checking', 'available', 'downgrade-offered', 'downloading', 'staged', 'error'].includes(value);
  if (type === 'protocol') return value === 'vortex-agent/1';
  if (type === 'operation') return OPERATIONS.has(value);
  if (type === 'extensionVersion') return value === '1.1.0';
  if (type === 'targetVortexVersion') return value === '2.7.2.0';
  // Vortex preserves an empty version when native metadata is unknown. Do not
  // fail an entire inventory or invent a version for that legitimate record.
  if (type === 'version') return value.length <= 200 && !/[\r\n\0]/.test(value);
  if (type === 'security') return value === 'per-user-DPAPI-bearer';
  if (type === 'requestId') return /^[a-zA-Z0-9_-]{8,80}$/.test(value);
  if (type === 'filesystemId') return /^\d+:\d+$/.test(value);
  if (type === 'sha256') return /^[a-f0-9]{64}$/.test(value);
  if (type === 'at') return /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value);
  if (type === 'absolutePath') return path.isAbsolute(value);
  if (type === 'relativePath') return value.length > 0 && !path.isAbsolute(value) && !value.split(/[\\/]/).includes('..');
  return value.length > 0 && value.length <= 200 && !/[\r\n\0]/.test(value);
}
function safe(value, api, kind = 'display', additionalCredentials = []) {
  const credentials = new Set(), accountStrings = new Set(), privateNodes = new WeakSet();
  for (const value of additionalCredentials) if (typeof value === 'string' && value.length) credentials.add(value);
  const collect = (item, strings, credentialsOnly = false) => {
    if (typeof item === 'string' && item.length) strings.add(item);
    else if (item && typeof item === 'object') {
      privateNodes.add(item);
      for (const [key, child] of Object.entries(item)) {
        if (!credentialsOnly || /token|credential|cookie|(?:api)?key|password|authorization/i.test(key)) collect(child, strings);
        else if (child && typeof child === 'object') collect(child, strings, true);
      }
    }
  };
  if (api) {
    const state = api.getState();
    collect(state.confidential, credentials);
    collect(state.persistent?.nexus?.userInfo, accountStrings);
    collect(state.persistent?.nexus?.userInfo, credentials, true);
  }
  const active = new WeakSet();
  const walk = (item, trail = []) => {
    if (item && typeof item === 'object') insist(!privateNodes.has(item), 'ACCOUNT_DATA_NOT_CURATED');
    const key = trail.at(-1) || '';
    if (/token|credential|cookie|apikey|password|authorization|url|^(?:userInfo|account|username|email|userId)$/i.test(key)) return '[redacted]';
    const type = operational(kind, trail);
    if (type && type.startsWith('wizard')) {
      insist(validOperational(type, item), 'OPERATIONAL_VALUE_NOT_CURATED');
      insist(![...credentials].some(secret => String(item).includes(secret)), 'OPERATIONAL_SECRET_OVERLAP');
      return item;
    }
    if (item && typeof item === 'object') {
      insist(!active.has(item), 'SERIALIZATION_CYCLE_NOT_CURATED');
      active.add(item);
      const out = Array.isArray(item) ? item.map((child, index) => walk(child, [...trail, String(index)]))
        : Object.fromEntries(Object.entries(item).map(([key, child]) => {
          insist(![...credentials].some(secret => key.includes(secret)) && !new RegExp(URI.source, 'i').test(key), 'PROPERTY_KEY_NOT_CURATED');
          return [key, walk(child, [...trail, key])];
        }));
      active.delete(item); return out;
    }
    if (typeof item !== 'string') return item;
    if (type) {
      // Credential overlap is NOT account-name overlap: do not return or persist
      // a broken identifier, and do not exempt even a one-character real secret.
      insist(![...credentials].some(secret => item.includes(secret)), 'OPERATIONAL_SECRET_OVERLAP');
      insist(validOperational(type, item) && !new RegExp(URI.source, 'i').test(item), 'OPERATIONAL_VALUE_NOT_CURATED');
      return item;
    }
    let text = item;
    for (const secret of [...credentials, ...accountStrings]) text = text.split(secret).join('[redacted]');
    return text.replace(URI, '[redacted-uri]');
  };
  return JSON.parse(JSON.stringify(walk(value ?? null)));
}
function publicErrorCode(error, api, credentials = []) {
  const code = /^[A-Z][A-Z0-9_]+$/.test(error?.message || '') ? error.message : 'VORTEX_OPERATION_FAILED';
  if (['OPERATIONAL_SECRET_OVERLAP', 'OPERATIONAL_VALUE_NOT_CURATED', 'ACCOUNT_DATA_NOT_CURATED', 'PROPERTY_KEY_NOT_CURATED'].includes(code)) return code;
  try { return safe({ message: code }, api, 'display', credentials).message === code ? code : 'VORTEX_OPERATION_FAILED'; }
  catch { return 'VORTEX_OPERATION_FAILED'; }
}
module.exports = { safe, publicErrorCode };
