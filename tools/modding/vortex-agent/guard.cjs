'use strict';
const fs = require('node:fs/promises');
const disk = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { safe } = require('./serialization.cjs');
const downloads = require('./download-identity.cjs');
const receipts = require('./receipts.cjs');
const { installLocalArchive } = require('./local-archive-install.cjs');
const { createInstallDiagnostics, validInstallDiagnostics } = require('./install-diagnostics.cjs');
const liveInstallDiagnostics = new Map();
const diagnosticKey = (dir, requestId) => path.resolve(dir) + '\0' + requestId;
const RECEIPTS = require('./paths.cjs').receipts;
const PROTOCOL = 'vortex-agent/1';
const processes = Object.freeze({
  cyberpunk2077: ['Cyberpunk2077.exe', 'REDprelauncher.exe'],
  assassinscreedunity: ['ACU.exe'],
  skyrimse: ['SkyrimSE.exe', 'skse64_loader.exe'],
  skyrimvr: ['SkyrimVR.exe', 'sksevr_loader.exe'],
  fallout4: ['Fallout4.exe', 'f4se_loader.exe'],
});
function insist(ok, code) { if (!ok) throw new Error(code); }
function effectiveEnabled(state, profileId, modId) { return state.persistent?.profiles?.[profileId]?.modState?.[modId]?.enabled === true; }
const PROCESS_SNAPSHOT_SCRIPT = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
  [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
  # Absolute built-in module path avoids inherited PowerShell 7 PSModulePath.
  Import-Module ($PSHOME + '\\Modules\\Microsoft.PowerShell.Utility\\Microsoft.PowerShell.Utility.psd1') -ErrorAction Stop
  $items = [System.Diagnostics.Process]::GetProcesses()
  try {
    [string[]] $names = @(foreach ($item in $items) { $item.ProcessName + '.exe' })
  } finally { foreach ($item in $items) { $item.Dispose() } }
  @{schema=1; complete=$true; count=$names.Length; names=$names} | Microsoft.PowerShell.Utility\\ConvertTo-Json -Compress -Depth 3
  exit 0
} catch {
  [Console]::Error.WriteLine('PROCESS_ENUMERATION_FAILED')
  exit 1
}`;
function processNames() {
  try {
    const windows = process.env.SystemRoot;
    insist(typeof windows === 'string' && /^[a-z]:\\[^<>:"|?*\x00-\x1f]+$/i.test(windows)
      && path.win32.normalize(windows) === windows, 'PROCESS_LIST_UNVERIFIABLE');
    const exe = path.win32.join(windows, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const result = spawnSync(exe, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(PROCESS_SNAPSHOT_SCRIPT, 'utf16le').toString('base64')],
      { encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    insist(!result.error && result.status === 0 && !result.signal && typeof result.stdout === 'string'
      && typeof result.stderr === 'string' && result.stderr.trim() === '', 'PROCESS_LIST_UNVERIFIABLE');
    const snapshot = JSON.parse(result.stdout);
    insist(snapshot && !Array.isArray(snapshot) && Object.keys(snapshot).sort().join(',') === 'complete,count,names,schema'
      && snapshot.schema === 1 && snapshot.complete === true && Array.isArray(snapshot.names)
      && Number.isInteger(snapshot.count) && snapshot.count > 0 && snapshot.count <= 65536
      && snapshot.names.length === snapshot.count
      && snapshot.names.every(name => typeof name === 'string' && name.length > 0 && name.length <= 260
        && !/[\\/\x00-\x1f\x7f]/.test(name)), 'PROCESS_LIST_UNVERIFIABLE');
    return snapshot.names.map(name => name.toLowerCase());
  } catch { throw new Error('PROCESS_LIST_UNVERIFIABLE'); }
}
function noRunningTools(state, gameId) {
  insist(process.platform === 'win32', 'WINDOWS_PROCESS_CHECK_REQUIRED');
  insist(processes[gameId], 'UNSUPPORTED_GAME_PROCESS_GUARD');
  insist(Object.keys(state.session?.base?.toolsRunning || {}).length === 0, 'GAME_OR_TOOL_RUNNING');
}
function stopped(state, gameId) {
  noRunningTools(state, gameId);
  const names = processNames();
  insist(!processes[gameId].some(name => names.includes(name.toLowerCase())), 'GAME_RUNNING');
}
function context(api, selectors) {
  const state = api.getState();
  const profileId = selectors.activeProfileId(state);
  const gameId = selectors.activeGameId(state);
  const result = { gameId, profileId, gamePath: state.settings?.gameMode?.discovered?.[gameId]?.path,
    stagingPath: gameId ? selectors.installPathForGame(state, gameId) : undefined,
    downloadPath: gameId ? selectors.downloadPathForGame(state, gameId) : undefined };
  result.filesystemIds = {};
  for (const key of ['gamePath', 'stagingPath', 'downloadPath']) {
    if (result[key] !== undefined) {
      insist(path.isAbsolute(result[key]), 'ABSOLUTE_PATH_REQUIRED');
      result[key] = disk.realpathSync(result[key]);
      result.filesystemIds[key] = identity(result[key]);
    }
  }
  return result;
}
function identity(file) { const stat = disk.statSync(file, { bigint: true }); insist(stat.isDirectory(), 'PATH_NOT_DIRECTORY'); return `${stat.dev}:${stat.ino}`; }
function normalized(p) { return path.resolve(p).toLowerCase(); }
function assertContext(api, selectors, args, stop = stopped) {
  const live = context(api, selectors);
  insist(live.gameId === args.gameId && live.profileId === args.profileId
    && api.getState().persistent?.profiles?.[args.profileId]?.gameId === args.gameId, 'STALE_ACTIVE_CONTEXT');
  for (const key of ['gamePath', 'stagingPath', 'downloadPath']) {
    insist(typeof live[key] === 'string' && typeof args[key] === 'string' && path.isAbsolute(args[key])
      && normalized(live[key]) === normalized(args[key])
      && normalized(disk.realpathSync(args[key])) === normalized(args[key]), 'PATH_PIN_MISMATCH');
    insist(args.filesystemIds?.[key] === live.filesystemIds[key], 'FILESYSTEM_IDENTITY_MISMATCH');
  }
  stop(api.getState(), args.gameId);
  return live;
}
async function digest(handle) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of handle.createReadStream({ autoClose: false, start: 0 })) hash.update(chunk);
  return hash.digest('hex');
}
function fileStamp(stat) { return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`; }
async function archive(api, args, id, selectors = {}, catalog) {
  const projection = () => {
    const state = api.getState(), record = state.persistent?.downloads?.files?.[id];
    const resolved = downloads.resolveDownload(record, state, selectors, catalog);
    return { state: record?.state, localPath: record?.localPath, ...resolved };
  };
  const pinned = projection();
  insist(pinned.state === 'finished' && !pinned.ambiguous && pinned.gameId === args.gameId, 'DOWNLOAD_NOT_SINGLE_GAME');
  insist(typeof pinned.localPath === 'string', 'DOWNLOAD_PATH_MISSING');
  const recordPin = JSON.stringify(pinned);
  const verifyRecord = () => insist(JSON.stringify(projection()) === recordPin, 'DOWNLOAD_RECORD_CHANGED');
  const file = path.resolve(args.downloadPath, pinned.localPath);
  const real = await fs.realpath(file), root = await fs.realpath(args.downloadPath);
  insist(path.dirname(normalized(real)) === normalized(root)
    && normalized(file) === normalized(real), 'DOWNLOAD_PATH_ESCAPE');
  verifyRecord();
  const handle = await fs.open(real, 'r');
  try {
    const before = await handle.stat({ bigint: true });
    insist(before.isFile() && before.size === BigInt(args.size), 'PACKAGE_PIN_MISMATCH');
    const stamp = fileStamp(before);
    // Pin the descriptor, not a name reopened after stat. Mutation of the tracked
    // record or of the path/file while hashing invalidates this proof.
    const sha256 = await digest(handle);
    verifyRecord();
    insist(fileStamp(await handle.stat({ bigint: true })) === stamp, 'DOWNLOAD_ARCHIVE_CHANGED');
    const verify = () => {
      verifyRecord();
      try {
        insist(normalized(disk.realpathSync(file)) === normalized(real)
          && normalized(disk.realpathSync(args.downloadPath)) === normalized(root)
          && !disk.lstatSync(file).isSymbolicLink()
          && fileStamp(disk.statSync(file, { bigint: true })) === stamp, 'DOWNLOAD_ARCHIVE_CHANGED');
      } catch { throw Error('DOWNLOAD_ARCHIVE_CHANGED'); }
    };
    verify();
    insist(sha256 === args.sha256, 'PACKAGE_PIN_MISMATCH');
    return verify;
  } finally { await handle.close(); }
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function durable(file, value) {
  const handle = await fs.open(file, 'wx');
  try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); }
  finally { await handle.close(); }
}
async function commitCompletion(file, value, verify, published = () => {}) {
  // A final name is never visible before the bytes are fsynced. link() is an
  // atomic no-overwrite publication (rename() could overwrite an old request).
  const pending = file + '.pending-' + crypto.randomUUID();
  await durable(pending, value);
  // Revalidate an asynchronous archive proof after receipt fsync, immediately
  // before publishing its final name. Other operations retain their old route.
  if (verify) verify();
  await fs.link(pending, file);
  published();
  await fs.unlink(pending);
}
function modIdentity(state, gameId, id) {
  const mod = state.persistent?.mods?.[gameId]?.[id];
  insist(mod?.state === 'installed', 'MOD_NOT_INSTALLED');
  return JSON.stringify([mod.id ?? id, mod.state, mod.installationPath ?? null, mod.archiveId ?? null, mod.type ?? null,
    mod.attributes?.modId ?? null, mod.attributes?.fileId ?? null, mod.attributes?.version ?? null, mod.attributes?.installTime ?? null]);
}
// Atomic filesystem exclusion spans renderer processes and all bridge clients. Never
// steal a stale lock: a missing callback may still represent an in-flight mutation.
async function exclusive(dir, fn) {
  await fs.mkdir(dir, { recursive: true });
  const lock = path.join(dir, 'mutation.lock');
  let handle;
  const deadline = Date.now() + 30000;
  while (!handle) {
    try { handle = await fs.open(lock, 'wx'); }
    catch (error) { if (error.code !== 'EEXIST') throw error; insist(Date.now() < deadline, 'MUTATION_BUSY_INSPECT_RECEIPTS'); await sleep(50); }
  }
  try { await handle.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString() })); return await fn(); }
  finally { await handle.close(); await fs.unlink(lock); }
}
function createOperations(api, actions, selectors, options = {}) {
  const dir = options.receipts || RECEIPTS;
  const sanitize = (value, kind) => safe(value, api, kind, options.credentials || []);
  const check = args => assertContext(api, selectors, args, options.stopped || stopped);
  const catalog = options.catalog;
  // The facade captures this request's guard; its controller/observations are
  // retained per native API + receipts path inside native-dialog-operations.
  let nativeDialogs;
  const dialogs = () => nativeDialogs ||= require('./native-dialog-operations.cjs').createNativeDialogOperations(api, selectors, {
    receipts: dir, checkContext: check, commitCompletion,
    ordinaryMutation: (args, run) => mutate('respond_native_dialog', args, run), ...(options.nativeDialogOptions || {}),
  });
  const flags = args => Object.fromEntries(Object.entries(api.getState().persistent?.profiles?.[args.profileId]?.modState || {})
    .map(([id, item]) => [id, item.enabled === true]));
  const unchangedFlags = (args, before, allowed = []) => {
    const after = flags(args);
    insist([...new Set([...Object.keys(before), ...Object.keys(after)])].every(id => allowed.includes(id)
      || (before[id] === true) === (after[id] === true)), 'OTHER_ENABLED_FLAGS_CHANGED');
  };
  async function mutate(name, args, run) {
    return exclusive(dir, async () => {
      try { await fs.access(path.join(dir, 'unresolved.json')); throw new Error('UNRESOLVED_OPERATION_INTERLOCK'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      const diagnostics = name === 'install_local_archive' ? createInstallDiagnostics(options.installDiagnosticsOptions) : null;
      const measuredCheck = () => diagnostics ? diagnostics.measureSync('context_checks', () => check(args)) : check(args);
      // Read-only preparation keeps live context/tools/path checks. Process absence
      // is never cached: dispatch, late native permission and completion rescan.
      const measuredContextCheck = () => diagnostics.measureSync('context_checks',
        () => assertContext(api, selectors, args, noRunningTools));
      measuredCheck();
      insist(/^[a-zA-Z0-9_-]{8,80}$/.test(args.requestId || ''), 'INVALID_REQUEST_ID');
      const attempt = path.join(dir, args.requestId + '.attempt.json');
      const receipt = sanitize({ protocol: PROTOCOL, receiptVersion: receipts.VERSION, operation: name,
        requestId: args.requestId, gameId: args.gameId, profileId: args.profileId,
        parameters: args, at: new Date().toISOString() }, 'receipt');
      insist(receipts.validAttempt(receipt), 'INVALID_ATTEMPT_RECEIPT');
      await durable(attempt, receipt);
      const key = diagnosticKey(dir, args.requestId);
      if (diagnostics) liveInstallDiagnostics.set(key, {attemptAt: receipt.at, diagnostics});
      let effects = false, armed = false, completionPublished = false, diagnosticFinished = false;
      const effect = async (fn, eligible = () => {}) => {
        diagnostics?.assertWork();
        // One operation can have several native stages (import, then install).
        // Retain the original interlock across all stages; never overwrite it.
        if (!armed) { await durable(path.join(dir, 'unresolved.json'), receipt); armed = true; }
        // Synchronous realpath/identity + active context + Windows process checks,
        // immediately followed by invocation: no further awaits before the effect.
        measuredCheck(); eligible(); diagnostics?.markEffects(); effects = true;
        return fn();
      };
      try {
        diagnostics?.assertWork();
        let verifyCompletion;
        const result = await run(effect, verify => { verifyCompletion = verify; }, diagnostics, measuredCheck, measuredContextCheck);
        if (diagnostics) measuredContextCheck(); else measuredCheck();
        if (verifyCompletion) verifyCompletion();
        const status = { protocol: PROTOCOL, requestId: args.requestId, operation: name,
          operationCompleted: true, diskDeploymentVerified: false,
          verificationRequired: receipts.VERIFICATION, ...result };
        const publicStatus = sanitize(status, 'operation_status');
        const completion = sanitize({ ...status, receiptVersion: receipts.VERSION, gameId: args.gameId, profileId: args.profileId, at: new Date().toISOString() }, 'receipt');
        insist(receipts.validCompletion(completion, receipt), 'INVALID_COMPLETION_RECEIPT');
        diagnostics?.finalizing();
        const commit = async () => {
          await commitCompletion(path.join(dir, args.requestId + '.completion.json'), completion,
            verifyCompletion || diagnostics ? () => { measuredCheck(); verifyCompletion?.(); } : undefined,
            () => { completionPublished = true; });
          if (armed) await fs.unlink(path.join(dir, 'unresolved.json'));
        };
        if (diagnostics) await diagnostics.measure('receipt_commit', commit); else await commit();
        const snapshot = diagnostics?.finish('completed', 'none', true);
        diagnosticFinished = true;
        if (snapshot && validInstallDiagnostics(snapshot)) {
          try { return sanitize({...publicStatus, installDiagnostics: snapshot}, 'operation_status'); }
          catch { /* Optional observations cannot undo a committed operation. */ }
        }
        return publicStatus;
      } catch (error) {
        // Publication is irreversible. A cleanup error after link() must not
        // manufacture a conflicting failure next to a valid completion.
        if (completionPublished) {
          const cleanup = new Error('COMPLETION_PUBLISHED_CLEANUP_PENDING');
          if (diagnostics) cleanup.installDiagnostics = diagnostics.finish('held', 'receipt_cleanup', true);
          diagnosticFinished = true;
          throw cleanup;
        }
        // Deliberately exclude upstream exception text (may contain authenticated URLs).
        const fail = () => durable(path.join(dir, args.requestId + '.failed.json'), sanitize({
          protocol: PROTOCOL, receiptVersion: receipts.VERSION, requestId: args.requestId, operation: name, gameId: args.gameId, profileId: args.profileId,
          operationCompleted: false, effectsMayHaveOccurred: effects, inspectBeforeRetry: effects,
          errorCode: /^[A-Z][A-Z0-9_]+$/.test(error?.message || '') ? error.message : 'UPSTREAM_FAILURE',
          at: new Date().toISOString(),
        }, 'receipt'));
        if (diagnostics) await diagnostics.measure('receipt_commit', fail); else await fail();
        if (armed && !effects) await fs.unlink(path.join(dir, 'unresolved.json'));
        if (diagnostics) {
          const code = /^[A-Z][A-Z0-9_]+$/.test(error?.message || '') ? error.message : 'UPSTREAM_FAILURE';
          const outward = new Error(code);
          outward.code = code;
          outward.installDiagnostics = diagnostics.finish(effects ? 'held' : 'failed_before_effect', 'operation_error');
          diagnosticFinished = true;
          throw outward;
        }
        diagnosticFinished = true;
        throw error;
      } finally {
        if (diagnostics) {
          try {
            const snapshot = diagnosticFinished ? diagnostics.snapshot()
              : diagnostics.finish(effects ? 'held' : 'failed_before_effect', 'operation_error', completionPublished);
            // Observations are optional and never authorize completion or retry.
            // One bounded final record avoids filesystem writes on every poll.
            const record = sanitize({schema:'install-diagnostic-record/1',operation:name,
              requestId:args.requestId,attemptAt:receipt.at,diagnostics:snapshot}, 'install_diagnostics');
            if (validInstallDiagnostics(record.diagnostics)) await durable(path.join(dir,args.requestId+'.diagnostics.json'),record);
          } catch { /* Receipt authority is independent of optional diagnostics. */ }
          finally { liveInstallDiagnostics.delete(key); }
        }
      }
    });
  }
  return {
    read_native_dialog: args => dialogs().read_native_dialog(args),
    respond_native_dialog: args => dialogs().respond_native_dialog(args),
    read_native_dialog_operation: args => dialogs().read_native_dialog_operation(args),
    health: () => ({ protocol: PROTOCOL, extensionVersion: '1.1.0', targetVortexVersion: '2.7.2.0', ...context(api, selectors),
      security: 'per-user-DPAPI-bearer', installSupported: false, diskDeploymentVerified: false }),
    advance_collection_wizard: args => {
      const wizard = options.wizard;
      insist(wizard && ['prepare', 'validate', 'click', 'waitForTransition', 'verifyTransition'].every(key => typeof wizard[key] === 'function'),
        'COLLECTION_WIZARD_CONTROLLER_UNAVAILABLE');
      return mutate('advance_collection_wizard', args, async (effect, beforeCompletion) => {
      const sync = (fn, code) => {
        const value = fn();
        if (value && typeof value.then === 'function') {
          void Promise.resolve(value).catch(() => {});
          throw Error(code);
        }
        insist(value !== false, code);
        return value;
      };
      await wizard.prepare(args);
      check(args);
      await effect(() => sync(() => wizard.click(args), 'COLLECTION_WIZARD_CLICK_MUST_BE_SYNCHRONOUS'),
        () => sync(() => wizard.validate(args), 'COLLECTION_WIZARD_VALIDATION_MUST_BE_SYNCHRONOUS'));
      const result = await wizard.waitForTransition(args);
      beforeCompletion(() => sync(() => wizard.verifyTransition(args, result), 'COLLECTION_WIZARD_TRANSITION_MUST_BE_SYNCHRONOUS'));
      return result;
      }).then(result => { wizard.committed?.(args); return result; });
    },
    advance_collection_update_prompt: args => {
      const prompt = options.updatePrompt;
      insist(prompt && ['prepare','validate','click','waitForTransition','verifyTransition'].every(key=>typeof prompt[key] === 'function'),
        'COLLECTION_UPDATE_PROMPT_CONTROLLER_UNAVAILABLE');
      return mutate('advance_collection_update_prompt',args,async(effect,beforeCompletion)=>{
        const sync=(fn,code)=>{const value=fn();if(value&&typeof value.then==='function'){void Promise.resolve(value).catch(()=>{});throw Error(code);}insist(value!==false,code);return value;};
        await prompt.prepare(args);check(args);
        await effect(()=>sync(()=>prompt.click(args),'COLLECTION_UPDATE_PROMPT_CLICK_MUST_BE_SYNCHRONOUS'),
          ()=>sync(()=>prompt.validate(args),'COLLECTION_UPDATE_PROMPT_VALIDATION_MUST_BE_SYNCHRONOUS'));
        const result=await prompt.waitForTransition(args);
        beforeCompletion(()=>sync(()=>prompt.verifyTransition(args,result),'COLLECTION_UPDATE_PROMPT_TRANSITION_MUST_BE_SYNCHRONOUS'));
        return result;
      }).then(result=>{prompt.committed?.(args);return result;});
    },
    respond_collection_dialog: args => {
      const dialog = options.dialog;
      insist(dialog && ['prepare', 'validate', 'respond', 'waitForTransition', 'verifyTransition'].every(key => typeof dialog[key] === 'function'),
        'COLLECTION_DIALOG_CONTROLLER_UNAVAILABLE');
      return mutate('respond_collection_dialog', args, async (effect, beforeCompletion) => {
        const sync = (fn, code) => {
          const value = fn();
          if (value && typeof value.then === 'function') { void Promise.resolve(value).catch(() => {}); throw Error(code); }
          insist(value !== false, code); return value;
        };
        await dialog.prepare(args); check(args);
        await effect(() => sync(() => dialog.respond(args), 'COLLECTION_DIALOG_RESPONSE_MUST_BE_SYNCHRONOUS'),
          () => sync(() => dialog.validate(args), 'COLLECTION_DIALOG_VALIDATION_MUST_BE_SYNCHRONOUS'));
        const result = await dialog.waitForTransition(args);
        beforeCompletion(() => sync(() => dialog.verifyTransition(args, result), 'COLLECTION_DIALOG_TRANSITION_MUST_BE_SYNCHRONOUS'));
        return {gameId:args.gameId,...result};
      });
    },
    install_download: args => mutate('install_download', args, async () => {
      await archive(api, args, args.downloadId, selectors, catalog); check(args);
      // v2.7.2 InstallManager can silently replace by newestFileId/Nexus identity,
      // archive-derived ID, remembered choice, or one-profile auto-replace. There
      // is no verified nonreplacement install contract. Refuse ALL native installs
      // (including an empty inventory) instead of claiming preflight guarantees.
      insist(false, 'INSTALL_DISABLED_NONREPLACEMENT_NOT_PROVABLE');
    }),
    install_local_archive: args => mutate('install_local_archive', args, async (effect, _beforeCompletion, diagnostics, measuredCheck, measuredContextCheck) =>
      installLocalArchive(api, args, { check: measuredCheck, checkContext: measuredContextCheck, effect, admitHost: options.admitLocalInstallHost, diagnostics })),
    set_mods_enabled: args => mutate('set_mods_enabled', args, async effect => {
      const before = flags(args);
      const identities = args.modIds.map(id => modIdentity(api.getState(), args.gameId, id));
      const eligible = () => insist(args.modIds.every((id, index) => modIdentity(api.getState(), args.gameId, id) === identities[index]), 'MOD_RECORD_CHANGED');
      const changed = args.modIds.filter(id => effectiveEnabled(api.getState(), args.profileId, id) !== args.enabled);
      if (changed.length) await effect(() => actions.setModsEnabled(api, args.profileId, changed, args.enabled,
        { allowAutoDeploy: false, reason: 'user_manual', installed: true }), eligible);
      check(args);
      eligible();
      insist(args.modIds.every(id => effectiveEnabled(api.getState(), args.profileId, id) === args.enabled), 'ENABLED_FLAGS_UNVERIFIED');
      unchangedFlags(args, before, args.modIds);
      return { modIds: args.modIds, enabled: args.enabled, enabledFlagsVerified: true };
    }),
    deploy_mods: args => mutate('deploy_mods', args, async effect => {
      const before = flags(args);
      insist(typeof api.ext.awaitModsDeployment === 'function', 'DEPLOY_API_UNAVAILABLE');
      await effect(() => api.ext.awaitModsDeployment(args.profileId));
      check(args);
      unchangedFlags(args, before);
      return { deploymentPromiseResolved: true };
    }),
    download_nexus: args => mutate('download_nexus', args, async (effect, beforeCompletion) => {
      const before = flags(args);
      const installedBefore = JSON.stringify(Object.entries(api.getState().persistent?.mods?.[args.gameId] || {})
        .map(([id, mod]) => [id, mod.state, mod.archiveId]).sort());
      const matchesNow = () => { const state = api.getState(); return downloads.matchingDownloads(state.persistent?.downloads?.files || {}, args, state, selectors, catalog); };
      const matches = matchesNow();
      let id = matches[0]?.[0];
      const reused = !!id;
      if (!id) {
        insist(args.reuseOnly !== true, 'REUSE_ONLY_DOWNLOAD_NOT_FOUND');
        insist(typeof api.ext.nexusDownload === 'function', 'NEXUS_API_UNAVAILABLE');
        id = await effect(() => api.ext.nexusDownload(args.gameId, args.nexusModId, args.nexusFileId, undefined, false),
          () => insist(matchesNow().length === 0, 'DOWNLOAD_PREFLIGHT_CHANGED'));
        check(args);
      }
      insist(typeof id === 'string' && id.length > 0, 'DOWNLOAD_ID_MISSING');
      const initializedBy = Date.now() + (options.initializationGraceMs ?? 5000);
      let observed = false;
      // No timeout releases the mutation lock while a download is still in progress.
      while (true) {
        check(args);
        const item = api.getState().persistent?.downloads?.files?.[id];
        if (!item) {
          insist(!observed && Date.now() < initializedBy, 'DOWNLOAD_RECORD_MISSING');
          await sleep(options.pollIntervalMs ?? 500); continue;
        }
        observed = true;
        insist(downloads.ACTIVE.has(item.state) || downloads.TERMINAL.has(item.state), 'DOWNLOAD_STATE_UNRECOGNIZED');
        insist(!downloads.TERMINAL.has(item.state) || item.state === 'finished', 'DOWNLOAD_REQUIRES_USER_ATTENTION');
        if (item?.state === 'finished') break;
        await sleep(options.pollIntervalMs ?? 500);
      }
      const verifyArchive = await archive(api, args, id, selectors, catalog); check(args);
      verifyArchive();
      beforeCompletion(verifyArchive);
      insist(matchesNow()[0]?.[0] === id, 'NEXUS_IDS_MISMATCH');
      unchangedFlags(args, before);
      insist(installedBefore === JSON.stringify(Object.entries(api.getState().persistent?.mods?.[args.gameId] || {})
        .map(([id, mod]) => [id, mod.state, mod.archiveId]).sort()), 'DOWNLOAD_INSTALLED_RECORDS_CHANGED');
      return { downloadId: id, reused, archiveSha256Verified: true, size: args.size, autoInstall: false,
        archiveCRCVerified: false };
    }),
    reconcile_operation: async args => {
      insist(/^[a-zA-Z0-9_-]{8,80}$/.test(args.requestId || ''), 'INVALID_REQUEST_ID');
      const issues = [];
      const read = async (name, readIssues = issues, limit = 1024 * 1024) => {
        let handle;
        try { handle = await fs.open(path.join(dir, name), 'r'); const bytes = Buffer.alloc(limit + 1); const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
          insist(bytesRead <= limit, 'RECEIPT_LIMIT'); return { observed: true, value: JSON.parse(bytes.subarray(0, bytesRead).toString('utf8')) }; }
        catch (error) { if (error.code === 'ENOENT') return { observed: false, value: null }; readIssues.push('INVALID_RECEIPT'); return { observed: true, value: null }; }
        finally { if (handle) await handle.close(); }
      };
      const a = await read(args.requestId + '.attempt.json'), c = await read(args.requestId + '.completion.json'), f = await read(args.requestId + '.failed.json'), u = await read('unresolved.json');
      const attempt = receipts.validAttempt(a.value) && a.value.requestId === args.requestId ? a.value : null;
      const completion = receipts.validCompletion(c.value, attempt) ? c.value : null;
      const failure = attempt && receipts.validFailure(f.value, attempt) ? f.value : null;
      const interlock = receipts.validAttempt(u.value) ? u.value : null;
      if (a.observed && !attempt || c.observed && !completion || f.observed && !failure || u.observed && !interlock) issues.push('RECEIPT_SCHEMA_OR_IDENTITY_INVALID');
      if (c.observed && f.observed) issues.push('CONFLICTING_TERMINAL_RECEIPTS');
      let incomplete = false, entries = 0;
      try { for await (const entry of await fs.opendir(dir)) { insist(++entries <= 10000, 'RECEIPT_DIRECTORY_LIMIT');
        if (entry.name.startsWith(args.requestId + '.completion.json.pending-')) incomplete = true; } }
      catch (error) { if (error.code !== 'ENOENT') issues.push('RECEIPT_DIRECTORY_UNVERIFIABLE'); }
      if (incomplete) issues.push('INCOMPLETE_COMPLETION_COMMIT');
      const state = api.getState();
      const enabledFlags = attempt?.operation === 'set_mods_enabled' ? (attempt.parameters.modIds || []).map(modId => ({
        modId, installed: state.persistent?.mods?.[attempt.gameId]?.[modId]?.state === 'installed',
        enabled: effectiveEnabled(state, attempt.profileId, modId),
        requested: attempt.parameters.enabled,
        requestedFlagObserved: effectiveEnabled(state, attempt.profileId, modId) === attempt.parameters.enabled,
      })) : [];
      const deployment = attempt?.operation === 'deploy_mods' ? {
        needToDeploy: state.persistent?.deployment?.needToDeploy?.[attempt.gameId] ?? null,
        diskDeploymentVerified: false,
      } : null;
      let download = [];
      let localInstall = null;
      let installDiagnostics = null, installDiagnosticsSource = 'unavailable';
      const diagnosticsIssues = [];
      if (attempt?.operation === 'install_local_archive') {
        const live = liveInstallDiagnostics.get(diagnosticKey(dir, args.requestId));
        if (live && live.attemptAt === attempt.at) {
          installDiagnostics = live.diagnostics.snapshot(); installDiagnosticsSource = 'live';
        } else {
          const observed = await read(args.requestId+'.diagnostics.json', diagnosticsIssues, 32768);
          const record = observed.value;
          if (record && Object.keys(record).sort().join(',') === 'attemptAt,diagnostics,operation,requestId,schema'
            && record.schema === 'install-diagnostic-record/1' && record.operation === attempt.operation
            && record.requestId === attempt.requestId && record.attemptAt === attempt.at && validInstallDiagnostics(record.diagnostics)) {
            installDiagnostics = record.diagnostics; installDiagnosticsSource = 'retained';
          } else if (observed.observed) diagnosticsIssues.push('INVALID_INSTALL_DIAGNOSTICS');
        }
        const modId = path.basename(attempt.parameters.archivePath, '.zip');
        const mod = state.persistent?.mods?.[attempt.gameId]?.[modId];
        localInstall = { modId, installed: mod?.state === 'installed',
          enabled: effectiveEnabled(state, attempt.profileId, modId),
          downloadId: typeof mod?.archiveId === 'string' ? mod.archiveId : null, replayAllowed: false };
        download = Object.entries(state.persistent?.downloads?.files || {})
          .filter(([, d]) => d.localPath === path.basename(attempt.parameters.archivePath))
          .map(([id, d]) => ({ id, state: d.state, terminalObserved: downloads.TERMINAL.has(d.state) }));
      }
      if (attempt?.operation === 'download_nexus') {
        try { download = downloads.matchingDownloads(state.persistent?.downloads?.files || {}, attempt.parameters, state, selectors, catalog)
          .map(([id, d]) => ({ id, state: d.state, terminalObserved: downloads.TERMINAL.has(d.state) })); }
        catch { issues.push('DOWNLOAD_IDENTITY_UNVERIFIABLE'); }
      }
      return { protocol: PROTOCOL, attempt, completion, failure, interlock, download, enabledFlags, deployment,
        ...(localInstall ? {localInstall,installDiagnostics,installDiagnosticsSource,
          diagnosticsIssues: diagnosticsIssues.length ? ['INVALID_INSTALL_DIAGNOSTICS'] : []} : {}),
        receiptIssues: [...new Set(issues)], incompleteCompletionObserved: incomplete,
        adapterTerminalReceiptObserved: c.observed || f.observed,
        terminalOperationVerified: !!completion && issues.length === 0 && !f.observed, interlockCleared: false,
        instruction: 'Read-only reconciliation. An unresolved effect is never auto-cleared; primary must reconcile Vortex UI/log and disk evidence, stop Vortex, then explicitly archive the exact interlock with its receipts.' };
    },
  };
}
module.exports = { PROTOCOL, RECEIPTS, safe, processNames, stopped, context, assertContext, exclusive, createOperations, insist, normalized, identity, durable, commitCompletion, effectiveEnabled };
