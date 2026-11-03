import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { createRequire, isBuiltin } from 'node:module';
import { fileURLToPath } from 'node:url';
import { scopeFromHeld, prepareTracked, verifyTracked, prepareTrackedCapture, verifyTrackedCapture,
  adaptTrackedCapture, main as preparationCLI } from './prepare-tracked-nexus.mjs';
const require = createRequire(import.meta.url);
const { createScopePolicy } = require('./tracked-nexus-policy.cjs');
const { wait, flagsReady } = require('./tracked-nexus-settlement.cjs');
const { verify: preferences } = require('./tracked-preferences.cjs');
const sha = raw => crypto.createHash('sha256').update(raw).digest('hex');
const here = path.dirname(fileURLToPath(import.meta.url));
const scratch = path.resolve(here, '../../../local-state');
function held() {
  return { activationApproved: false, activationHold: true, allActivationHold: true,
    freshActualBaselineBound: false, noEffects: true, materializationPermitted: false,
    ownStableCPIncluded: false, health: null, pluginPath: null, baselineFile: null,
    baselineSHA256: null, rootApproval: null, reviewedPackages: [1, 2, 3, 4].map(n => ({
      nexusModId: n, nexusFileId: 100 + n, sourceVersion: '1.0', officialBytes: 90 + n,
      officialSHA256: String(n).repeat(64), requiredDownloadId: null, nativeTargetId: null,
      nativePreviousId: null, expectedEnabled: null, payloadProjection: null })) };
}
function bound() {
  const plan = held(), pins = scopeFromHeld(plan);
  const rows = plan.reviewedPackages.map((p, n) => ({ key: `${p.nexusModId}-${p.nexusFileId}`,
    nexusModId: p.nexusModId, nexusFileId: p.nexusFileId, bytes: p.officialBytes,
    sha256: p.officialSHA256, version: p.sourceVersion, acceptedVersions: [p.sourceVersion],
    requiredDownloadId: `download_${n}`, expectedModId: `Native ${n} (1.0)`, expectedType: '',
    md5: 'a'.repeat(32), payload: { [`r6/file${n}.reds`]: 'b'.repeat(64) }, crcVerified: true,
    expectedPreviousCaptured: true, expectedPreviousModId: `Previous ${n}`,
    expectedEnabled: true, oldEnabledModIds: [`Previous ${n}`], nativeSelectorInputs: {},
    expectedNativeRulesDigest: 'c'.repeat(64), expectedNativeOverridesDigest: 'd'.repeat(64),
    sameIdCollisionChecked: true, expectedTargetAbsent: true, previousStagePreservationReviewed: true,
    activePatchedOwnerProtectionReviewed: true, nativeSelectionEvidenceSHA256: 'e'.repeat(64),
    actualInstallationProjectionSHA256: 'f'.repeat(64) }));
  return { pins, rows, policy: createScopePolicy(pins) };
}
test('four exact originals are admitted only with explicit native transfer and payload pins', () => {
  const f = bound(); assert.equal(f.policy.completeScope(f.rows), true);
  f.pins[1].sha256 = '0'.repeat(64); // The caller cannot retarget the policy.
  assert.equal(f.policy.completeScope(f.rows), true);
});
test('missing, extra, duplicate and changed scope/version/download/target plans fail', () => {
  const f = bound();
  for (const rows of [f.rows.slice(1), [...f.rows, f.rows[0]], [f.rows[0], f.rows[0], ...f.rows.slice(2)]])
    assert.throws(() => f.policy.completeScope(rows));
  for (const [key, value] of Object.entries({ nexusFileId: 999, bytes: 1, sha256: '0'.repeat(64), version: '2.0', key: '../escape' })) {
    const rows = structuredClone(f.rows); rows[0][key] = value;
    assert.throws(() => f.policy.completeScope(rows), /EXACT_TRACKED_NEXUS_SCOPE/);
  }
  for (const key of ['requiredDownloadId', 'expectedModId']) {
    const rows = structuredClone(f.rows); rows[1][key] = rows[0][key];
    assert.throws(() => f.policy.completeScope(rows), /DUPLICATE_TRACKED_NEXUS/);
  }
});
test('replacement gaps, unsafe payloads and unreviewed flag transfers fail before effects', () => {
  const f = bound();
  for (const patch of [{ expectedTargetAbsent: false }, { expectedPreviousCaptured: false },
    { expectedType: null }, { oldEnabledModIds: [] }, { oldEnabledModIds: ['someone else'] },
    { payload: { '../escape': 'a'.repeat(64) } }, { payload: {} }, { requiredDownloadId: null }]) {
    const rows = structuredClone(f.rows); Object.assign(rows[0], patch);
    assert.throws(() => f.policy.completeScope(rows));
  }
  const rows = structuredClone(f.rows);
  rows[1].expectedPreviousModId = rows[0].expectedModId;
  rows[1].oldEnabledModIds = [rows[0].expectedModId];
  assert.throws(() => f.policy.completeScope(rows), /BATCH_TRANSFER_TARGET_COLLISION/);
});
test('held plan cannot carry stale live bindings or approve effects', () => {
  for (const patch of [{ activationApproved: true }, { health: {} }, { freshActualBaselineBound: true },
    { ownStableCPIncluded: true }, { materializationPermitted: true }])
    assert.throws(() => scopeFromHeld({ ...held(), ...patch }));
  const plan = held(); plan.reviewedPackages[0].requiredDownloadId = 'old';
  assert.throws(() => scopeFromHeld(plan));
});
test('published own original is a separate one-item Nexus batch with own-source evidence', () => {
  const plan = held(); plan.reviewedPackages = [plan.reviewedPackages[0]];
  plan.reviewedPackages[0].nexusModId = 35196;
  assert.throws(() => scopeFromHeld(plan), /SEPARATE_PUBLISHED_OWN_BATCH/);
  Object.assign(plan, { ownStableCPIncluded: true, ownSourceCommit: 'a'.repeat(40), ownSourceProofSHA256: 'b'.repeat(64) });
  assert.equal(Object.keys(scopeFromHeld(plan)).length, 1);
  plan.reviewedPackages.push(held().reviewedPackages[1]);
  assert.throws(() => scopeFromHeld(plan), /SEPARATE_PUBLISHED_OWN_BATCH/);
});
test('per-item settlement preserves four exact native identities and rechecks transferred flags', async () => {
  const { rows } = bound(); let completed = 0;
  for (const pkg of rows) {
    let at = 0;
    const opts = { pkg, expectedSize: pkg.bytes, expectedDownloadId: pkg.requiredDownloadId,
      expectedType: '', guard: () => {}, record: () => {}, now: () => at,
      sleep: async ms => { at += ms; }, read: () => ({ record: { id: pkg.expectedModId,
        installationPath: pkg.expectedModId, archiveId: pkg.requiredDownloadId,
        type: '', state: 'installed', attributes: { modSize: pkg.bytes, churn: at } },
        flags: { [pkg.expectedModId]: { enabled: true }, [pkg.expectedPreviousModId]: { enabled: false } } }) };
    const result = await wait(opts); assert.equal(result.ready, true); completed++;
    opts.expectedDownloadId = 'wrong';
    await assert.rejects(wait(opts), { code: 'INSTALL_SETTLEMENT_IDENTITY_CHANGED' });
  }
  assert.equal(completed, 4);
  const pkg = rows[0]; assert.equal(flagsReady({ [pkg.expectedModId]: { enabled: true },
    [pkg.expectedPreviousModId]: { enabled: false } }, pkg), true);
  assert.equal(flagsReady({ [pkg.expectedModId]: { enabled: true } }, pkg), false);
});
test('fresh preferences are preserved without forcing historical two/two values', () => {
  const expected = { section: 'Movement', AirDashCount: '3', AirJumpCount: '1' };
  const input = '[Movement]\nAirDashCount=3\nAirJumpCount=1\n';
  assert.deepEqual(preferences(input, expected), { ...expected, changed: false });
  assert.throws(() => preferences(input.replace('Count=3', 'Count=2'), expected), /VALUES_CHANGED/);
  assert.throws(() => preferences(input + 'AirDashCount=3\n', expected), /DUPLICATE/);
  assert.throws(() => preferences(input, { section: 'Movement' }), /VALUES_REQUIRED/);
});

function inert(dir) {
  const config = JSON.parse(fs.readFileSync(path.join(dir, 'reviewed.prepared.json')));
  const modules = new Map(); let touched = 0;
  const denied = new Proxy({}, { get() { touched++; throw Error('HELD_EFFECT_ACCESS'); } });
  const deniedFS = new Proxy({}, { get() { return () => { touched++; throw Error('HELD_FS_CALL'); }; } });
  function load(file) {
    if (modules.has(file)) return modules.get(file).exports;
    const mod = { exports: {} }; modules.set(file, mod);
    const loader = id => {
      if (['original-fs', 'fs', 'node:fs'].includes(id)) return deniedFS;
      if (id === '@nexusmods/vortex-api') return { actions: {}, selectors: {}, util: {} };
      if (id === './reviewed.json') return config;
      if (id.startsWith('./')) {
        const target = path.join(path.dirname(file), id);
        return id.endsWith('.json') ? JSON.parse(fs.readFileSync(target)) : load(target);
      }
      assert(isBuiltin(id)); return require(id);
    };
    vm.runInNewContext(fs.readFileSync(file, 'utf8'), { require: loader, module: mod, exports: mod.exports,
      __dirname: path.dirname(file), __filename: file, structuredClone, Map, Set, process: denied,
      setTimeout() { throw Error('HELD_TIMER_ACCESS'); } }, { timeout: 1000 });
    return mod.exports;
  }
  assert.equal(load(path.join(dir, 'index.prepared.js'))(denied), true);
  assert.equal(touched, 0);
}

test('real pinned multi-template prepares inertly with all policy data and exact mapping gates',
  { skip: !process.env.VORTEX_TRACKED_REFERENCE }, async t => {
    const root = fs.mkdtempSync(path.join(scratch, 'tracked-kit-test-'));
    const external = fs.mkdtempSync(path.join(os.tmpdir(), 'tracked-plan-'));
    t.after(() => { assert(root.startsWith(scratch + path.sep)); fs.rmSync(root, { recursive: true }); fs.rmSync(external, { recursive: true }); });
    const planFile = path.join(external, 'plan.json'), bytes = Buffer.from(JSON.stringify(held())); fs.writeFileSync(planFile, bytes);
    const args = { reference: process.env.VORTEX_TRACKED_REFERENCE, planFile, planSha256: sha(bytes), output: path.join(root, 'held') };
    assert.equal(prepareTracked(args).status, 'plan'); assert(!fs.existsSync(args.output));
    assert.equal(prepareTracked({ ...args, apply: true }).packages, 4);
    const checked = verifyTracked(args.output); assert.equal(checked.runtime, 20); assert(checked.missingBindings.length > 0);
    assert(!fs.existsSync(path.join(args.output, 'deferred-policy.cjs')));
    inert(args.output);
    const largeConfigFile = path.join(args.output, 'reviewed.prepared.json');
    const largeConfig = JSON.parse(fs.readFileSync(largeConfigFile));
    largeConfig.expectedProtectedStageFiles = Array.from({ length: 3600 }, (_, n) => ({
      path: `Provider ${n}/r6/${'x'.repeat(220)}.reds`, sha256: 'a'.repeat(64) }));
    const largeBytes = Buffer.from(JSON.stringify(largeConfig));
    assert(largeBytes.length > 1024 * 1024);
    fs.writeFileSync(largeConfigFile, largeBytes);
    assert.equal(verifyTracked(args.output).status, checked.status);
    fs.appendFileSync(largeConfigFile, ' '.repeat(8 * 1024 * 1024 - largeBytes.length));
    assert.doesNotThrow(() => verifyTracked(args.output));
    fs.appendFileSync(largeConfigFile, ' ');
    assert.throws(() => verifyTracked(args.output), /ORDINARY_BOUNDED_KIT_INPUT_REQUIRED/);
    fs.writeFileSync(largeConfigFile, largeBytes);
    const entryFile = path.join(args.output, 'index.prepared.js'), entryBytes = fs.readFileSync(entryFile);
    fs.writeFileSync(entryFile, Buffer.alloc(1024 * 1024 + 1, ' '));
    assert.throws(() => verifyTracked(args.output), /ORDINARY_BOUNDED_KIT_INPUT_REQUIRED/);
    fs.writeFileSync(entryFile, entryBytes);
    assert.throws(() => prepareTracked({ ...args, apply: true }), /TRACKED_OUTPUT_EXISTS/);
    assert.throws(() => prepareTracked({ ...args, output: path.join(root, 'bad-plan'), planSha256: '0'.repeat(64), apply: true }), /PLAN_PIN_MISMATCH/);
    assert.throws(() => prepareTracked({ ...args, output: path.resolve('C:/Task/Vortex/plugins/inactive') }), /ACTIVE_TRACKED_KIT_PATH_REFUSED/);
    if (process.env.VORTEX_TRACKED_CAPTURE_REFERENCE) {
      const output = path.join(root, 'capture');
      const captureArgs = { reference: process.env.VORTEX_TRACKED_CAPTURE_REFERENCE, installKit: args.output, output };
      assert.equal(prepareTrackedCapture(captureArgs).status, 'plan'); assert(!fs.existsSync(output));
      prepareTrackedCapture({ ...captureArgs, apply: true });
      const captureChecked = verifyTrackedCapture(output); assert.equal(captureChecked.packages, 4);
      assert(captureChecked.missingBindings.length > 0); inert(output);
      const captureConfigFile = path.join(output, 'reviewed.prepared.json');
      const captureConfig = JSON.parse(fs.readFileSync(captureConfigFile));
      captureConfig.expectedProtectedStageFiles = largeConfig.expectedProtectedStageFiles;
      const captureBytes = Buffer.from(JSON.stringify(captureConfig));
      assert(captureBytes.length > 1024 * 1024);
      fs.writeFileSync(captureConfigFile, captureBytes);
      assert.doesNotThrow(() => verifyTrackedCapture(output));
      fs.appendFileSync(captureConfigFile, ' '.repeat(8 * 1024 * 1024 - captureBytes.length));
      assert.doesNotThrow(() => verifyTrackedCapture(output));
      fs.appendFileSync(captureConfigFile, ' ');
      assert.throws(() => verifyTrackedCapture(output), /ORDINARY_BOUNDED_KIT_INPUT_REQUIRED/);
      fs.writeFileSync(captureConfigFile, captureBytes);
      assert.throws(() => verifyTrackedCapture(output, { materialization: true }));
      const code = fs.readFileSync(path.join(output, 'capture.cjs'), 'utf8');
      assert(!code.includes('D:/Modding/Nexus')); // Startup timestamp policy is local and source-pinned.
      const captureContract = JSON.parse(fs.readFileSync(path.join(output, 'TRACKED-CAPTURE-KIT.json')));
      for (const name of ['index.prepared.js', ...captureContract.runtime.filter(n => n.endsWith('.cjs'))]) {
        const body = fs.readFileSync(path.join(output, name), 'utf8');
        for (const match of body.matchAll(/require\(['"](\.\/[^'"]+)['"]\)/g))
          assert(match[1] === './reviewed.json' || captureContract.runtime.includes(match[1].slice(2)), `${name}: ${match[1]}`);
      }
    }
    const kit = JSON.parse(fs.readFileSync(path.join(args.output, 'TRACKED-NEXUS-KIT.json')));
    const simulate = require(path.join(args.output, 'simulate-all.cjs')).simulateAll;
    const rows = bound().rows, observed = [];
    const aggregate = await simulate({ packages: rows, guard: async () => {},
      observe: async p => { observed.push(p.key); return { payload: p.payload }; }, record: () => {} });
    assert.equal(aggregate.allObserved, true); assert.deepEqual(aggregate.mappingDifferences, []); assert.equal(observed.length, 4);
    observed.length = 0;
    await assert.rejects(simulate({ packages: rows, guard: async () => {}, observe: async p => {
      observed.push(p.key); if (observed.length === 3) throw Error('LATER_OBSERVATION_FAILED'); return { payload: p.payload };
    }, record: () => {} }), /LATER_OBSERVATION_FAILED/);
    assert.equal(observed.length, 3);
    const badAggregate = await simulate({ packages: rows, guard: async () => {},
      observe: async () => ({ payload: { unexpected: 'a'.repeat(64) } }), record: () => {} });
    assert.equal(badAggregate.mappingDifferences.length, 4);
    for (const name of ['index.prepared.js', ...kit.runtime.filter(n => n.endsWith('.cjs'))]) {
      const text = fs.readFileSync(path.join(args.output, name), 'utf8');
      for (const match of text.matchAll(/require\(['"](\.\/[^'"]+)['"]\)/g))
        assert(match[1] === './reviewed.json' || kit.runtime.includes(match[1].slice(2)), `${name}: ${match[1]}`);
    }
    assert.throws(() => verifyTracked(args.output, { materialization: true }));
    const cfgFile = path.join(args.output, 'reviewed.prepared.json');
    const cfg = JSON.parse(fs.readFileSync(cfgFile)); cfg.reviewedPackages = bound().rows;
    for (const key of checked.missingBindings) cfg[key] = {};
    const baseline = path.join(root, 'baseline.json'); fs.writeFileSync(baseline, '{}');
    Object.assign(cfg, { pluginPath: path.join(root, 'inactive-plugin'), baselineFile: baseline, baselineSHA256: sha('{}'),
      processGuard: path.join(here, 'guard.cjs'), processGuardSHA256: sha(fs.readFileSync(path.join(here, 'guard.cjs'))),
      freshActualBaselineBound: true, freshRootDiskBaselineFinalized: true, health: { gameId: 'cyberpunk2077', profileId: 'model',
        gamePath: root, stagingPath: root, downloadPath: root, filesystemIds: { gamePath: '1:2', stagingPath: '1:3', downloadPath: '1:4' } } });
    fs.writeFileSync(cfgFile, JSON.stringify(cfg));
    const info = path.join(args.output, 'info.json'); fs.writeFileSync(info, '{}');
    const map = JSON.parse(fs.readFileSync(path.join(args.output, 'COPY-MAP.prepared.json')));
    map.find(r => r.source === 'info.json').sha256 = sha('{}');
    const reviewedBytes = fs.readFileSync(cfgFile);
    fs.writeFileSync(path.join(args.output, 'reviewed.json'), reviewedBytes);
    map.find(r => r.source === 'reviewed.json').sha256 = sha(reviewedBytes);
    fs.writeFileSync(path.join(args.output, 'COPY-MAP.prepared.json'), JSON.stringify(map));
    kit.files['COPY-MAP.prepared.json'] = sha(JSON.stringify(map));
    fs.writeFileSync(path.join(args.output, 'TRACKED-NEXUS-KIT.json'), JSON.stringify(kit));
    const host = path.join(args.output, 'host.prepared.ps1'); fs.writeFileSync(host, 'throw "MODEL ONLY"');
    const ready = { runtimeModules: kit.runtime.length, filesToCopy: map.map(r => ({ ...r })),
      control: args.output, pluginPath: cfg.pluginPath, purpose: cfg.purpose, preparedOnly: true,
      activationApproved: false, host: { path: host, sha256: sha(fs.readFileSync(host)) } };
    const readyFile = path.join(args.output, 'READY.prepared.json');
    const save = () => fs.writeFileSync(readyFile, JSON.stringify(ready)); save();
    assert.equal(verifyTracked(args.output, { materialization: true }).materializationMappingVerified, true);
    ready.control = ready.control.replaceAll('\\', '/'); ready.host.path = ready.host.path.replaceAll('\\', '/');
    save(); assert.equal(verifyTracked(args.output, { materialization: true }).materializationMappingVerified, true);
    ready.filesToCopy.pop(); save(); assert.throws(() => verifyTracked(args.output, { materialization: true }), /COPY_MAP_INCOMPLETE/);
    ready.filesToCopy = map.map(r => ({ ...r })); // Restore from the original kit control map.
    ready.filesToCopy.push({ source: 'TRACKED-NEXUS-KIT.json', destination: 'TRACKED-NEXUS-KIT.json', sha256: sha('{}') });
    save(); assert.throws(() => verifyTracked(args.output, { materialization: true }), /COPY_MAP_INCOMPLETE/);
    fs.appendFileSync(path.join(args.output, 'scope-pins.json'), ' ');
    assert.throws(() => verifyTracked(args.output), /TRACKED_KIT_DRIFT/);
  });

test('generated entrypoint admits the exact reviewed batch at baseline startup for sizes one through four',
  { skip: !process.env.VORTEX_TRACKED_REFERENCE }, t => {
    const root = fs.mkdtempSync(path.join(scratch, 'tracked-startup-test-'));
    t.after(() => fs.rmSync(root, { recursive: true }));
    for (const count of [1, 2, 3, 4]) {
      const plan = held(); plan.reviewedPackages = plan.reviewedPackages.slice(0, count);
      const planFile = path.join(root, `plan-${count}.json`), bytes = Buffer.from(JSON.stringify(plan));
      fs.writeFileSync(planFile, bytes);
      const output = path.join(root, `kit-${count}`);
      prepareTracked({ reference: process.env.VORTEX_TRACKED_REFERENCE, planFile,
        planSha256: sha(bytes), output, apply: true });
      verifyTracked(output);
      const code = fs.readFileSync(path.join(output, 'index.prepared.js'), 'utf8');
      const startup = code.match(/baseline=read\(cfg\.baselineFile\);[\s\S]*?deadline=Date\.now\(\)\+900000;/)?.[0];
      assert(startup, 'actual generated baseline admission block must be exercised');
      const policy = require(path.join(output, 'scope-policy.cjs'));
      const rows = bound().rows.slice(0, count);
      const check = packages => vm.runInNewContext(startup, {
        cfg: { baselineFile: 'model-only', reviewedPackages: rows },
        read: () => ({ health: { gameId: 'cyberpunk2077' }, packages,
          deployedFiles: Array.from({ length: 8 }, (_, n) => ({ gamePath: `r6/${n}.reds` })),
          protectedStageFiles: [{}] }),
        must: (ok, message) => { if (!ok) throw Error(message); },
        targetPackage: policy.target,
        require: id => { assert.equal(id, './scope-policy.cjs'); return policy; },
      }, { timeout: 1000 });
      assert.doesNotThrow(() => check(rows), `reviewed batch size ${count}`);
      assert.throws(() => check(rows.slice(1)), /BASELINE_SCOPE|COUNT_REQUIRED/);
      assert.throws(() => check([...rows, rows[0]]), /BASELINE_SCOPE|COUNT_REQUIRED/);
      const changed = structuredClone(rows); changed[0].nexusFileId++;
      assert.throws(() => check(changed), /EXACT_TRACKED_NEXUS_SCOPE/);
      if (count > 1) {
        for (const field of ['nexusModId', 'requiredDownloadId', 'expectedModId']) {
          const duplicate = structuredClone(rows); duplicate[1][field] = duplicate[0][field];
          assert.throws(() => check(duplicate));
        }
        const duplicate = structuredClone(rows); duplicate[1].expectedModId = duplicate[0].expectedModId.toUpperCase();
        assert.throws(() => check(duplicate), /DUPLICATE_TRACKED_NEXUS_TARGET/);
      }
    }
  });


const LEGACY_CAPTURE_BODY_SHA256 = 'afaaf45ceb5b85547700bde934cc8b7834aecf6e7b30aa427b79ad5ff13e6ef6';
const LEGACY_CAPTURE_ENTRY_SHA256 = 'bcbd0f01d41af5347aa8cd08af8d0656ef7b02fef2eb9757a1cfb1cf4aa10a93';
const ordinaryProfile = 'ordinary-profile_42';
const captureReferencesAvailable = !!(process.env.VORTEX_TRACKED_REFERENCE && process.env.VORTEX_TRACKED_CAPTURE_REFERENCE);

function profileFixture(t) {
  const root = fs.mkdtempSync(path.join(scratch, 'tracked-profile-test-'));
  t.after(() => { assert(root.startsWith(scratch + path.sep)); fs.rmSync(root, {recursive: true}); });
  const planFile = path.join(root, 'plan.json'), bytes = Buffer.from(JSON.stringify(held()));
  fs.writeFileSync(planFile, bytes);
  const installKit = path.join(root, 'install');
  prepareTracked({reference: process.env.VORTEX_TRACKED_REFERENCE, planFile,
    planSha256: sha(bytes), output: installKit, apply: true});
  const capture = (name, extra = {}) => {
    const output = path.join(root, name);
    const result = prepareTrackedCapture({reference: process.env.VORTEX_TRACKED_CAPTURE_REFERENCE,
      installKit, output, ...extra, apply: true});
    return {output, result};
  };
  return {root, planFile, bytes, installKit, capture};
}

function modeledQuiet(dir) {
  const file = path.join(dir, 'capture.cjs'), mod = {exports: {}};
  let touched = 0;
  const denied = new Proxy({}, {get() { touched++; throw Error('UNEXPECTED_NATIVE_ACCESS'); }});
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), {module: mod, exports: mod.exports,
    Buffer, process: denied, setTimeout() { throw Error('UNEXPECTED_NATIVE_TIMER'); },
    require(id) {
      if (['original-fs', 'fs', 'node:fs'].includes(id)) return denied;
      if (id.startsWith('./')) return {};
      assert(isBuiltin(id)); return require(id);
    },
  }, {filename: file, timeout: 1000});
  assert.equal(typeof mod.exports.quiet, 'function');
  return {quiet: mod.exports.quiet, untouched: () => assert.equal(touched, 0)};
}

function quietContext(profileId = ordinaryProfile) {
  const state = {activeGame: 'cyberpunk2077', activeProfile: profileId, app: {appVersion: '2.9.1'},
    settings: {automation: {install: false, enable: false}},
    session: {collections: {}, base: {toolsRunning: {}}, mods: {changes: {}, deploymentFailures: {}}, notifications: {dialogs: []}},
    persistent: {mods: {cyberpunk2077: {old: {state: 'installed'}}}}};
  return {state, cfg: {health: {gameId: 'cyberpunk2077', profileId}, expectedHostVersion: '2.9.1'},
    selectors: {activeGameId: s => s.activeGame, activeProfileId: s => s.activeProfile}};
}

test('explicit capture profiles reject malformed values before reading paths, and only capture accepts the CLI option', () => {
  for (const profileId of [null, false, 7, {}, [], '', 'with space', 'control\nprofile', 'nul\0profile', 'x'.repeat(201), 'quote"profile']) {
    assert.throws(() => prepareTrackedCapture({profileId}), /EXACT_CAPTURE_PROFILE_REQUIRED/);
    assert.throws(() => adaptTrackedCapture(Buffer.alloc(0), Buffer.alloc(0), profileId), /EXACT_CAPTURE_PROFILE_REQUIRED/);
  }
  assert.throws(() => preparationCLI(['--profile-id', ordinaryProfile]), /INVALID_TRACKED_PREPARATION_ARGUMENTS/);
  assert.throws(() => preparationCLI(['capture', '--profile-id', 'bad!']), /EXACT_CAPTURE_PROFILE_REQUIRED/);
  assert.throws(() => preparationCLI(['capture', '--profile-id', ordinaryProfile, '--profile-id', ordinaryProfile]), /INVALID_TRACKED_PREPARATION_ARGUMENTS/);
});

test('explicit capture target binds actual native quiet guard while preserving every existing refusal',
  {skip: !captureReferencesAvailable}, async t => {
    const f = profileFixture(t), ordinary = f.capture('ordinary', {profileId: ordinaryProfile});
    const result = verifyTrackedCapture(ordinary.output);
    assert.equal(result.targetProfileId, ordinaryProfile); assert.equal(result.runtime, 9);
    assert.equal(result.activationGranted, false); assert.equal(result.nativeEffects, false);
    const loaded = modeledQuiet(ordinary.output), good = quietContext();
    assert.doesNotThrow(() => loaded.quiet(good.state, good.cfg, good.selectors));
    for (const profileId of ['ptndev1016', ordinaryProfile.toUpperCase(), 'another-profile']) {
      const c = quietContext(profileId);
      assert.throws(() => loaded.quiet(c.state, c.cfg, c.selectors), /ACTIVE_CONTEXT_CHANGED/);
    }
    for (const [mutate, code] of [
      [s => {s.app.appVersion = 'changed';}, 'HOST_VERSION_CHANGED'],
      [s => {s.activeGame = 'another-game';}, 'ACTIVE_CONTEXT_CHANGED'],
      [s => {s.activeProfile = 'another-profile';}, 'ACTIVE_CONTEXT_CHANGED'],
      [s => {s.session.collections.activeSession = {};}, 'ACTIVE_COLLECTION_SESSION'],
      [s => {s.settings.automation.install = true;}, 'AUTOMATION_ENABLED'],
      [s => {s.settings.automation.enable = true;}, 'AUTOMATION_ENABLED'],
      [s => {s.session.base.toolsRunning.running = {};}, 'PENDING_NATIVE_ACTIVITY'],
      [s => {s.session.mods.changes.pending = {};}, 'PENDING_NATIVE_ACTIVITY'],
      [s => {s.session.mods.deploymentFailures.cyberpunk2077 = {failed: {}};}, 'PENDING_NATIVE_ACTIVITY'],
      [s => {s.session.notifications.dialogs.push({});}, 'NATIVE_DIALOG_PENDING'],
      [s => {s.persistent.mods.cyberpunk2077.old.state = 'installing';}, 'NATIVE_INSTALL_OR_REMOVAL_IN_PROGRESS'],
    ]) {
      const c = quietContext(); mutate(c.state);
      assert.throws(() => loaded.quiet(c.state, c.cfg, c.selectors), new RegExp(code));
    }
    // The same actual quiet guard is used after awaited native reads.
    await Promise.resolve(); good.state.activeProfile = 'drift-after-read';
    assert.throws(() => loaded.quiet(good.state, good.cfg, good.selectors), /ACTIVE_CONTEXT_CHANGED/);
    loaded.untouched(); inert(ordinary.output);
    assert.equal(verifyTrackedCapture(ordinary.output).liveFreshnessVerified, false);
    assert.throws(() => verifyTrackedCapture(ordinary.output, {materialization: true}), /EXACT_TRACKED_CAPTURE_INPUT_REQUIRED/);
  });

test('legacy no-profile capture keeps its exact generated source and cannot silently retarget',
  {skip: !captureReferencesAvailable}, t => {
    const f = profileFixture(t), legacy = f.capture('legacy'), explicitDev = f.capture('explicit-dev', {profileId: 'ptndev1016'});
    const legacyContract = JSON.parse(fs.readFileSync(path.join(legacy.output, 'TRACKED-CAPTURE-KIT.json')));
    assert.equal(Object.hasOwn(legacyContract, 'targetProfileId'), false);
    for (const kit of [legacy, explicitDev]) {
      assert.equal(sha(fs.readFileSync(path.join(kit.output, 'capture.cjs'))), LEGACY_CAPTURE_BODY_SHA256);
      assert.equal(sha(fs.readFileSync(path.join(kit.output, 'index.prepared.js'))), LEGACY_CAPTURE_ENTRY_SHA256);
      assert.equal(verifyTrackedCapture(kit.output).targetProfileId, 'ptndev1016');
      const loaded = modeledQuiet(kit.output), good = quietContext('ptndev1016');
      assert.doesNotThrow(() => loaded.quiet(good.state, good.cfg, good.selectors));
      const wrong = quietContext(); assert.throws(() => loaded.quiet(wrong.state, wrong.cfg, wrong.selectors), /ACTIVE_CONTEXT_CHANGED/);
      loaded.untouched();
    }
    const ordinary = f.capture('ordinary', {profileId: ordinaryProfile});
    const code = fs.readFileSync(path.join(ordinary.output, 'capture.cjs'), 'utf8');
    assert.equal(sha(Buffer.from(code.replace(`h.profileId===${JSON.stringify(ordinaryProfile)}`, "h.profileId==='ptndev1016'"))), LEGACY_CAPTURE_BODY_SHA256);
  });

test('capture contract and non-null bound health cannot retarget a prepared profile, even before materialization',
  {skip: !captureReferencesAvailable}, t => {
    const f = profileFixture(t), {output} = f.capture('ordinary', {profileId: ordinaryProfile});
    const contractFile = path.join(output, 'TRACKED-CAPTURE-KIT.json'), original = fs.readFileSync(contractFile);
    const contract = JSON.parse(original);
    for (const profileId of ['ptndev1016', 'another-profile']) {
      fs.writeFileSync(contractFile, JSON.stringify({...contract, targetProfileId: profileId}));
      assert.throws(() => verifyTrackedCapture(output), /TRACKED_CAPTURE_ENTRY_DIFFERS/);
    }
    const removed = {...contract}; delete removed.targetProfileId;
    fs.writeFileSync(contractFile, JSON.stringify(removed));
    assert.throws(() => verifyTrackedCapture(output), /TRACKED_CAPTURE_ENTRY_DIFFERS/);
    for (const profileId of [null, false, 7, '', 'with space', 'bad\nprofile', 'x'.repeat(201)]) {
      fs.writeFileSync(contractFile, JSON.stringify({...contract, targetProfileId: profileId}));
      assert.throws(() => verifyTrackedCapture(output), /EXACT_CAPTURE_PROFILE_REQUIRED/);
    }
    fs.writeFileSync(contractFile, original);
    const cfgFile = path.join(output, 'reviewed.prepared.json'), cfg = JSON.parse(fs.readFileSync(cfgFile));
    for (const health of [{gameId: 'cyberpunk2077', profileId: 'ptndev1016'},
      {gameId: 'cyberpunk2077', profileId: ordinaryProfile.toUpperCase()},
      {gameId: 'other-game', profileId: ordinaryProfile}, {}]) {
      fs.writeFileSync(cfgFile, JSON.stringify({...cfg, health}));
      assert.throws(() => verifyTrackedCapture(output), /TRACKED_CAPTURE_PROFILE_DIFFERS/);
    }
    fs.writeFileSync(cfgFile, JSON.stringify({...cfg, health: {gameId: 'cyberpunk2077', profileId: ordinaryProfile}}));
    const checked = verifyTrackedCapture(output);
    assert.equal(checked.targetProfileId, ordinaryProfile); assert.equal(checked.materializationMappingVerified, false);
    assert.equal(checked.activationGranted, false); assert.equal(checked.liveFreshnessVerified, false);
    assert.throws(() => verifyTrackedCapture(output, {materialization: true}));

    // Model only: these owned JSON files are not native admission or disk proof.
    const baselineFile = path.join(f.root, 'model-disk-baseline.json');
    const admissionFile = path.join(f.root, 'model-source-admission.json');
    fs.writeFileSync(baselineFile, '{"modelOnly":true,"nativeDiskVerified":false}');
    fs.writeFileSync(admissionFile, '{"modelOnly":true,"nativeAdmissionVerified":false}');
    const guard = path.join(here, 'guard.cjs'), modelRows = bound().rows;
    const boundConfig = {...cfg, expectedHostVersion: '2.9.1', guard,
      sourcePins: {[guard]: sha(fs.readFileSync(guard))},
      health: {gameId: 'cyberpunk2077', profileId: ordinaryProfile,
        gamePath: path.join(f.root, 'model-game'), stagingPath: path.join(f.root, 'model-stage'),
        downloadPath: path.join(f.root, 'model-downloads'),
        filesystemIds: {gamePath: '1:2', stagingPath: '1:3', downloadPath: '1:4'}},
      freshRootDiskBaselineFinalized: true,
      diskBaseline: {path: baselineFile, sha256: sha(fs.readFileSync(baselineFile))},
      manifestPath: path.join(f.root, 'model-game', 'vortex.deployment.json'),
      admissionFile, admissionSHA256: sha(fs.readFileSync(admissionFile)),
      nativeTempPath: path.join(f.root, 'model-temp'), pluginPath: path.join(f.root, 'inactive-plugin'),
      packages: cfg.packages.map((p, i) => ({...p, requiredDownloadId: modelRows[i].requiredDownloadId,
        expectedModId: modelRows[i].expectedModId, archive: path.join(f.root, `model-archive-${i}.zip`),
        md5: 'a'.repeat(32), crcVerified: true}))};
    const cfgBytes = Buffer.from(JSON.stringify(boundConfig));
    fs.writeFileSync(cfgFile, cfgBytes); fs.writeFileSync(path.join(output, 'reviewed.json'), cfgBytes);
    fs.writeFileSync(path.join(output, 'info.json'), '{"name":"Offline capture model"}');
    const map = JSON.parse(fs.readFileSync(path.join(output, 'COPY-MAP.prepared.json')));
    map.find(row => row.source === 'reviewed.json').sha256 = sha(cfgBytes);
    map.find(row => row.source === 'info.json').sha256 = sha(fs.readFileSync(path.join(output, 'info.json')));
    const mapBytes = Buffer.from(JSON.stringify(map));
    fs.writeFileSync(path.join(output, 'COPY-MAP.prepared.json'), mapBytes);
    const mappedContract = structuredClone(contract);
    mappedContract.files['COPY-MAP.prepared.json'] = sha(mapBytes);
    fs.writeFileSync(contractFile, JSON.stringify(mappedContract));
    const host = path.join(output, 'host.prepared.ps1'); fs.writeFileSync(host, 'throw "MODEL ONLY - never invoke"');
    fs.writeFileSync(path.join(output, 'READY.prepared.json'), JSON.stringify({control: output,
      pluginPath: boundConfig.pluginPath, purpose: boundConfig.purpose,
      preparedOnly: true, activationApproved: false, runtimeModules: 9,
      filesToCopy: map, host: {path: host, sha256: sha(fs.readFileSync(host))}}));
    assert.equal(map.length, 12);
    const mapped = verifyTrackedCapture(output, {materialization: true});
    assert.equal(mapped.materializationMappingVerified, true);
    assert.equal(mapped.activationGranted, false); assert.equal(mapped.liveFreshnessVerified, false);
    assert.equal(mapped.nativeEffects, false);
    fs.writeFileSync(cfgFile, JSON.stringify({...boundConfig,
      health: {...boundConfig.health, profileId: 'ptndev1016'}}));
    assert.throws(() => verifyTrackedCapture(output, {materialization: true}), /TRACKED_CAPTURE_PROFILE_DIFFERS/);
  });

test('overwritten legacy reference policies are unused while active owned and reference policies remain pinned',
  {skip: !process.env.VORTEX_TRACKED_REFERENCE}, t => {
    const root = fs.mkdtempSync(path.join(scratch, 'tracked-owner-inputs-test-'));
    t.after(() => { assert(root.startsWith(scratch + path.sep)); fs.rmSync(root, {recursive: true}); });
    const reference = path.join(root, 'reference'); fs.cpSync(process.env.VORTEX_TRACKED_REFERENCE, reference, {recursive: true});
    const unused = ['preference-policy.cjs', 'scope-policy.cjs', 'settlement.cjs'];
    for (const name of unused) fs.writeFileSync(path.join(reference, name), "throw Error('UNUSED_REFERENCE_INPUT');\n");
    const planFile = path.join(root, 'plan.json'), bytes = Buffer.from(JSON.stringify(held())); fs.writeFileSync(planFile, bytes);
    const make = name => {
      const output = path.join(root, name);
      prepareTracked({reference, planFile, planSha256: sha(bytes), output, apply: true});
      assert.equal(verifyTracked(output).runtime, 20); return output;
    };
    const withUnused = make('with-unused');
    for (const name of unused) fs.unlinkSync(path.join(reference, name));
    const withoutUnused = make('without-unused');
    const a = JSON.parse(fs.readFileSync(path.join(withUnused, 'TRACKED-NEXUS-KIT.json')));
    const b = JSON.parse(fs.readFileSync(path.join(withoutUnused, 'TRACKED-NEXUS-KIT.json')));
    assert.deepEqual(a.runtime, b.runtime);
    for (const name of [...a.runtime, 'index.prepared.js', 'reference-index.js', 'COPY-MAP.prepared.json'])
      assert.deepEqual(fs.readFileSync(path.join(withUnused, name)), fs.readFileSync(path.join(withoutUnused, name)), name);
    const ca = JSON.parse(fs.readFileSync(path.join(withUnused, 'reviewed.prepared.json')));
    const cb = JSON.parse(fs.readFileSync(path.join(withoutUnused, 'reviewed.prepared.json')));
    assert.deepEqual({...ca, control: null}, {...cb, control: null});
    for (const name of unused) {
      const file = path.join(withoutUnused, name), saved = fs.readFileSync(file);
      fs.appendFileSync(file, '\n// altered active owner\n');
      const changedContract = structuredClone(b); changedContract.files[name] = sha(fs.readFileSync(file));
      fs.writeFileSync(path.join(withoutUnused, 'TRACKED-NEXUS-KIT.json'), JSON.stringify(changedContract));
      assert.throws(() => verifyTracked(withoutUnused), /STALE_TRACKED_KIT/);
      fs.writeFileSync(file, saved);
    }
    fs.writeFileSync(path.join(withoutUnused, 'TRACKED-NEXUS-KIT.json'), JSON.stringify(b));
    assert.equal(verifyTracked(withoutUnused).status, 'tracked-code-contract-verified');
    fs.appendFileSync(path.join(reference, 'native-selectors.cjs'), '\n// altered active reference\n');
    assert.throws(() => make('bad-reference'), /TRACKED_REFERENCE_MODULE_DRIFT/);
    assert.equal(fs.existsSync(path.join(root, 'bad-reference')), false);
  });
