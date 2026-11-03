'use strict';
// Private native driver: synthetic paths only. Never load into ordinary Vortex.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const { isDeepStrictEqual } = require('node:util');
const input = require('./input.json');
const { actions, selectors, util } = require('@nexusmods/vortex-api');
const root = input.root, G = 'cyberpunk2077', P = 'native-agent-fixture';
const must = (ok, code) => { if (!ok) throw Error(code); };
// Independent fixture assertions: no identifiers or native payload in diagnostics.
function diagnosticProof(value, completed = false) {
  const phases = ['preflight', 'package', 'import', 'import_settle', 'install', 'native_hook', 'staged_proof', 'finalizing_receipt'];
  const metrics = ['context_checks', 'archive_proof', 'host_admission', 'metadata', 'native_import', 'import_settle', 'native_install', 'staged_proof', 'receipt_commit'];
  const exact = (v, keys) => v && typeof v === 'object' && !Array.isArray(v)
    && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
  const numeric = v => Number.isSafeInteger(v) && v >= 0;
  must(exact(value, ['schema', 'phase', 'state', 'waitReason', 'reason', 'elapsedMs', 'budgetMs', 'remainingMs',
    'effectsMayHaveOccurred', 'nativeMayContinue', 'phaseTimes', 'metrics']) && value.schema === 'install-diagnostics/1'
    && phases.includes(value.phase) && ['running', 'finalizing', 'completed', 'failed_before_effect', 'held'].includes(value.state)
    && ['none', 'source_proof', 'metadata_reply', 'import_callback', 'download_finished', 'install_callback', 'receipt_commit'].includes(value.waitReason)
    && ['none', 'deadline', 'stage_timeout', 'native_failure', 'operation_error', 'receipt_cleanup'].includes(value.reason)
    && ['elapsedMs', 'budgetMs', 'remainingMs'].every(k => numeric(value[k])) && value.budgetMs > 0
    && value.remainingMs === Math.max(0, value.budgetMs - value.elapsedMs)
    && typeof value.effectsMayHaveOccurred === 'boolean' && typeof value.nativeMayContinue === 'boolean'
    && exact(value.phaseTimes, phases) && phases.every(k => numeric(value.phaseTimes[k]))
    && exact(value.metrics, metrics) && metrics.every(k => exact(value.metrics[k], ['calls', 'totalMs'])
      && numeric(value.metrics[k].calls) && numeric(value.metrics[k].totalMs)), 'INSTALL_DIAGNOSTICS_SCHEMA_INVALID');
  if (completed) {
    must(value.state === 'completed' && value.phase === 'finalizing_receipt' && value.reason === 'none'
      && value.waitReason === 'none' && value.effectsMayHaveOccurred && !value.nativeMayContinue, 'INSTALL_DIAGNOSTICS_NOT_COMPLETED');
    must(metrics.every(k => value.metrics[k].calls >= 1) && value.metrics.archive_proof.calls === 2
      && ['native_import', 'import_settle', 'native_install', 'staged_proof', 'receipt_commit'].every(k => value.metrics[k].calls === 1),
    'INSTALL_DIAGNOSTICS_COUNTS_INVALID');
  }
}
const norm = p => path.resolve(p).toLowerCase();
const sha = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
function contained(p) {
  const rel = path.relative(root, p);
  must(rel && !rel.startsWith('..') && !path.isAbsolute(rel), 'FIXTURE_PATH_ESCAPE');
  let current = root;
  for (const part of rel.split(path.sep)) {
    current = path.join(current, part);
    if (fs.existsSync(current)) must(!fs.lstatSync(current).isSymbolicLink(), 'FIXTURE_REPARSE_POINT');
  }
  return p;
}
const diskProof = p => {
  contained(p); const s = fs.statSync(p, { bigint: true });
  return { path: p, size: Number(s.size), sha256: sha(p), filesystemId: `${s.dev}:${s.ino}`, links: Number(s.nlink) };
};
const wait = async (fn, code) => {
  const deadline = Date.now() + 45000;
  while (!fn()) { must(Date.now() < deadline, code); await new Promise(r => setTimeout(r, 200)); }
};
const bounded = (promise, code, ms = 90000) => {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(code)), ms); })]).finally(() => clearTimeout(timer));
};
function native(api, name, args) {
  return bounded(new Promise((resolve, reject) => {
    const cb = (err, value) => err ? reject(Error('NATIVE_EVENT_FAILED_' + name)) : resolve(value);
    try { must(api.events.emit(name, ...args(cb)), 'NO_NATIVE_LISTENER_' + name); } catch (err) { reject(err); }
  }), 'NATIVE_EVENT_TIMEOUT_' + name);
}
function rpc(token, name, args = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
    const req = http.request('http://127.0.0.1:3702/mcp', { method: 'POST', headers: {
      'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: 'Bearer ' + token,
    } }, res => {
      let text = '', bytes = 0;
      res.on('data', chunk => { bytes += chunk.length; if (bytes > 8 * 1024 * 1024) req.destroy(Error('HTTP_TOO_LARGE')); else text += chunk; });
      res.on('end', () => {
        try {
          must(res.statusCode === 200, 'FIXTURE_HTTP_STATUS_' + res.statusCode);
          const payload = text.startsWith('{') ? JSON.parse(text) : JSON.parse(text.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('\n'));
          must(!payload.error && !payload.result?.isError, 'FIXTURE_TOOL_ERROR_' + name + '_' + (payload.result?.content?.[0]?.text || 'RPC'));
          resolve(JSON.parse(payload.result.content[0].text));
        } catch (err) { reject(err); }
      });
    });
    req.setTimeout(90000, () => req.destroy(Error('FIXTURE_HTTP_TIMEOUT')));
    req.on('error', reject); req.end(body);
  });
}
module.exports = context => {
  must(process.env.VORTEX_AGENT_NATIVE_FIXTURE === root, 'NOT_FIXTURE_PROCESS');
  context.once(() => { setTimeout(() => { void run(context.api); }, 3000); });
  return true;
};
async function run(api) {
  const receiptPath = contained(path.join(root, 'native-receipt.json'));
  must(!fs.existsSync(receiptPath), 'FIXTURE_ALREADY_ATTEMPTED');
  const receipt = { status: 'running', rendererPid: process.pid, started: new Date().toISOString(), events: [], nexusReuse: { status: 'skipped', reason: 'Local import has no legitimate Nexus IDs; no synthetic IDs fabricated.' } };
  function save() { const h = fs.openSync(receiptPath, 'w'); try { fs.writeFileSync(h, JSON.stringify(receipt, null, 2)); fs.fsyncSync(h); } finally { fs.closeSync(h); } }
  function note(phase, data = {}) { receipt.events.push({ phase, at: new Date().toISOString(), ...data }); save(); }
  function boundary(active = true) {
    must(norm(process.env.NEXUS_WORKSPACE) === norm(root), 'FIXTURE_WORKSPACE_MISMATCH');
    must(process.env.VORTEX_E2E === '1' && process.env.VORTEX_E2E_HEADLESS === '1', 'E2E_REQUIRED');
    must(norm(util.getVortexPath('userData')) === norm(input.userData), 'ACTUAL_USERDATA_MISMATCH');
    must(norm(process.env.ELECTRON_USERDATA) === norm(input.earlyData), 'EARLY_USERDATA_MISMATCH');
    must(norm(process.env.ELECTRON_APPDATA) === norm(path.join(root, 'appdata')), 'APPDATA_MISMATCH');
    const s = api.getState();
    for (const [id, d] of Object.entries(s.settings.gameMode.discovered || {})) if (d.path) must(id === G && norm(d.path) === norm(input.game), 'EXTERNAL_DISCOVERY');
    if (active) {
      must(selectors.activeProfileId(s) === P && selectors.activeGameId(s) === G, 'ACTIVE_CONTEXT_MISMATCH');
      must(norm(selectors.installPathForGame(s, G)) === norm(input.stage), 'STAGING_MISMATCH');
      must(norm(selectors.downloadPathForGame(s, G)) === norm(input.downloads), 'DOWNLOADS_MISMATCH');
    }
    for (const p of [input.userData, input.earlyData, input.game, input.stage, input.downloads]) contained(p);
  }
  let listener;
  try {
    must(['tracked-download', 'local-archive', 'mcp-local-archive'].includes(input.installRoute || 'tracked-download'), 'INSTALL_ROUTE_INVALID');
    must(!input.withExistingMod || input.installRoute === 'mcp-local-archive', 'EXISTING_MOD_REQUIRES_CURATED_ROUTE');
    boundary(false); save();
    await wait(() => util.getGames().filter(g => g.id === G).length === 1 && typeof api.ext.awaitModsDeployment === 'function', 'PROVIDER_TIMEOUT');
    must(Object.keys(api.getState().persistent.profiles || {}).length === 0, 'NONEMPTY_FIXTURE_PROFILES');
    must(Object.keys(api.getState().persistent.mods?.[G] || {}).length === 0, 'NONEMPTY_FIXTURE_MODS');
    for (const name of ['setAutoDeployment', 'setAutoInstall', 'setAutoEnable', 'setAutoStart', 'setConfirmPurge']) api.store.dispatch(actions[name](false));
    api.store.dispatch(actions.addDiscoveredGame(G, { path: input.game, pathSetManually: true, store: 'steam', executable: 'bin/x64/Cyberpunk2077.exe' }));
    api.store.dispatch(actions.setInstallPath(G, input.stage));
    api.store.dispatch(actions.setDownloadPath(path.join(root, 'downloads')));
    api.store.dispatch(actions.setActivator(G, 'hardlink_activator'));
    api.store.dispatch(actions.setProfile({ id: P, gameId: G, name: 'PRIVATE Synthetic Agent Fixture', modState: {}, lastActivated: 0, features: {} }));
    api.store.dispatch(actions.setNextProfile(P));
    await wait(() => selectors.activeProfileId(api.getState()) === P, 'PROFILE_ACTIVATION_TIMEOUT');
    boundary();
    const bundle = require('./runtime.cjs');
    const token = crypto.randomBytes(32).toString('hex');
    note('native-source-inventory', { loaded: api.getLoadedExtensions().map(e => ({ name: e.name, path: e.path, dynamic: e.dynamic })) });
    const sourceBinding = { packagePath: path.join(path.dirname(process.execPath), 'resources/app.asar'), expected: {
      appAsarSha256: 'ec3a29d58ea65a1ca84e456742c894a19efe96920a6710063d221d451a26d59a',
      dynamic: [
        ...(input.dynamicSources || []).filter(e => ![__dirname, path.join(input.userData, 'plugins/fixture-cyberpunk-support')].includes(e.path)),
        { path: __dirname, files: [{ path: 'index.js', sha256: sha(__filename) }, { path: 'runtime.cjs', sha256: input.runtimeSourceSha256 }] },
        { path: path.join(input.userData, 'plugins/fixture-cyberpunk-support'), files: [{ path: 'index.js', sha256: '59d7d12179f30b2e77cab28bb5d417479e5f39269e9ce71e49ea5fac5782269a' }] },
      ],
    } };
    listener = bundle.start(api, 3702, { tokenProvider: async () => token, localInstallHostBinding: sourceBinding });
    await bounded(new Promise((resolve, reject) => { if (listener.listening) resolve(); else { listener.once('listening', resolve); listener.once('error', () => reject(Error('FIXTURE_BIND_FAILED'))); } }), 'BIND_TIMEOUT', 10000);
    const health = await rpc(token, 'health');
    must(health.extensionVersion === input.runtimeVersion, 'FIXTURE_RUNTIME_VERSION_MISMATCH');
    note('authenticated-native-health', { health, listenerPort: 3702 });
    const target = contained(path.join(input.game, input.payloadPath));
    must(sha(target) === input.sentinelSha256, 'SENTINEL_BASELINE_MISMATCH');
    let existingBaseline;
    function existingSnapshot(excludeId) {
      const s = api.getState(), id = existingBaseline.modId;
      const profileFlags = Object.fromEntries(Object.entries(s.persistent.profiles || {}).map(([profileId, profile]) =>
        [profileId, Object.fromEntries(Object.entries(profile.modState || {}).filter(([modId]) => modId !== excludeId)
          .map(([modId, flags]) => [modId, flags.enabled === true]))]));
      return { modId: id, mod: structuredClone(s.persistent.mods[G][id]), profileFlags,
        staged: diskProof(existingBaseline.staged.path) };
    }
    function verifyExisting(excludeId) {
      if (!existingBaseline) return;
      const after = existingSnapshot(excludeId);
      const beforeJSON = JSON.stringify(existingBaseline), afterJSON = JSON.stringify(after);
      if (beforeJSON !== afterJSON) {
        const bounded = (value, text) => text.length <= 32768 ? value : {
          snapshotBytes: Buffer.byteLength(text), sha256: crypto.createHash('sha256').update(text).digest('hex') };
        note('existing-mod-preservation-mismatch', {
          before: bounded(existingBaseline, beforeJSON), after: bounded(after, afterJSON) });
        throw Error('EXISTING_MOD_OR_FLAGS_CHANGED');
      }
      must(!fs.existsSync(contained(path.join(input.game, input.existingMod.payloadPath))), 'EXISTING_MOD_AUTO_DEPLOYED');
      return after;
    }
    if (input.withExistingMod) {
      const archive = contained(input.existingMod.archivePath);
      must(sha(archive) === input.existingMod.archiveSha256 && fs.statSync(archive).size === input.existingMod.archiveSize,
        'EXISTING_ARCHIVE_MISMATCH');
      let didInstall = false;
      const installed = (gameId, archiveId, modId) => {
        if (gameId === G && archiveId === null && modId === 'native-agent-existing') didInstall = true;
      };
      api.events.on('did-install-mod', installed);
      try {
        const id = await native(api, 'start-install', cb => [archive, cb]);
        boundary();
        const mod = api.getState().persistent.mods[G][id];
        must(typeof id === 'string' && id === 'native-agent-existing' && mod?.state === 'installed'
          && mod.installationPath === id, 'EXISTING_MOD_INSTALL_UNVERIFIED');
        const staged = contained(path.join(input.stage, id, input.existingMod.payloadPath));
        must(sha(staged) === input.existingMod.payloadSha256, 'EXISTING_MOD_BYTES_MISMATCH');
        must(typeof actions.setModEnabled === 'function', 'EXISTING_MOD_DISABLE_ACTION_UNAVAILABLE');
        api.store.dispatch(actions.setModEnabled(P, id, false));
        // Stock InstallManager starts setModSize without awaiting it before the
        // install callback. Capture only after its exact one-file size settles.
        const expectedSize = fs.statSync(staged).size;
        await wait(() => didInstall && api.getState().persistent.mods[G][id]?.attributes?.modSize === expectedSize,
          'EXISTING_MOD_POST_INSTALL_PENDING');
        boundary();
        must(api.getState().persistent.profiles[P].modState[id]?.enabled === false, 'EXISTING_MOD_DISABLE_UNVERIFIED');
        existingBaseline = { modId: id, staged: { path: staged } };
        existingBaseline = existingSnapshot();
        note('existing-mod-baseline-settled', { modId: id, didInstall, modSize: expectedSize, enabled: false });
      } finally { api.events.removeListener('did-install-mod', installed); }
      must(Object.values(existingBaseline.profileFlags).every(flags => flags[existingBaseline.modId] !== true), 'EXISTING_MOD_AUTO_ENABLED');
      verifyExisting();
      note('existing-mod-baseline', existingBaseline);
    }
    const direct = input.installRoute === 'local-archive';
    // Doodlebot localMod.ts (3b78fdf): same stock event, without its UI responders.
    let modId;
    if (input.installRoute === 'mcp-local-archive') {
      const pins = Object.fromEntries(['gameId', 'profileId', 'gamePath', 'stagingPath', 'downloadPath', 'filesystemIds'].map(k => [k, health[k]]));
      note('mcp-local-install-intent');
      const requestId = input.runId + '_install', samples = [];
      let settled = false, observationError;
      // Handle rejection immediately while the read-only observer runs independently.
      const installing = rpc(token, 'install_local_archive', { ...pins, requestId,
        archivePath: input.archive, size: input.archiveSize, sha256: input.archiveSha256 })
        .then(result => { settled = true; return { result }; }, error => { settled = true; return { error }; });
      while (!settled && samples.length < 90) {
        const started = Date.now();
        try {
          const observed = await rpc(token, 'reconcile_operation', { requestId });
          if (observed.attempt) must(observed.attempt.requestId === requestId
            && observed.attempt.operation === 'install_local_archive', 'LIVE_INSTALL_ATTEMPT_MISMATCH');
          if (observed.installDiagnostics) diagnosticProof(observed.installDiagnostics);
          samples.push({ source: observed.installDiagnosticsSource || 'unavailable',
            attemptAt: observed.attempt?.at || null, diagnostics: observed.installDiagnostics || null });
        } catch (error) { observationError = error; break; }
        if (!settled && samples.length < 90) {
          let timer;
          try { await Promise.race([installing, new Promise(resolve => { timer = setTimeout(resolve, Math.max(0, 1000 - (Date.now() - started))); })]); }
          finally { clearTimeout(timer); }
        }
      }
      const outcome = await installing;
      if (outcome.error) throw outcome.error;
      if (observationError) throw observationError;
      const result = outcome.result;
      must(result.operationCompleted === true, 'LOCAL_INSTALL_NOT_COMPLETED');
      diagnosticProof(result.installDiagnostics, true);
      note('mcp-local-install-completed', { result });
      must(samples.some(sample => sample.source === 'live' && sample.diagnostics), 'LIVE_INSTALL_DIAGNOSTICS_NOT_OBSERVED');
      const retained = await rpc(token, 'reconcile_operation', { requestId });
      const sidecar = JSON.parse(fs.readFileSync(contained(path.join(input.adapterReceipts, requestId + '.diagnostics.json')), 'utf8'));
      must(retained.attempt?.requestId === requestId && retained.attempt.operation === 'install_local_archive'
        && retained.installDiagnosticsSource === 'retained' && retained.terminalOperationVerified === true,
      'RETAINED_INSTALL_DIAGNOSTICS_UNAVAILABLE');
      diagnosticProof(retained.installDiagnostics, true);
      must(sidecar.schema === 'install-diagnostic-record/1' && sidecar.requestId === requestId
        && sidecar.operation === 'install_local_archive' && sidecar.attemptAt === retained.attempt.at
        && samples.filter(sample => sample.diagnostics).every(sample => sample.attemptAt === retained.attempt.at)
        && isDeepStrictEqual(sidecar.diagnostics, retained.installDiagnostics)
        && isDeepStrictEqual(sidecar.diagnostics, result.installDiagnostics), 'INSTALL_DIAGNOSTICS_SIDECAR_MISMATCH');
      note('mcp-local-install-diagnostics', { requestId, samples,
        retained: { source: retained.installDiagnosticsSource, attemptAt: retained.attempt.at, diagnostics: retained.installDiagnostics } });
      modId = result.modId;
    }
    const curated = input.installRoute === 'mcp-local-archive';
    if (direct) {
      note('native-local-install-intent', { archive: diskProof(input.archive) });
      modId = await native(api, 'start-install', cb => [input.archive, cb]);
      boundary();
    }
    const ids = direct ? [] : curated ? [api.getState().persistent.mods[G][modId].archiveId]
      : await native(api, 'import-downloads', cb => [[input.archive], values => cb(null, values), true]);
    boundary(); must(Array.isArray(ids) && ids.length === (direct ? 0 : 1), 'IMPORT_COUNT_MISMATCH');
    const downloadId = ids[0];
    if (!direct) await wait(() => api.getState().persistent.downloads.files[downloadId]?.state === 'finished', 'DOWNLOAD_FINISHED_TIMEOUT');
    const record = direct ? null : api.getState().persistent.downloads.files[downloadId];
    if (!direct) must(record.game?.length === 1 && record.game[0] === G, 'IMPORTED_GAME_MISMATCH');
    const archive = direct ? input.archive : contained(path.join(input.downloads, record.localPath));
    must((direct || path.dirname(norm(archive)) === norm(input.downloads)) && sha(archive) === input.archiveSha256 && fs.statSync(archive).size === input.archiveSize, 'IMPORTED_ARCHIVE_MISMATCH');
    note(direct ? 'native-local-archive-finished' : 'native-import-finished', { downloadId, archive: diskProof(archive), trackedDownloadCount: Object.keys(api.getState().persistent.downloads.files).length });
    boundary(); must(Object.keys(api.getState().persistent.mods?.[G] || {}).length
      === (input.withExistingMod ? 1 : 0) + (direct || curated ? 1 : 0), 'INSTALL_COLLISION');
    if (!direct && !curated) modId = await native(api, 'start-install-download', cb => [downloadId, { allowAutoEnable: false, profileId: P }, cb]);
    boundary();
    must(typeof modId === 'string' && modId.length > 0, 'INSTALL_MOD_ID_INVALID');
    const mod = api.getState().persistent.mods[G][modId];
    must(mod?.state === 'installed' && (direct || mod.archiveId === downloadId), 'INSTALLED_RECORD_MISMATCH');
    must(api.getState().persistent.profiles[P].modState[modId]?.enabled !== true, 'INSTALL_AUTO_ENABLED');
    const staged = contained(path.join(input.stage, mod.installationPath, input.payloadPath));
    must(sha(staged) === input.payloadSha256 && sha(target) === input.sentinelSha256, 'INSTALL_ONLY_BYTES_MISMATCH');
    note('native-install-only', { modId, installationPath: mod.installationPath, downloadId, staged: diskProof(staged), original: diskProof(target) });
    if (existingBaseline) {
      note('existing-mod-preserved-after-install', verifyExisting(modId));
      const modsBefore = JSON.stringify(api.getState().persistent.mods), profilesBefore = JSON.stringify(api.getState().persistent.profiles);
      const downloadsBefore = JSON.stringify(api.getState().persistent.downloads.files);
      const pins = Object.fromEntries(['gameId', 'profileId', 'gamePath', 'stagingPath', 'downloadPath', 'filesystemIds'].map(k => [k, health[k]]));
      let refusal;
      try {
        await rpc(token, 'install_local_archive', { ...pins, requestId: input.runId + '_collision',
          archivePath: input.archive, size: input.archiveSize, sha256: input.archiveSha256 });
      } catch (error) { refusal = String(error.message); }
      must(refusal?.includes('LOCAL_ARCHIVE_MOD_COLLISION'), 'SECOND_INSTALL_NOT_REFUSED');
      const failed = JSON.parse(fs.readFileSync(path.join(input.adapterReceipts, input.runId + '_collision.failed.json')));
      must(failed.effectsMayHaveOccurred === false && failed.inspectBeforeRetry === false
        && failed.errorCode === 'LOCAL_ARCHIVE_MOD_COLLISION', 'COLLISION_REFUSAL_HAS_EFFECTS');
      must(!fs.existsSync(path.join(input.adapterReceipts, 'unresolved.json')), 'COLLISION_LEFT_UNRESOLVED');
      must(JSON.stringify(api.getState().persistent.mods) === modsBefore
        && JSON.stringify(api.getState().persistent.profiles) === profilesBefore
        && JSON.stringify(api.getState().persistent.downloads.files) === downloadsBefore, 'COLLISION_CHANGED_STATE');
      note('same-archive-collision-refused', { failed, installedMods: Object.keys(api.getState().persistent.mods[G]).length,
        unresolved: false, existing: verifyExisting(modId) });
    }
    async function operation(name, suffix, extra = {}) {
      boundary(); const h = await rpc(token, 'health');
      for (const [key, expected] of Object.entries({ gameId: G, profileId: P, gamePath: input.game, stagingPath: input.stage, downloadPath: input.downloads })) must(key.endsWith('Path') ? norm(h[key]) === norm(expected) : h[key] === expected, 'HTTP_HEALTH_PIN_DRIFT');
      const pins = Object.fromEntries(['gameId', 'profileId', 'gamePath', 'stagingPath', 'downloadPath', 'filesystemIds'].map(k => [k, h[k]]));
      const result = await rpc(token, name, { ...pins, requestId: input.runId + '_' + suffix, ...extra });
      boundary(); must(result.operationCompleted === true, 'OPERATION_NOT_COMPLETED'); note(name + '_' + suffix, { result, pins });
    }
    await operation('set_mods_enabled', 'enable', { modIds: [modId], enabled: true });
    await operation('deploy_mods', 'deploy');
    const manifestPath = contained(path.join(input.game, 'vortex.deployment.json'));
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    must(manifest.gameId === G && norm(manifest.targetPath) === norm(input.game) && norm(manifest.stagingPath) === norm(input.stage), 'MANIFEST_PATH_MISMATCH');
    const entry = manifest.files.find(f => f.relPath.replace(/\\/g, '/') === input.payloadPath);
    must(entry?.source === mod.installationPath && manifest.files.length === 1, 'MANIFEST_OWNER_MISMATCH');
    const a = diskProof(target), b = diskProof(staged), backup = diskProof(target + '.vortex_backup');
    must(a.sha256 === input.payloadSha256 && b.sha256 === a.sha256 && a.filesystemId === b.filesystemId && a.links >= 2, 'HARDLINK_DEPLOYMENT_UNPROVEN');
    must(backup.sha256 === input.sentinelSha256, 'ORIGINAL_BACKUP_MISMATCH');
    note('independent-disk-deployment-proof', { manifest, manifestSha256: sha(manifestPath), game: a, staging: b, backup });
    await operation('set_mods_enabled', 'disable', { modIds: [modId], enabled: false });
    await operation('deploy_mods', 'restore');
    must(sha(target) === input.sentinelSha256 && !fs.existsSync(target + '.vortex_backup'), 'ORIGINAL_NOT_RESTORED');
    // Native activationStore removes the deployment manifest when no files remain.
    const restored = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : { files: [], manifestAbsent: true };
    must(restored.files.length === 0 && sha(staged) === input.payloadSha256, 'RESTORED_MANIFEST_MISMATCH');
    const trackedDownloads = Object.keys(api.getState().persistent.downloads.files).length;
    const installedMods = input.withExistingMod ? 2 : 1;
    must(trackedDownloads === (direct ? 0 : 1) && Object.keys(api.getState().persistent.mods[G]).length === installedMods, 'DUPLICATE_RECORDS');
    note('independent-rollback-proof', { original: diskProof(target), staging: diskProof(staged), manifest: restored, enabled: api.getState().persistent.profiles[P].modState[modId].enabled, trackedDownloads, installedMods });
    if (existingBaseline) note('existing-mod-preserved-after-rollback', verifyExisting(modId));
    receipt.status = 'passed';
  } catch (err) {
    receipt.status = 'failed'; receipt.error = String(err.message).slice(0, 1000);
  } finally {
    receipt.finished = new Date().toISOString(); save();
    if (listener) listener.close();
    // Window close follows the host's normal persistence/finalization path.
    try {
      const ipc = require('electron').ipcRenderer;
      const response = await ipc.invoke('window:getId');
      const id = typeof response === 'number' ? response : response.data;
      must(Number.isInteger(id) && id > 0, 'WINDOW_ID_INVALID');
      note('graceful-fixture-window-close-request', { windowId: id });
      await ipc.invoke('window:close', id);
    } catch { note('graceful-close-unavailable'); }
  }
}
