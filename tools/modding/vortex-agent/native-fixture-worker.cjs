'use strict';
// Private native driver: synthetic paths only. Never load into ordinary Vortex.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const { pathToFileURL } = require('node:url');
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
function verifyPlanClientSources() {
  const sourceRoot = input.planClientRoot, pins = input.planClientSources;
  must(typeof sourceRoot === 'string' && path.isAbsolute(sourceRoot) && pins && typeof pins === 'object'
    && Object.keys(pins).length > 0 && Object.keys(pins).length <= 64, 'FIXTURE_CLIENT_SOURCE_SCOPE');
  const seen = new Set(), pending = ['session.mjs'];
  while (pending.length) {
    const relative = pending.pop(); if (seen.has(relative)) continue;
    must(/^[a-zA-Z0-9_.-]+\.(?:mjs|cjs|json)$/.test(relative) && pins[relative], 'FIXTURE_CLIENT_SOURCE_SCOPE');
    const file = path.join(sourceRoot, relative);
    for (let p = file; ; p = path.dirname(p)) { must(!fs.lstatSync(p).isSymbolicLink(), 'FIXTURE_CLIENT_SOURCE_REPARSE'); if (p === path.dirname(p)) break; }
    const stat = fs.statSync(file, { bigint: true });
    must(stat.isFile() && stat.size <= 1024n * 1024n && sha(file) === pins[relative].sha256
      && [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':') === pins[relative].generation,
    'FIXTURE_CLIENT_SOURCE_CHANGED');
    seen.add(relative);
    if (relative.endsWith('.json')) continue;
    for (const match of fs.readFileSync(file, 'utf8').matchAll(/(?:\bfrom\s*|\bimport\s*\(|\brequire\s*\()\s*['"]([^'"]+)['"]/g)) {
      if (match[1].startsWith('node:')) continue;
      must(/^\.\/[a-zA-Z0-9_.-]+\.(?:mjs|cjs|json)$/.test(match[1]), 'FIXTURE_CLIENT_EXTERNAL_IMPORT');
      pending.push(match[1].slice(2));
    }
  }
  must(seen.size === Object.keys(pins).length && Object.keys(pins).every(key => seen.has(key)), 'FIXTURE_CLIENT_SOURCE_CLOSURE');
}
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
  let planClient, planJournalClient;
  try {
    must(['tracked-download', 'local-archive', 'mcp-local-archive'].includes(input.installRoute || 'tracked-download'), 'INSTALL_ROUTE_INVALID');
    must(!input.withExistingMod || input.installRoute === 'mcp-local-archive', 'EXISTING_MOD_REQUIRES_CURATED_ROUTE');
    must(!input.candidateAssessment || input.installRoute === 'mcp-local-archive' && input.withExistingMod,
      'CANDIDATE_ASSESSMENT_REQUIRES_EXISTING_CURATED_FIXTURE');
    must(!input.ownLocalPlan || input.installRoute === 'mcp-local-archive' && input.withExistingMod && !input.candidateAssessment,
      'OWN_LOCAL_PLAN_REQUIRES_EXCLUSIVE_EXISTING_CURATED_FIXTURE');
    boundary(false); save();
    if (input.ownLocalPlan) {
      // Preflight actual Electron ESM support before any fixture installation.
      verifyPlanClientSources(); must(sha(__filename) === input.fixtureWorkerSha256, 'FIXTURE_DRIVER_SOURCE_CHANGED');
      try {
        planClient = await import(pathToFileURL(path.join(input.planClientRoot, 'session.mjs')).href);
        planJournalClient = await import(pathToFileURL(path.join(input.planClientRoot, 'plan-journal.mjs')).href);
      } catch { throw Error('FIXTURE_ELECTRON_CLIENT_ESM_UNAVAILABLE'); }
      must(typeof planClient.runPlan === 'function' && typeof planJournalClient.createPlanJournal === 'function'
        && typeof planJournalClient.canonicalPlanId === 'function', 'FIXTURE_CLIENT_API_UNAVAILABLE');
      verifyPlanClientSources();
      note('own-local-plan-client-preflight', { entry: 'session.mjs', sources: input.planClientSources,
        fixtureWorkerSha256: input.fixtureWorkerSha256, nativeEffects: false });
    }
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
        if (input.ownLocalPlan) {
          const second = { id: 'native-agent-plan-second', gameId: G, name: 'PRIVATE inactive plan preservation',
            modState: { [id]: { enabled: true, enabledTime: 1 } }, lastActivated: 0, features: {} };
          const dispatch = api.store.dispatch; let complete, released = false, loadOrderCompleted = false, starts = 0, stops = 0;
          const settled = new Promise(resolve => { complete = resolve; });
          function observe(...args) {
            if (released) return api.store.dispatch.apply(api.store, args);
            const result = dispatch.apply(this, args), action = args[0];
            if (action?.type === 'SET_FB_LOAD_ORDER' && action.payload?.profileId === P
              && Array.isArray(action.payload.loadOrder) && action.payload.loadOrder.length === 0) {
              loadOrderCompleted = true;
            }
            if (action?.payload?.group === 'installing_dependencies' && action.payload.activityId === id) {
              if (action.type === 'START_ACTIVITY') starts++;
              if (action.type === 'STOP_ACTIVITY') stops++;
            }
            if (loadOrderCompleted && starts === 2 && stops === 2
              && (api.getState().session.base.activity?.installing_dependencies ?? []).length === 0
              && Array.isArray(api.getState().persistent.loadOrder?.[P])
              && api.getState().persistent.loadOrder[P].length === 0) complete();
            return result;
          }
          api.store.dispatch = observe;
          try {
            api.store.dispatch(actions.setProfile(second));
            // Even without rules, the stock enabled-mod observer runs both
            // dependency/recommendation activities. Join both exact lifecycles
            // and active-profile load order, independent of completion order.
            await bounded(settled, 'PLAN_SECOND_PROFILE_SETUP_UNOBSERVED', 15000);
            must(loadOrderCompleted && starts === 2 && stops === 2 && selectors.activeProfileId(api.getState()) === P
              && isDeepStrictEqual(api.getState().persistent.profiles[second.id], second), 'PLAN_SECOND_PROFILE_SETUP_CHANGED');
            note('own-local-plan-second-profile-baseline', { profile: structuredClone(second), activeProfileId: P,
              starts, stops, loadOrderCompletionObserved: true, sourceBlobs: { profiles: '4b4cddc08c29f5fa2d78b0e7f59ebea8dc3380c1',
                installManager: '6f847f3f878a0f8a8082b827d8b2bc4ebbcbe221', activity: '250cf30f897938ed1705cfec654b3b6b4f79d598',
                loadOrder: '8f3044cc73c8d97629da3f4f304382eb7fe71149', loadOrderAction: 'b8f88de149399ed01d346ae8e6b4788438078f30' } });
          } finally { api.store.dispatch = dispatch; released = true; }
        }
        existingBaseline = { modId: id, staged: { path: staged } };
        existingBaseline = existingSnapshot();
        note('existing-mod-baseline-settled', { modId: id, didInstall, modSize: expectedSize, enabled: false });
      } finally { api.events.removeListener('did-install-mod', installed); }
      must(Object.entries(existingBaseline.profileFlags).every(([profile, flags]) =>
        input.ownLocalPlan && profile === 'native-agent-plan-second' ? flags[existingBaseline.modId] === true
          : flags[existingBaseline.modId] !== true), 'EXISTING_MOD_AUTO_ENABLED');
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
      if (input.ownLocalPlan) verifyPlanClientSources();
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
    if (input.ownLocalPlan) {
      verifyPlanClientSources(); boundary();
      must(Array.isArray(input.planPackages) && input.planPackages.length === 2, 'PLAN_PACKAGES_INVALID');
      const originals = { mods: [modId, existingBaseline.modId].map(id => structuredClone(api.getState().persistent.mods[G][id])),
        flags: [modId, existingBaseline.modId].map(id => structuredClone(api.getState().persistent.profiles[P].modState[id])),
        secondProfile: structuredClone(api.getState().persistent.profiles['native-agent-plan-second']),
        game: diskProof(target), staged: diskProof(staged), existing: diskProof(existingBaseline.staged.path) };
      const packages = input.planPackages.map(item => {
        const archive = diskProof(item.archivePath), original = diskProof(contained(path.join(input.game, item.payloadPath)));
        must(archive.sha256 === item.archiveSha256 && archive.size === item.archiveSize
          && original.sha256 === item.sentinelSha256 && !api.getState().persistent.mods[G][item.modId], 'PLAN_PACKAGE_BASELINE_INVALID');
        return { ...item, original };
      });
      const context = Object.fromEntries(['gameId', 'profileId', 'gamePath', 'stagingPath', 'downloadPath', 'filesystemIds'].map(k => [k, health[k]]));
      const request = suffix => input.runId + '_plan_' + suffix;
      const plan = { version: 1, context, steps: [
        ...packages.map((item, index) => ({ operation: 'install_local_archive', requestId: request('install_' + index),
          archivePath: item.archivePath, size: item.archiveSize, sha256: item.archiveSha256 })),
        { operation: 'set_mods_enabled', requestId: request('enable'), modIds: packages.map(p => p.modId), enabled: true },
      ], deploy: { requestId: request('deploy') } };
      const journalRoot = contained(path.join(root, 'plan-journals'));
      const journal = planJournalClient.createPlanJournal({ root: journalRoot });
      const writes = [], checkpoints = [];
      const disabledFlags = id => {
        const flags = api.getState().persistent.profiles[P].modState;
        return !Object.hasOwn(flags, id) || flags[id] !== null && typeof flags[id] === 'object'
          && !Array.isArray(flags[id]) && flags[id].enabled === false;
      };
      const mutationNames = ['install_local_archive', 'set_mods_enabled', 'deploy_mods'];
      const call = async (name, args = {}) => {
        if (mutationNames.includes(name)) {
          verifyPlanClientSources(); must(sha(__filename) === input.fixtureWorkerSha256, 'FIXTURE_DRIVER_SOURCE_CHANGED'); boundary();
          if (name === 'set_mods_enabled' && args.enabled === true) {
            must(checkpoints.length === 2 && packages.every(item =>
              disabledFlags(item.modId)
              && isDeepStrictEqual(diskProof(item.original.path), item.original)), 'PLAN_ACTIVATION_BEFORE_DISABLED_BATCH_PROOF');
            note('own-local-plan-before-activation', { disabledModIds: packages.map(item => item.modId),
              allSentinelsPreserved: true, installedCheckpoints: checkpoints.length });
          }
          writes.push({ operation: name, requestId: args.requestId });
        }
        const result = await rpc(token, name, args);
        if (name === 'install_local_archive') {
          const item = packages.find(p => p.archivePath === args.archivePath);
          must(item && result.modId === item.modId && result.enabled === false && result.payloadFilesVerified === 1,
            'PLAN_INSTALL_ACK_MISMATCH');
          const state = api.getState(), mod = state.persistent.mods[G][item.modId];
          const installed = diskProof(contained(path.join(input.stage, mod.installationPath, item.payloadPath)));
          const original = diskProof(contained(path.join(input.game, item.payloadPath)));
          const profileStates = state.persistent.profiles[P].modState, flags = profileStates[item.modId];
          const flagProof = { entryPresent: Object.hasOwn(profileStates, item.modId),
            enabledType: typeof flags?.enabled, enabled: typeof flags?.enabled === 'boolean' ? flags.enabled : null };
          const installedValid = mod.state === 'installed' && mod.archiveId === result.downloadId
            && disabledFlags(item.modId) && installed.sha256 === item.payloadSha256
            && isDeepStrictEqual(original, item.original) && !fs.existsSync(original.path + '.vortex_backup');
          if (!installedValid) note('own-local-plan-install-check-failed', { modId: item.modId,
            state: typeof mod.state === 'string' ? mod.state.slice(0, 32) : null,
            archiveId: typeof mod.archiveId === 'string' ? mod.archiveId.slice(0, 100) : null,
            expectedDownloadId: result.downloadId, flagProof, effectiveDisabled: disabledFlags(item.modId),
            installed, original, expectedOriginal: item.original, expectedPayloadSha256: item.payloadSha256,
            backupAbsent: !fs.existsSync(original.path + '.vortex_backup') });
          must(installedValid, 'PLAN_INSTALL_NOT_DISABLED_OR_PAYLOAD_INVALID');
          const download = state.persistent.downloads.files[result.downloadId];
          must(download?.state === 'finished', 'PLAN_DOWNLOAD_NOT_FINISHED');
          const imported = diskProof(contained(path.join(input.downloads, download.localPath)));
          must(imported.sha256 === item.archiveSha256 && imported.size === item.archiveSize, 'PLAN_IMPORTED_ARCHIVE_INVALID');
          checkpoints.push({ requestId: args.requestId, modId: item.modId, downloadId: result.downloadId,
            enabled: false, flagProof, installed, original, imported });
          note('own-local-plan-disabled-install-' + checkpoints.length, checkpoints.at(-1));
        }
        return result;
      };
      note('own-local-plan-intent', { plan, planId: planJournalClient.canonicalPlanId(plan), journalRoot,
        packages, originals, sources: input.planClientSources });
      const result = await planClient.runPlan(plan, { apply: true, call, journal });
      note('own-local-plan-result', { result });
      verifyPlanClientSources(); boundary();
      must(result.status === 'completed' && result.completed?.length === 4 && checkpoints.length === 2
        && result.diskDeploymentVerified === false, 'OWN_LOCAL_PLAN_NOT_COMPLETED');
      must(isDeepStrictEqual(writes.map(v => v.operation), ['install_local_archive', 'install_local_archive', 'set_mods_enabled', 'deploy_mods']),
        'PLAN_EFFECT_ORDER_MISMATCH');
      const observed = journal.read(result.planId);
      must(observed?.state === 'completed' && observed.observed === 4 && observed.pending === null, 'PLAN_JOURNAL_NOT_COMPLETED');
      note('own-local-plan-completed', { result, writes, events: observed.events, checkpoints });
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      must(manifest.files.length === 2 && manifest.deploymentMethod === 'hardlink_activator', 'PLAN_MANIFEST_INVALID');
      const deployed = packages.map(item => {
        const checkpoint = checkpoints.find(p => p.modId === item.modId);
        const game = diskProof(item.original.path), installed = diskProof(checkpoint.installed.path), backup = diskProof(game.path + '.vortex_backup');
        const owner = manifest.files.find(f => f.relPath.replace(/\\/g, '/') === item.payloadPath);
        must(owner?.source === api.getState().persistent.mods[G][item.modId].installationPath
          && game.sha256 === item.payloadSha256 && installed.sha256 === game.sha256
          && game.filesystemId === installed.filesystemId && game.links >= 2
          && backup.sha256 === item.sentinelSha256 && backup.filesystemId === item.original.filesystemId
          && api.getState().persistent.profiles[P].modState[item.modId]?.enabled === true, 'PLAN_DEPLOYMENT_UNPROVEN');
        return { modId: item.modId, game, installed, backup };
      });
      note('own-local-plan-disk-deployment-proof', { manifest, deployed });
      await operation('set_mods_enabled', 'plan_disable', { modIds: packages.map(p => p.modId), enabled: false });
      await operation('deploy_mods', 'plan_restore');
      const restoredManifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : { files: [], manifestAbsent: true };
      must(restoredManifest.files.length === 0, 'PLAN_RESTORE_MANIFEST_NOT_EMPTY');
      const restoredPackages = packages.map(item => {
        const checkpoint = checkpoints.find(p => p.modId === item.modId);
        const original = diskProof(item.original.path), installed = diskProof(checkpoint.installed.path);
        must(isDeepStrictEqual(original, item.original) && installed.sha256 === item.payloadSha256
          && !fs.existsSync(original.path + '.vortex_backup')
          && api.getState().persistent.profiles[P].modState[item.modId]?.enabled === false, 'PLAN_ORIGINAL_NOT_RESTORED');
        return { modId: item.modId, original, installed, enabled: false };
      });
      const current = api.getState();
      must(isDeepStrictEqual([modId, existingBaseline.modId].map(id => current.persistent.mods[G][id]), originals.mods)
        && isDeepStrictEqual([modId, existingBaseline.modId].map(id => current.persistent.profiles[P].modState[id]), originals.flags)
        && isDeepStrictEqual(current.persistent.profiles['native-agent-plan-second'], originals.secondProfile)
        && isDeepStrictEqual(diskProof(target), originals.game) && isDeepStrictEqual(diskProof(staged), originals.staged)
        && isDeepStrictEqual(diskProof(existingBaseline.staged.path), originals.existing)
        && Object.keys(current.persistent.mods[G]).length === 4
        && Object.keys(current.persistent.downloads.files).length === 3, 'PLAN_BASELINE_CHANGED');
      verifyPlanClientSources();
      note('own-local-plan-rollback-proof', { restoredPackages, manifest: restoredManifest, originals,
        installedMods: 4, trackedDownloads: 3, sourceGenerationVerified: true });
    }
    if (input.candidateAssessment) {
      must(typeof actions.addMod === 'function' && typeof actions.setProfile === 'function'
        && ['testModReference', 'modRuleId', 'ruleInstallSpec', 'findModByRef'].every(key => typeof util[key] === 'function'),
      'ASSESSMENT_NATIVE_API_UNAVAILABLE');
      must(sha(__filename) === input.fixtureWorkerSha256, 'ASSESSMENT_DRIVER_SOURCE_MISMATCH');
      const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
      const collectionId = 'native-assessment-collection', secondProfileId = 'native-assessment-second';
      const id = suffix => 'native-assessment-' + suffix;
      const md5 = text => crypto.createHash('md5').update('fixture metadata only:' + text).digest('hex');
      const choices = selected => ({ type: 'fomod', options: [{ name: 'fixture-step',
        groups: [{ name: 'fixture-group', choices: [{ name: selected, idx: selected === 'old' ? 0 : 1 }] }] }] });
      const record = (suffix, hash, extra = {}) => ({ id: id(suffix), state: 'installed', type: '',
        installationPath: id(suffix), archiveId: 'assessment_' + suffix.replace(/-/g, '_'),
        attributes: { fileMD5: hash, version: '1.0.0', game: [G], ...extra } });
      // These are deliberate Redux test records, NOT native installations or payload proof.
      // Exact version avoids fuzzy-version semantics suppressing the bare MD5 marker.
      const rule = (hash, extra = {}) => ({ type: 'requires',
        reference: { fileMD5: hash, versionMatch: '1.0.0' }, ...extra });
      const records = [record('old-vanilla', md5('vanilla')), record('candidate-vanilla', md5('vanilla')),
        record('candidate-conflict', md5('different')), record('old-choices', md5('choices'), { installerChoices: choices('old') }),
        record('candidate-choices', md5('choices'), { installerChoices: choices('new') }),
        record('old-ignored', md5('ignored')), record('candidate-ignored', md5('ignored')),
        { id: collectionId, state: 'installed', type: 'collection', installationPath: collectionId,
          attributes: { collectionId: 900001, collectionSlug: 'private-fixture-metadata',
            revisionId: 900002, revisionNumber: 1, downloadGame: G },
          rules: [rule(md5('vanilla')), rule(md5('choices'), { installerChoices: choices('old') }), rule(md5('ignored'), { ignored: true })] }];
      for (const value of records) {
        must(!api.getState().persistent.mods[G][value.id] && !fs.existsSync(contained(path.join(input.stage, value.id))), 'ASSESSMENT_SETUP_COLLISION');
        api.store.dispatch(actions.addMod(G, value));
      }
      const second = { id: secondProfileId, gameId: G, name: 'PRIVATE Metadata Assessment Fixture',
        modState: { [id('old-vanilla')]: { enabled: true }, [id('candidate-vanilla')]: { enabled: false } },
        lastActivated: 0, features: {}, pendingRemove: false };
      must(!api.getState().persistent.profiles[secondProfileId], 'ASSESSMENT_PROFILE_COLLISION');
      let lateSetupDispatches = 0;
      async function settleProfileSetup(profile, enabling, phase) {
        // Reviewed official v2.9.1: profile_management/index.ts (4b4cddc0)
        // emits mod-enabled for ANY profile. InstallManager (6f847f3f) tracks
        // dependencies+recommendations via util/activity.ts (250cf30f).
        // file_based_loadorder/index.ts (8f3044cc) ends its profile refresh by
        // SET_FB_LOAD_ORDER({profileId,loadOrder}), action blob b8f88de1.
        // Join these exact setup effects; never sleep for a generic quiet period.
        const dispatch = api.store.dispatch;
        let starts = 0, stops = 0, loadOrderCompleted = false, released = false, complete;
        const settled = new Promise(resolve => { complete = resolve; });
        const required = enabling ? 2 : 0;
        function observeDispatch(...args) {
          if (released) {
            lateSetupDispatches++;
            // withActivityTracking may retain this function. Forward to the current
            // read-window observer so late callbacks cannot evade its zero count.
            return api.store.dispatch.apply(api.store, args);
          }
          const action = args[0], result = dispatch.apply(this, args);
          if (action?.payload?.group === 'installing_dependencies'
            && action.payload.activityId === id('old-vanilla')) {
            if (action.type === 'START_ACTIVITY') starts++;
            if (action.type === 'STOP_ACTIVITY') stops++;
          }
          if (action?.type === 'SET_FB_LOAD_ORDER' && action.payload?.profileId === P
            && Array.isArray(action.payload.loadOrder) && action.payload.loadOrder.length === 0) loadOrderCompleted = true;
          // Independent observers may finish in either order: join all their
          // exact completions, without assuming activity precedes load order.
          if (loadOrderCompleted && starts === required && stops === required
            && (api.getState().session.base.activity?.installing_dependencies ?? []).length === 0
            && Array.isArray(api.getState().persistent.loadOrder?.[P])
            && api.getState().persistent.loadOrder[P].length === 0) complete();
          return result;
        }
        api.store.dispatch = observeDispatch;
        try {
          api.store.dispatch(actions.setProfile(profile));
          await bounded(settled, 'ASSESSMENT_SETUP_PROFILE_REFRESH_UNOBSERVED', 15000);
          must(lateSetupDispatches === 0, 'ASSESSMENT_LATE_SETUP_DISPATCH');
          note(phase, { profileId: secondProfileId, activeProfileId: P, starts, stops,
            loadOrderCompletionObserved: true, emptyLoadOrderObserved: true, loadOrderHash: digest([]),
            sourceBlobs: { profiles: '4b4cddc08c29f5fa2d78b0e7f59ebea8dc3380c1',
              installManager: '6f847f3f878a0f8a8082b827d8b2bc4ebbcbe221', activity: '250cf30f897938ed1705cfec654b3b6b4f79d598',
              loadOrder: '8f3044cc73c8d97629da3f4f304382eb7fe71149', loadOrderAction: 'b8f88de149399ed01d346ae8e6b4788438078f30' } });
        } finally { api.store.dispatch = dispatch; released = true; }
      }
      await settleProfileSetup(second, true, 'candidate-assessment-setup-profile-settled');
      const stateProjection = () => {
        const state = api.getState();
        return { mods: state.persistent.mods, profiles: state.persistent.profiles,
          downloads: state.persistent.downloads, settings: state.settings,
          activeGameId: selectors.activeGameId(state), activeProfileId: selectors.activeProfileId(state) };
      };
      // Log field paths only. Unrecognized/dynamic keys are masked; no values,
      // account identifiers, settings contents or action payloads are persisted.
      const diagnosticFields = new Set(['mods', 'profiles', 'downloads', 'settings', 'activeGameId', 'activeProfileId',
        'gameMode', 'discovered', 'tools', 'toolsRunning', 'interface', 'automation', 'collections', 'nexus', 'window',
        'deployment', 'needToDeploy', 'modState', 'enabled', 'enabledTime', 'disabledTime', 'pendingRemove',
        'lastActivated', 'features', 'id', 'gameId', 'state', 'type', 'archiveId', 'installationPath', 'attributes',
        'rules', 'reference', 'version', 'fileMD5', 'fileList', 'installerChoices', 'patches', 'modSize', 'source',
        'referenceTag', 'referenceTags', 'installPath', 'downloadPath', 'stagingPath', 'path', 'autoDeployment',
        'autoInstall', 'autoEnable', 'autoStart', 'files', 'modInfo', 'localPath', 'downloadGame', G, P,
        secondProfileId, modId, existingBaseline.modId, ...records.map(value => value.id)]);
      function changedPaths(before, after) {
        const paths = []; let visited = 0, truncated = false;
        function walk(a, b, prefix = '', depth = 0) {
          if (isDeepStrictEqual(a, b)) return;
          if (paths.length >= 32 || ++visited > 50000) { truncated = true; return; }
          if (depth >= 12 || !a || !b || typeof a !== 'object' || typeof b !== 'object'
            || Array.isArray(a) !== Array.isArray(b)) { paths.push(prefix || '<root>'); return; }
          for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
            const label = Array.isArray(a) ? '[]' : diagnosticFields.has(key) ? key : '<field>';
            walk(a[key], b[key], prefix ? prefix + '.' + label : label, depth + 1);
            if (truncated) break;
          }
        }
        walk(before, after); return { paths, truncated };
      }
      const preserved = { nativeMod: structuredClone(api.getState().persistent.mods[G][modId]),
        existingMod: structuredClone(api.getState().persistent.mods[G][existingBaseline.modId]),
        targetProfile: structuredClone(api.getState().persistent.profiles[P]),
        original: diskProof(target), staging: diskProof(staged), existingStaging: diskProof(existingBaseline.staged.path) };
      note('candidate-assessment-fixture-setup', { metadataRecordsOnly: true, payloadVerified: false,
        collectionModId: collectionId, secondProfileId, records, secondProfile: second, preserved,
        fixtureWorkerSha256: input.fixtureWorkerSha256, candidateAssessmentSourceSha256: input.candidateAssessmentSourceSha256 });
      async function assessmentCase(name, oldSuffix, candidateSuffix, expected) {
        boundary();
        must(lateSetupDispatches === 0, 'ASSESSMENT_LATE_SETUP_DISPATCH');
        const args = { gameId: G, profileId: P, collectionModId: collectionId, expectedRevisionId: 900002,
          comparisons: [{ oldModId: id(oldSuffix), candidateModId: id(candidateSuffix) }] };
        const beforeState = structuredClone(stateProjection()), before = digest(beforeState), dispatch = api.store.dispatch;
        const actionTypes = []; let actionTypesTruncated = false;
        let dispatches = 0, nativeEffects = 0, result;
        const effects = ['import-downloads', 'start-install', 'start-install-download', 'remove-mod', 'remove-mods', 'deploy-mods'];
        const countEffect = () => { nativeEffects++; };
        let wrapped = false;
        try {
          api.store.dispatch = function(...args) {
            dispatches++;
            const type = args[0]?.type;
            if (actionTypes.length < 32) actionTypes.push(typeof type === 'string'
              && /^[A-Z][A-Z0-9_ :()./-]{0,159}$/.test(type) ? type : 'UNRECOGNIZED_ACTION_TYPE');
            else actionTypesTruncated = true;
            return dispatch.apply(this, args);
          }; wrapped = true;
          for (const name of effects) api.events.on(name, countEffect);
          result = await rpc(token, 'assess_installed_candidates', args);
        } finally {
          if (wrapped) api.store.dispatch = dispatch;
          for (const name of effects) api.events.removeListener(name, countEffect);
        }
        const afterState = structuredClone(stateProjection()), after = digest(afterState);
        if (before !== after || dispatches !== 0 || nativeEffects !== 0 || lateSetupDispatches !== 0) {
          const changed = changedPaths(beforeState, afterState);
          note('candidate-assessment-state-mismatch', { case: name, dispatches, nativeEffects,
            actionTypes, actionTypesTruncated, lateSetupDispatches, changedPaths: changed.paths, changedPathsTruncated: changed.truncated,
            before, after, originalRecordsUnchanged: isDeepStrictEqual(beforeState.mods[G][modId], afterState.mods[G][modId])
              && isDeepStrictEqual(beforeState.mods[G][existingBaseline.modId], afterState.mods[G][existingBaseline.modId]),
            originalProfileUnchanged: isDeepStrictEqual(beforeState.profiles[P], afterState.profiles[P]) });
        }
        must(before === after && dispatches === 0 && nativeEffects === 0 && lateSetupDispatches === 0, 'ASSESSMENT_RPC_CHANGED_STATE');
        must(result.schema === 'installed-candidate-assessment/1' && result.gameId === G && result.profileId === P
          && result.collection?.modId === collectionId && result.collection.revisionId === 900002
          && result.metadataOnly === true && result.effectsAllowed === false && result.migrationReady === false
          && result.diskDeploymentVerified === false && result.comparisons?.length === 1, 'ASSESSMENT_RESPONSE_INVALID');
        const row = result.comparisons[0];
        must(row.oldModId === args.comparisons[0].oldModId && row.candidateModId === args.comparisons[0].candidateModId
          && expected.includes(row.status) && /^[a-f0-9]{64}$/.test(row.selectedRule?.ruleIdHash || '')
          && /^[a-f0-9]{64}$/.test(row.selectedRule?.fingerprint || '') && /^[a-f0-9]{64}$/.test(row.fingerprint || ''),
        'ASSESSMENT_OUTCOME_MISMATCH');
        must(!JSON.stringify(result).includes('"ruleId":'), 'ASSESSMENT_RAW_RULE_ID_EXPOSED');
        note('candidate-assessment-' + name, { args, result, before, after, dispatches, nativeEffects });
        return row;
      }
      const vanilla = await assessmentCase('vanilla', 'old-vanilla', 'candidate-vanilla', ['compatible_installed_variant']);
      must(vanilla.reasons.length === 0 && vanilla.profiles.old.some(p => p.id === secondProfileId && p.enabled === true)
        && vanilla.archiveReferences.old.some(r => r.gameId === G && r.modId === id('old-vanilla'))
        && vanilla.archiveReferences.candidate.some(r => r.gameId === G && r.modId === id('candidate-vanilla')), 'ASSESSMENT_CLOSURE_UNPROVEN');
      const exact = await assessmentCase('exact-conflict', 'old-vanilla', 'candidate-conflict', ['conflict']);
      must(exact.reasons.includes('CANDIDATE_IDENTITY_CONFLICT'), 'ASSESSMENT_EXACT_CONFLICT_UNPROVEN');
      const customized = await assessmentCase('choices', 'old-choices', 'candidate-choices', ['conflict', 'insufficient_evidence']);
      must(customized.reasons.includes('CUSTOMIZATIONS_REVIEW_REQUIRED')
        && customized.incomingRequires.some(r => r.oldInstallSpecMatches === true && r.installSpecMatches === false), 'ASSESSMENT_CHOICES_MISMATCH_UNPROVEN');
      const ignored = await assessmentCase('ignored', 'old-ignored', 'candidate-ignored', ['insufficient_evidence']);
      must(ignored.reasons.includes('IGNORED_REQUIREMENT_REVIEW_REQUIRED'), 'ASSESSMENT_IGNORED_REVIEW_UNPROVEN');
      await settleProfileSetup({ ...second, pendingRemove: true }, false, 'candidate-assessment-pending-profile-settled');
      const pending = await assessmentCase('pending-profile', 'old-vanilla', 'candidate-vanilla', ['insufficient_evidence']);
      must(pending.reasons.includes('PROFILE_PENDING_REMOVE')
        && pending.profiles.old.some(p => p.id === secondProfileId && p.pendingRemove === true), 'ASSESSMENT_PENDING_PROFILE_UNPROVEN');
      const state = api.getState();
      must(isDeepStrictEqual(state.persistent.mods[G][modId], preserved.nativeMod)
        && isDeepStrictEqual(state.persistent.mods[G][existingBaseline.modId], preserved.existingMod)
        && isDeepStrictEqual(state.persistent.profiles[P], preserved.targetProfile)
        && isDeepStrictEqual(diskProof(target), preserved.original) && isDeepStrictEqual(diskProof(staged), preserved.staging)
        && isDeepStrictEqual(diskProof(existingBaseline.staged.path), preserved.existingStaging)
        && !fs.existsSync(target + '.vortex_backup'), 'ASSESSMENT_ORIGINAL_PROOF_CHANGED');
      note('candidate-assessment-fixture-finished', { metadataRecordsOnly: true, noAdditionalDeployment: true,
        records: records.map(value => structuredClone(state.persistent.mods[G][value.id])),
        secondProfile: structuredClone(state.persistent.profiles[secondProfileId]), preserved });
    }
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
