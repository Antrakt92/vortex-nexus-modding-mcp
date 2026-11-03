'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { inspectOwnZip, LIMITS } = require('./own-zip.cjs');
const { validateLocalArchiveName, assertLocalArchiveAdmission } = require('./local-archive-policy.cjs');
const need = (ok, code) => { if (!ok) throw Error(code); };
const sha = data => crypto.createHash('sha256').update(data).digest('hex');
const stamp = s => [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].join(':');
const hooks = new WeakMap();
function ordinary(file) {
  need(path.isAbsolute(file), 'LOCAL_ARCHIVE_ABSOLUTE_PATH_REQUIRED');
  for (let p = file; ; p = path.dirname(p)) {
    need(!fs.lstatSync(p).isSymbolicLink(), 'LOCAL_ARCHIVE_REPARSE_PATH');
    if (p === path.dirname(p)) break;
  }
}
function packageProof(args) {
  ordinary(args.archivePath);
  const fd = fs.openSync(args.archivePath, 'r');
  try {
    const before = fs.fstatSync(fd, { bigint: true });
    need(before.isFile() && before.size > 0n && before.size <= BigInt(LIMITS.archiveBytes)
      && before.size === BigInt(args.size), 'LOCAL_ARCHIVE_SIZE_MISMATCH');
    const bytes = fs.readFileSync(fd), proof = inspectOwnZip(bytes);
    need(proof.sha256 === args.sha256, 'LOCAL_ARCHIVE_HASH_MISMATCH');
    // This first installer handles ordinary own Cyberpunk files, never installer code.
    need(Object.keys(proof.payload).every(p => /^(?:archive\/pc\/mod\/|r6\/scripts\/|r6\/tweaks\/|red4ext\/plugins\/|bin\/x64\/plugins\/cyber_engine_tweaks\/mods\/)/.test(p)),
      'LOCAL_ARCHIVE_PAYLOAD_SCOPE_UNSUPPORTED');
    const generation = stamp(before);
    const verify = () => {
      ordinary(args.archivePath);
      need(stamp(fs.lstatSync(args.archivePath, { bigint: true })) === generation
        && stamp(fs.fstatSync(fd, { bigint: true })) === generation, 'LOCAL_ARCHIVE_CHANGED');
    };
    verify(); return { ...proof, verify, close: () => fs.closeSync(fd) };
  } catch (error) { fs.closeSync(fd); throw error; }
}
function noNexus(value, depth = 0) {
  need(depth <= 12, 'LOCAL_ARCHIVE_METADATA_UNSAFE');
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (/^(?:modId|fileId|revisionId|collectionId|nexusModId|nexusFileId)$/i.test(key))
      need(child === undefined || child === null, 'LOCAL_ARCHIVE_METADATA_UNSAFE');
    if (/^(?:source|repository)$/i.test(key)) need(!/^nexus(?:mods)?$/i.test(String(child)), 'LOCAL_ARCHIVE_METADATA_UNSAFE');
    if (child && typeof child === 'object') noNexus(child, depth + 1);
  }
}
function boundaryHooks(api) {
  if (hooks.has(api)) return hooks.get(api);
  need(typeof api.onAsync === 'function', 'LOCAL_ARCHIVE_NATIVE_HOOK_UNAVAILABLE');
  const state = { active: null };
  api.onAsync('will-install-mod', async (game, downloadId, modId, info) => {
    const active = state.active;
    if (!active) return;
    try {
    need(!active.uncertain && game === active.gameId && downloadId === active.downloadId
      && modId === active.modId && !active.hookSeen, 'LOCAL_ARCHIVE_UNOWNED_INSTALL');
    active.hookSeen = true;
    noNexus(info);
    await active.check();
    // The stock manager assigns a later lookup match to this hook payload before
    // previous-version detection. A newly appearing match must fail, not replace.
    need(info && info.meta === undefined, 'LOCAL_ARCHIVE_METADATA_UNSAFE');
    Object.defineProperty(info, 'meta', { enumerable: true, configurable: false,
      get: () => undefined, set: () => { throw Error('LOCAL_ARCHIVE_METADATA_CHANGED'); } });
    } catch (error) { active.violation = true; throw error; }
  });
  api.onAsync('will-remove-mods', async () => {
    if (state.active) state.active.violation = true;
    need(!state.active, 'LOCAL_ARCHIVE_REPLACEMENT_REFUSED');
  });
  hooks.set(api, state); return state;
}
function native(api, event, args, timeoutMs, active, extract = value => value) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { active.uncertain = true; reject(Error('LOCAL_ARCHIVE_NATIVE_TIMEOUT_RECONCILE')); }, timeoutMs);
    const callback = (error, result) => {
      clearTimeout(timer);
      if (error) { active.uncertain = true; reject(Error('LOCAL_ARCHIVE_NATIVE_FAILED_RECONCILE')); }
      else { try { resolve(extract(result)); } catch (err) { reject(err); } }
    };
    try { need(api.events.emit(event, ...args(callback)), 'LOCAL_ARCHIVE_NATIVE_LISTENER_MISSING'); }
    catch (error) { clearTimeout(timer); reject(error); }
  });
}
async function installLocalArchive(api, args, { check, effect, admitHost, timeoutMs = 120000 }) {
  need(args.gameId === 'cyberpunk2077', 'LOCAL_ARCHIVE_GAME_UNSUPPORTED');
  need(typeof admitHost === 'function', 'LOCAL_ARCHIVE_SOURCE_ADMISSION_REQUIRED');
  const name = path.basename(args.archivePath), modId = validateLocalArchiveName(name);
  const holder = boundaryHooks(api);
  need(!holder.active, 'LOCAL_ARCHIVE_NATIVE_OPERATION_HELD');
  const baseline = structuredClone(api.getState().persistent.mods || {});
  baseline[args.gameId] ||= {};
  const profiles = structuredClone(api.getState().persistent.profiles || {});
  const baselineDownloadIds = new Set(Object.keys(api.getState().persistent.downloads?.files || {}));
  const pkg = packageProof(args);
  const active = { gameId: args.gameId, modId, downloadId: null, hookSeen: false, uncertain: false };
  let completed = false, nativeStarted = false, importedProof;
  const verifyArchives = () => { pkg.verify(); importedProof?.verify(); };
  const listeners = [];
  function arm(event, fn) {
    need(typeof api.events.prependListener === 'function' && typeof api.events.removeListener === 'function', 'LOCAL_ARCHIVE_NATIVE_GUARD_UNAVAILABLE');
    api.events.prependListener(event, fn); listeners.push([event, fn]);
  }
  async function admission() {
    need(!active.uncertain && !active.violation, 'LOCAL_ARCHIVE_NATIVE_OPERATION_HELD');
    check(); verifyArchives(); await admitHost(); check(); verifyArchives();
    const metadata = await api.lookupModMeta({ fileMD5: pkg.md5, fileSize: pkg.bytes, gameId: args.gameId });
    check(); verifyArchives();
    assertLocalArchiveAdmission({ archiveName: name, mods: api.getState().persistent.mods?.[args.gameId] || {},
      existingDirectories: fs.readdirSync(args.stagingPath), metadata, autoEnable: false, autoDeploy: false });
    need(!active.uncertain && !active.violation, 'LOCAL_ARCHIVE_NATIVE_OPERATION_HELD');
  }
  active.check = admission;
  holder.active = active;
  try {
    await admission();
    // Do not import another copy of an archive Vortex already owns.
    need(!Object.values(api.getState().persistent.downloads?.files || {}).some(d =>
      typeof d.localPath === 'string' && path.basename(d.localPath).toLowerCase() === name.toLowerCase()), 'LOCAL_ARCHIVE_ALREADY_TRACKED');
    arm('start-install', () => { active.violation = true; throw Error('LOCAL_ARCHIVE_UNOWNED_INSTALL'); });
    arm('start-install-download', (id, options) => {
      if (!(active.dispatching && id === active.downloadId && options?.allowAutoEnable === false
        && options?.profileId === args.profileId)) { active.violation = true; throw Error('LOCAL_ARCHIVE_UNOWNED_INSTALL'); }
      active.dispatching = false;
    });
    for (const event of ['remove-mod', 'remove-mods']) arm(event, () => { active.violation = true; throw Error('LOCAL_ARCHIVE_REPLACEMENT_REFUSED'); });
    const ids = await effect(() => {
      nativeStarted = true;
      return native(api, 'import-downloads', cb => [[args.archivePath], values => cb(null, values), true], timeoutMs, active);
    }, verifyArchives);
    need(Array.isArray(ids) && ids.length === 1 && typeof ids[0] === 'string' && ids[0], 'LOCAL_ARCHIVE_IMPORT_RESULT_INVALID');
    active.downloadId = ids[0];
    const until = Date.now() + timeoutMs;
    while (api.getState().persistent.downloads?.files?.[active.downloadId]?.state !== 'finished') {
      need(Date.now() < until, 'LOCAL_ARCHIVE_IMPORT_PENDING_RECONCILE');
      check(); await new Promise(resolve => setTimeout(resolve, 100));
    }
    const record = api.getState().persistent.downloads.files[active.downloadId];
    noNexus(record);
    need(!baselineDownloadIds.has(active.downloadId) && Array.isArray(record.game) && record.game.length === 1
      && record.game[0] === args.gameId && record.localPath === name, 'LOCAL_ARCHIVE_IMPORTED_IDENTITY_MISMATCH');
    const imported = path.join(args.downloadPath, record.localPath);
    importedProof = packageProof({ ...args, archivePath: imported });
    await admission();
    const installed = await effect(() => {
      active.dispatching = true;
      return native(api, 'start-install-download', cb => [active.downloadId,
        { allowAutoEnable: false, profileId: args.profileId }, cb], timeoutMs, active);
    }, verifyArchives);
    check(); verifyArchives(); need(!active.violation && !active.uncertain, 'LOCAL_ARCHIVE_NATIVE_OPERATION_HELD');
    need(installed === modId && active.hookSeen, 'LOCAL_ARCHIVE_INSTALLED_IDENTITY_MISMATCH');
    const state = api.getState(), mod = state.persistent.mods?.[args.gameId]?.[modId];
    need(mod?.state === 'installed' && mod.installationPath === modId && mod.archiveId === active.downloadId
      && state.persistent.profiles[args.profileId].modState?.[modId]?.enabled !== true, 'LOCAL_ARCHIVE_INSTALLED_RECORD_UNVERIFIED');
    for (const [relative, digest] of Object.entries(pkg.payload)) {
      const staged = path.join(args.stagingPath, modId, relative);
      ordinary(staged); need(sha(fs.readFileSync(staged)) === digest, 'LOCAL_ARCHIVE_STAGED_BYTES_UNVERIFIED');
    }
    const afterMods = structuredClone(state.persistent.mods || {}); delete afterMods[args.gameId][modId];
    const afterProfiles = structuredClone(state.persistent.profiles || {});
    for (const profile of Object.values(afterProfiles)) {
      if (profile.modState?.[modId]) {
        need(profile.id === args.profileId && profile.modState[modId].enabled !== true, 'LOCAL_ARCHIVE_OTHER_PROFILE_CHANGED');
        delete profile.modState[modId];
      }
    }
    need(JSON.stringify(afterMods) === JSON.stringify(baseline)
      && JSON.stringify(afterProfiles) === JSON.stringify(profiles), 'LOCAL_ARCHIVE_EXISTING_STATE_CHANGED');
    completed = true;
    return { modId, downloadId: active.downloadId, installedRecordVerified: true, enabled: false,
      archiveSha256Verified: true, payloadFilesVerified: pkg.payloadFiles };
  } finally {
    pkg.close();
    importedProof?.close();
    // A failed/unknown native operation stays guarded until explicit reconciliation/restart.
    if (completed || !nativeStarted) {
      for (const [event, fn] of listeners) api.events.removeListener(event, fn);
      holder.active = null;
    }
    else active.uncertain = true;
  }
}
module.exports = { installLocalArchive, packageProof, noNexus };
