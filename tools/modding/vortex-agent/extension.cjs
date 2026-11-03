'use strict';
const http = require('node:http');
const { McpServer } = require('@modelcontextprotocol/server');
const { NodeStreamableHTTPServerTransport, localhostHostValidation, localhostOriginValidation } = require('@modelcontextprotocol/node');
const { z } = require('zod');
const { actions, selectors, util, log } = require('@nexusmods/vortex-api');
const control = require('./vortexControl');
const { createOperations, safe } = require('./guard.cjs');
const { getCollectionWizardController } = require('./collection-wizard-controller.cjs');
const { dialogs, conflicts, externalChanges, listDownloads, collectionHealth, unresolvedConflicts } = require('./inspection.cjs');
const { readModLifecycle } = require('./lifecycle-inspection.cjs');
const { assessInstalledCandidates, LIMITS: ASSESSMENT_LIMITS } = require('./installed-candidate-assessment.cjs');
const { readNativePreflight } = require('./native-preflight.cjs');
const { catalogFromDisk } = require('./download-identity.cjs');
const ingress = require('./http-ingress.cjs');
const { VERIFICATION } = require('./receipts.cjs');
const credential = require('./credential.cjs');
const { publicErrorCode } = require('./serialization.cjs');
const { localInstallAdmission } = require('./local-install-binding.cjs');
const { validInstallDiagnostics, PHASES, STATES, REASONS, WAITS, METRICS } = require('./install-diagnostics.cjs');
function register(server, api, options = {}) {
  const wizard = getCollectionWizardController(api, { selectors, util });
  const credentials = options.credentials || [];
  const catalog = catalogFromDisk(util);
  const admitLocalInstallHost = localInstallAdmission(api, util, options.localInstallHostBinding);
  const operations = createOperations(api, actions, selectors, { credentials, catalog, wizard,
    admitLocalInstallHost: admitLocalInstallHost });
  const id = z.string().min(1).max(200);
  const read = { gameId: id.optional(), limit: z.number().int().min(1).max(500).default(100) };
  const write = { gameId: id, profileId: id, requestId: z.string().regex(/^[a-zA-Z0-9_-]{8,80}$/),
    gamePath: id, stagingPath: id, downloadPath: id,
    filesystemIds: z.strictObject({ gamePath: id, stagingPath: id, downloadPath: id }) };
  const pins = { size: z.number().int().positive(), sha256: z.string().regex(/^[a-f0-9]{64}$/) };
  const milliseconds = z.number().int().nonnegative();
  const diagnosticsSchema = z.strictObject({ schema:z.literal('install-diagnostics/1'),
    phase:z.enum(PHASES),state:z.enum(STATES),reason:z.enum(REASONS),waitReason:z.enum(WAITS),
    elapsedMs:milliseconds,budgetMs:milliseconds,remainingMs:milliseconds,
    effectsMayHaveOccurred:z.boolean(),nativeMayContinue:z.boolean(),
    phaseTimes:z.record(z.enum(PHASES),milliseconds),
    metrics:z.record(z.enum(METRICS),z.strictObject({calls:milliseconds,totalMs:milliseconds})) });
  const status = z.strictObject({ protocol: z.literal('vortex-agent/1'), requestId: id,
    operation: z.enum(['install_download', 'install_local_archive', 'set_mods_enabled', 'deploy_mods', 'download_nexus', 'advance_collection_wizard']),
    operationCompleted: z.literal(true), diskDeploymentVerified: z.literal(false), verificationRequired: z.literal(VERIFICATION),
    modId: id.optional(), installedRecordVerified: z.boolean().optional(), enabled: z.boolean().optional(),
    modIds: z.array(id).optional(), enabledFlagsVerified: z.boolean().optional(), deploymentPromiseResolved: z.boolean().optional(),
    downloadId: id.optional(), reused: z.boolean().optional(), archiveSha256Verified: z.boolean().optional(),
    size: z.number().int().positive().optional(), autoInstall: z.literal(false).optional(), archiveCRCVerified: z.literal(false).optional(),
    payloadFilesVerified: z.number().int().positive().optional(),
    archiveId: id.optional(), collectionId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    revisionId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    revisionNumber: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    action: z.enum(['install_now', 'done']).optional(), transition: z.enum(['started', 'finished']).optional(),
    nativeTransitionVerified: z.literal(true).optional(),
    installDiagnostics: diagnosticsSchema.optional(),
  });
  const add = (name, fields, fn, writes = false, description) => server.registerTool(name, {
    description: description ?? (writes ? 'Guarded active-context mutation; unique requestId and live path pins required. Result is NOT disk deployment proof.' : 'Curated read-only Vortex inspection.'),
    inputSchema: z.strictObject(fields), annotations: { readOnlyHint: !writes, destructiveHint: writes },
    ...(writes ? { outputSchema: status } : {}),
  }, async args => {
    const release = ingress.acquire('tool');
    if (!release) return { isError: true, content: [{ type: 'text', text: '{"error":"TOOL_CONCURRENCY_LIMIT"}' }] };
    try {
      const result = safe(await fn(args), api, name, credentials);
      return { content: [{ type: 'text', text: JSON.stringify(result) }], ...(writes ? { structuredContent: result } : {}) };
    }
    catch (error) { return { isError: true, content: [{ type: 'text', text: JSON.stringify({
      error: publicErrorCode(error, api, credentials), action: 'Re-read health/context, inspect external receipts and Vortex UI/log privately. Never blindly retry a mutation.',
      ...(name === 'install_local_archive' && validInstallDiagnostics(error?.installDiagnostics)
        ? {installDiagnostics:safe(error.installDiagnostics,api,'install_diagnostics',credentials)} : {}),
    }) }] }; }
    finally { release(); }
  });
  add('health', {}, operations.health);
  add('read_local_install_readiness', {}, async () => {
    const proof = await admitLocalInstallHost();
    return { localArchiveInstallSupported: true, sourceAdmissionVerified: true, hostVersion: '2.9.1',
      reviewedDynamicExtensions: proof.dynamicExtensions, nativeEffects: false,
      scope: 'New own-local noninteractive Cyberpunk ZIP only; no replacement, Nexus updates or automatic deploy.' };
  }, false, 'Check the actual official Vortex package and loaded extension source pins for install_local_archive, without installation or account changes. Unknown source/version refuses. This does not validate a package or authorize a write.');
  add('read_native_preflight', {}, () => readNativePreflight(api, selectors, util,
    options.nativePreflightWindow === undefined ? {} : {getWindow: options.nativePreflightWindow}), false,
    'Read native deployment targets, app version, updater status and fixed staging-tag metadata. A missing tag requires native initialization; a present tag does not prove readiness. No installation, source admission, shutdown permission or native effects.');
  add('reconcile_operation', { requestId: z.string().regex(/^[a-zA-Z0-9_-]{8,80}$/) }, operations.reconcile_operation);
  add('list_profiles', { gameId: id.optional() }, a => control.listProfiles(api, a.gameId));
  add('list_mods', { ...read, enabledOnly: z.boolean().optional(), nameFilter: id.optional() }, a => {
    const gameId = a.gameId ?? selectors.activeGameId(api.getState());
    return control.listMods(api, gameId, a).map(mod => ({ ...mod, installationState: typeof api.getState().persistent?.mods?.[gameId]?.[mod.id]?.state === 'string'
      ? api.getState().persistent.mods[gameId][mod.id].state : 'unknown', installed: api.getState().persistent?.mods?.[gameId]?.[mod.id]?.state === 'installed' }));
  });
  add('list_downloads', { ...read, states: z.array(id).max(10).default(['finished', 'started', 'paused', 'failed', 'init', 'finalizing']) }, a => listDownloads(api, selectors, a, catalog));
  add('list_mod_rules', { gameId: id.optional(), modId: id }, a => control.listModRules(api, a.modId, a.gameId));
  add('find_mod_dependents', { gameId: id.optional(), modId: id }, a => control.findModDependents(api, a.modId, a.gameId));
  add('read_mod_lifecycle', { gameId: id.optional(), modIds: z.array(id).min(1).max(20) },
    a => readModLifecycle(api, selectors, util, a), false,
    'Before preparing installation, update or removal helpers, inspect 1–20 exact installed mod IDs in one bounded state read: usage in every game profile including pending removal, native requires matches including collection file references, and archive references across games. No filesystem scan or mutation. Missing native matcher or exceeded limits fails closed. Metadata only; never authorizes installation/removal or proves deployed bytes.');
  add('assess_installed_candidates', {gameId:id,profileId:id,collectionModId:id,
    expectedRevisionId:z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    comparisons:z.array(z.strictObject({oldModId:id,candidateModId:id,
      ruleId:z.string().min(1).max(4096).regex(/^[^\x00-\x1f\x7f]+$/).optional()})).min(1).max(ASSESSMENT_LIMITS.comparisons)},
    a => assessInstalledCandidates(api,selectors,util,a), false,
    'Assess up to 20 exact installed old/candidate pairs against an installed collection and incoming requires rules using native identity AND recorded installation-spec matching. Reports conflicts, uncertainty, all-profile usage and opaque fingerprints. No raw rules, filesystem scan, download or mutation. A compatible recorded variant is NOT migration readiness, payload/deployment proof or permission to switch/replace/remove; effectsAllowed and migrationReady remain false.');
  add('list_file_conflicts', { ...read, nameFilter: id.optional() }, a => conflicts(api, selectors, a));
  add('list_known_mod_conflicts', { gameId: id.optional() }, a => control.listKnownModConflicts(api, a.gameId));
  add('list_unsolved_conflicts', {}, () => unresolvedConflicts(api, selectors, util));
  add('read_collection_health', {}, () => collectionHealth(api, selectors));
  add('read_collection_wizard', {}, () => wizard.readiness(), false,
    'Read source-admitted collection wizard readiness and exact collection identity. No action, installation or deployment proof.');
  add('advance_collection_wizard', { ...write, modId: id, archiveId: id,
    collectionId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    revisionId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    revisionNumber: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    action: z.enum(['install_now', 'done']) }, operations.advance_collection_wizard, true,
    'Advance one exact source-admitted collection wizard through Install Now or Done. Requires active context, filesystem pins and a unique requestId. Native transition only; not installation or disk deployment proof. Reconcile uncertain effects before retry.');
  add('list_dialogs', {}, () => dialogs(api));
  add('list_external_changes', {}, () => externalChanges(api));
  add('install_download', { ...write, ...pins, downloadId: id }, operations.install_download, true);
  add('install_local_archive', { ...write, ...pins, archivePath: z.string().min(1).max(4096) }, operations.install_local_archive, true,
    'Install one NEW own-local noninteractive Cyberpunk ZIP, disabled and without deploy. Requires reviewed official-host/loaded-extension source admission, exact archive size/SHA256 and active context pins. Refuses metadata matches, existing names/downloads and replacements. Supports ordinary files under archive/pc/mod, r6/scripts, r6/tweaks, red4ext/plugins and CET mods. Unknown outcome blocks later writes; reconcile original request, never retry with a new ID. Not a Nexus update or FOMOD installer.');
  add('set_mods_enabled', { ...write, modIds: z.array(id).min(1).max(100), enabled: z.boolean() }, operations.set_mods_enabled, true);
  add('deploy_mods', write, operations.deploy_mods, true);
  add('download_nexus', { ...write, ...pins, nexusModId: z.number().int().positive(), nexusFileId: z.number().int().positive(), reuseOnly: z.boolean().default(false) }, operations.download_nexus, true);
}
function start(api, port = 3701, options = {}) {
  // Observe the wizard epoch before accepting requests, not at first tool use.
  getCollectionWizardController(api, { selectors, util });
  const host = localhostHostValidation(), origin = localhostOriginValidation();
  const listener = http.createServer(async (req, res) => {
    if (req.url !== '/mcp') return res.writeHead(404).end();
    if (!host(req, res) || !origin(req, res)) return;
    // Shell/stdio clients never have an Origin. Reject browser-origin requests,
    // including localhost pages, rather than exposing writes to web applications.
    if (req.headers.origin) return res.writeHead(403).end();
    const release = ingress.acquire('request');
    if (!release) return res.writeHead(503, { Connection: 'close' }).end();
    const abort = new AbortController(); let server, timer;
    const closed = () => { abort.abort(); release(); };
    res.once('close', closed);
    timer = setTimeout(() => { abort.abort(); if (!res.headersSent) res.writeHead(408, { Connection: 'close' }).end(); else res.destroy(); }, options.bodyTimeoutMs ?? ingress.LIMITS.bodyTimeoutMs);
    try {
      let token;
      token = await ingress.abortable((options.tokenProvider || credential.readToken)(), abort.signal);
      if (!credential.authorized(req.headers.authorization, token)) return await ingress.rejectRequest(req, res, 401, abort.signal);
      if (abort.signal.aborted) return;
      if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return await ingress.rejectRequest(req, res, 405, abort.signal); }
      if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') return await ingress.rejectRequest(req, res, 415, abort.signal);
      if (Number(req.headers['content-length']) > ingress.LIMITS.bytes) return await ingress.rejectRequest(req, res, 413, abort.signal);
      const parsed = await ingress.body(req, abort.signal);
      clearTimeout(timer); // This bounds ingress, not the lifetime of Vortex work.
      if (abort.signal.aborted) return;
      server = new McpServer({ name: 'vortex-agent', version: '1.1.0' });
      register(server, api, { credentials: [token], nativePreflightWindow: options.nativePreflightWindow,
        localInstallHostBinding: options.localInstallHostBinding });
      const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.once('close', () => { void server.close().catch(() => {}); });
      await server.connect(transport); await transport.handleRequest(req, res, parsed);
    } catch (error) {
      if (!res.headersSent && !res.destroyed) await ingress.rejectRequest(req, res, error.status || (server ? 500 : 401), abort.signal);
      else if (!res.destroyed) res.end();
    } finally { clearTimeout(timer); release(); res.off('close', closed); }
  });
  listener.on('error', () => log('error', '[vortex-agent] bind failed; verify port 3701 ownership, do not assume an existing server is this extension'));
  listener.listen(port, '127.0.0.1');
  return listener;
}
module.exports = { register, start };
