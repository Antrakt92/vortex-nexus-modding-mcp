import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {canonicalPlanId, createPlanJournal} from './plan-journal.mjs';
import {planQueue, validatePlan} from './plan-contract.mjs';
import {runPlan, inspectPlan} from './session.mjs';
import {RUN_PLAN_TOOL} from './plan-tool.mjs';
import receipts from './receipts.cjs';

const context = () => ({gameId: 'cyberpunk2077', profileId: 'profile', gamePath: 'F:/Game', stagingPath: 'F:/Stage',
  downloadPath: 'D:/Downloads', filesystemIds: {gamePath: '1:2', stagingPath: '1:3', downloadPath: '4:5'}});
const install = (name = 'Own-One', index = 1) => ({operation: 'install_local_archive', requestId: 'own_install_000' + index,
  archivePath: 'F:/OwnBuilds/' + name + '.zip', size: 1234, sha256: 'a'.repeat(64)});
const plan = () => ({version: 1, context: context(), steps: [install(),
  {operation: 'set_mods_enabled', requestId: 'own_enable_0001', modIds: ['Own-One'], enabled: true}],
deploy: {requestId: 'own_deploy_0001'}});
const unused = () => ({protocol: 'vortex-agent/1', receiptIssues: [], attempt: null, completion: null, failure: null,
  interlock: null, adapterTerminalReceiptObserved: false, terminalOperationVerified: false, incompleteCompletionObserved: false});
const readiness = () => ({localArchiveInstallSupported: true, sourceAdmissionVerified: true, hostVersion: '2.9.1',
  reviewedDynamicExtensions: 2, nativeEffects: false});
function fixture(t, hooks = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'own-install-plan-'));
  t.after(() => fs.rmSync(root, {recursive: true}));
  const journal = createPlanJournal({root: path.join(root, 'plans')}), calls = [], writes = [], stored = new Map();
  const call = async (name, args = {}) => {
    calls.push({name, args: structuredClone(args)});
    const overridden = await hooks.before?.(name, args, {calls, writes, stored});
    if (overridden !== undefined) return overridden;
    if (name === 'health') return {protocol: 'vortex-agent/1', ...context()};
    if (name === 'read_local_install_readiness') return readiness();
    if (name === 'reconcile_operation') return stored.get(args.requestId) ?? unused();
    assert(['install_local_archive', 'set_mods_enabled', 'deploy_mods'].includes(name));
    const at = new Date().toISOString();
    const result = {protocol: 'vortex-agent/1', requestId: args.requestId, operation: name,
      operationCompleted: true, diskDeploymentVerified: false, verificationRequired: receipts.VERIFICATION,
      ...(name === 'install_local_archive' ? {modId: path.win32.basename(args.archivePath, '.zip'), downloadId: 'download_' + writes.length,
        installedRecordVerified: true, enabled: false, archiveSha256Verified: true, payloadFilesVerified: 2}
        : name === 'deploy_mods' ? {deploymentPromiseResolved: true}
          : {modIds: args.modIds, enabled: args.enabled, enabledFlagsVerified: true})};
    const attempt = {protocol: 'vortex-agent/1', receiptVersion: receipts.VERSION, requestId: args.requestId, operation: name,
      gameId: args.gameId, profileId: args.profileId, at, parameters: structuredClone(args)};
    const completion = {...result, receiptVersion: receipts.VERSION, gameId: args.gameId, profileId: args.profileId, at};
    if (name === 'install_local_archive') result.installDiagnostics = {optional: 'not receipt authority'};
    writes.push({name, args: structuredClone(args)});
    const record = {...unused(), attempt, completion, adapterTerminalReceiptObserved: true, terminalOperationVerified: true};
    stored.set(args.requestId, record);
    return await hooks.after?.(name, args, {result, record, calls, writes, stored}) ?? result;
  };
  return {journal, calls, writes, stored, call, run: (value = plan(), options = {}) => runPlan(value, {apply: true, call, journal, ...options})};
}

test('new local install step is strict, detached and advertised through the existing plan tool', async () => {
  const value = plan(), validated = validatePlan(value), queue = planQueue(value);
  assert.equal(validated.version, 1); assert.deepEqual(queue.map(r => r.operation), ['install_local_archive', 'set_mods_enabled', 'deploy_mods']);
  value.steps[0].sha256 = 'b'.repeat(64); assert.equal(validated.steps[0].sha256, 'a'.repeat(64));
  assert.equal(queue[0].args.archivePath, 'F:/OwnBuilds/Own-One.zip');
  const choices = RUN_PLAN_TOOL.inputSchema.properties.plan.properties.steps.items.oneOf;
  assert(choices.some(c => c.properties.operation.const === 'install_local_archive' && c.additionalProperties === false));
  let calls = 0;
  const result = await runPlan(validated, {call: async () => {calls++; throw Error('must not call');}});
  assert.equal(result.status, 'validated'); assert.equal(calls, 0);
});

test('unsafe pins, paths, filenames, options and unsupported games refuse offline', () => {
  for (const change of [s => {s.size = 0;}, s => {s.size = 64 * 1024 * 1024 + 1;}, s => {s.sha256 = 'A'.repeat(64);},
    s => {s.archivePath = 'Own-One.zip';}, s => {s.archivePath = 'F:Own-One.zip';}, s => {s.archivePath = '//server/share/Own-One.zip';},
    s => {s.archivePath = 'F:/OwnBuilds/Own One.zip';}, s => {s.archivePath = 'F:/OwnBuilds/Own-One.ZIP';},
    s => {s.archivePath = 'F:/OwnBuilds/CON.zip';}, s => {s.archivePath = 'F:/OwnBuilds/Own-One..zip';},
    s => {s.archivePath = 'F:/OwnBuilds/Own-One\n.zip';}, s => {s.archivePath = 'F:/' + 'a'.repeat(4096) + '/Own-One.zip';},
    s => {s.archivePath = 'F:/OwnBuilds/Own-One.zip/';}, s => {s.archivePath = 'F:\\OwnBuilds\\Own-One.zip\\';},
    s => {s.downloadId = 'tracked';}, s => {s.replace = true;}, s => {s.operation = 'install_download';}]) {
    const value = plan(); change(value.steps[0]); assert.throws(() => validatePlan(value), /INVALID_PLAN_STEP/);
  }
  const unsupported = plan(); unsupported.context.gameId = 'skyrimse';
  assert.throws(() => validatePlan(unsupported), /INVALID_PLAN_STEP/);
});

test('duplicate mod IDs including path and case aliases refuse, and installs precede all activation', () => {
  for (const archivePath of ['F:/OwnBuilds/Own-One.zip', 'D:/Elsewhere/own-one.zip', 'F:\\OwnBuilds\\child\\..\\OWN-ONE.zip']) {
    const value = plan(); value.steps.splice(1, 0, {...install('Other', 2), archivePath});
    assert.throws(() => validatePlan(value), /INVALID_PLAN_STEP/);
  }
  const reordered = plan(); reordered.steps.reverse(); assert.throws(() => validatePlan(reordered), /INVALID_PLAN_STEP/);
  const disableFirst = plan(); disableFirst.steps.unshift({operation: 'set_mods_enabled', requestId: 'disable_first_01', modIds: ['old'], enabled: false});
  assert.throws(() => validatePlan(disableFirst), /INVALID_PLAN_STEP/);
});

test('existing v1 plans and historical journals keep their semantic identity and remain readable', t => {
  const f = fixture(t), legacy = plan(); legacy.steps.shift();
  const expected = canonicalPlanId(legacy);
  assert.equal(expected, '87f460249f8016caebf9f781c9a0d1c39256c5adea35637d92230cfda83e6fc2');
  const reordered = {...legacy, context: Object.fromEntries(Object.entries(legacy.context).reverse())};
  assert.equal(canonicalPlanId(reordered), expected);
  const writer = f.journal.begin(legacy);
  for (const [index, item] of planQueue(legacy).entries()) {writer.intent(index, item.operation, item.args); writer.observed(index);}
  writer.finish('completed');
  assert.equal(f.journal.read(expected).state, 'completed'); assert.deepEqual(f.journal.read(expected).plan, legacy);
  assert.throws(() => f.journal.begin(legacy), /PLAN_JOURNAL_EXISTS_HOLD/);
});

test('installation plans refuse case-aliased receipt IDs offline across steps and final deploy', async () => {
  for (const target of ['install', 'activation', 'download', 'deploy']) {
    const value = plan(), alias = value.steps[0].requestId.toUpperCase();
    if (target === 'install') value.steps.splice(1, 0, {...install('Own-Two', 2), requestId: alias});
    else if (target === 'activation') value.steps[1].requestId = alias;
    else if (target === 'download') value.steps.unshift({operation: 'download_nexus', requestId: alias,
      nexusModId: 1, nexusFileId: 2, size: 123, sha256: 'b'.repeat(64), reuseOnly: true});
    else value.deploy.requestId = alias;
    let calls = 0;
    await assert.rejects(runPlan(value, {apply: true, call: async () => {calls++;}}), /DUPLICATE_REQUEST_ID/);
    assert.equal(calls, 0);
  }
});

test('historical non-install v1 plans with case-distinct IDs remain readable', t => {
  const f = fixture(t), legacy = plan(); legacy.steps.shift();
  legacy.deploy.requestId = legacy.steps[0].requestId.toUpperCase();
  const expected = canonicalPlanId(legacy), writer = f.journal.begin(legacy);
  for (const [index, item] of planQueue(legacy).entries()) {writer.intent(index, item.operation, item.args); writer.observed(index);}
  writer.finish('completed');
  assert.deepEqual(f.journal.read(expected).plan, legacy);
  assert.equal(canonicalPlanId(f.journal.read(expected).plan), expected);
});

test('two installs precede explicit flags and one deploy; diagnostics are not receipt authority', async t => {
  const f = fixture(t), value = plan(); value.steps.splice(1, 0, install('Own-Two', 2));
  const result = await f.run(value);
  assert.equal(result.status, 'completed');
  assert.deepEqual(f.writes.map(w => w.name), ['install_local_archive', 'install_local_archive', 'set_mods_enabled', 'deploy_mods']);
  assert.equal(f.calls.filter(c => c.name === 'read_local_install_readiness').length, 1);
  assert(f.calls.findIndex(c => c.name === 'read_local_install_readiness') < f.calls.findIndex(c => c.name === 'install_local_archive'));
  assert.deepEqual(result.completed[0], {operation: 'install_local_archive', requestId: 'own_install_0001', adapterReceiptVerified: true,
    modId: 'Own-One', downloadId: 'download_0', installedRecordVerified: true, enabled: false, archiveSha256Verified: true, payloadFilesVerified: 2});
  assert(!JSON.stringify(result.completed).includes('installDiagnostics'));
  const inspected = await inspectPlan(result.planId, {call: f.call, journal: f.journal});
  assert.equal(inspected.status, 'completed'); assert.equal(inspected.currentStateVerified, false);
  assert.equal(inspected.resumeSupported, false); assert.equal(inspected.retryAllowed, false);
  const before = f.writes.length; assert.equal((await f.run(value)).status, 'stopped'); assert.equal(f.writes.length, before);
});

test('readiness refusal stops before any installation plan effect, including an earlier download', async t => {
  const f = fixture(t, {before(name) {if (name === 'read_local_install_readiness') return {...readiness(), sourceAdmissionVerified: false};}});
  const value = plan(); value.steps.unshift({operation: 'download_nexus', requestId: 'download_first_01', nexusModId: 1, nexusFileId: 2,
    size: 123, sha256: 'b'.repeat(64), reuseOnly: true});
  const result = await f.run(value); assert.equal(result.code, 'LOCAL_INSTALL_READINESS_UNCERTAIN'); assert.equal(f.writes.length, 0);
});

test('late used request ID refuses before readiness or any first effect', async t => {
  const f = fixture(t, {before(name, args) {if (name === 'reconcile_operation' && args.requestId === 'own_deploy_0001')
    return {...unused(), attempt: {requestId: args.requestId}};}});
  const result = await f.run(); assert.equal(result.status, 'stopped'); assert.equal(f.writes.length, 0);
  assert.equal(f.calls.filter(c => c.name === 'read_local_install_readiness').length, 0);
});

test('wrong install acknowledgements and extraneous authority stop before activation/deploy', async t => {
  for (const change of [v => {v.modId = 'other';}, v => {v.downloadId = '';}, v => {v.enabled = true;},
    v => {v.installedRecordVerified = false;}, v => {v.archiveSha256Verified = false;}, v => {v.payloadFilesVerified = 0;},
    v => {v.payloadFilesVerified = 4097;}, v => {v.verificationRequired = 'unreviewed';}, v => {v.safeToMigrate = true;}]) {
    const f = fixture(t, {after(name, args, {result}) {if (name === 'install_local_archive') change(result);}});
    const result = await f.run(); assert.equal(result.status, 'stopped'); assert.equal(result.code, 'WRITE_ACKNOWLEDGEMENT_UNCERTAIN');
    assert.equal(f.writes.length, 1);
  }
});

test('receipt contradictions, wrong original parameters or extra authority stop and never deploy', async t => {
  for (const change of [r => {r.completion.downloadId = 'different';}, r => {r.completion.modId = 'other';},
    r => {r.attempt.parameters.sha256 = 'b'.repeat(64);}, r => {r.completion.enabled = true;},
    r => {r.completion.migrationReady = true;}, r => {r.completion.installDiagnostics = {};},
    r => {r.completion.at = '2000-01-01T00:00:00.000Z';}, r => {r.terminalOperationVerified = false;},
    r => {delete r.attempt.receiptVersion;}, r => {r.attempt.receiptVersion = -1;},
    r => {r.attempt.at = 'invalid';}, r => {r.attempt.protocol = 'unreviewed';}]) {
    const f = fixture(t, {after(name, args, {record}) {if (name === 'install_local_archive') change(record);}});
    const result = await f.run(); assert.equal(result.status, 'stopped'); assert.equal(f.writes.length, 1);
    assert(['ACK_RECEIPT_MISMATCH', 'WRITE_ACKNOWLEDGEMENT_UNCERTAIN', 'TERMINAL_RECEIPT_UNCERTAIN'].includes(result.code));
  }
});

test('historical install inspection also requires exact original parameters and native receipt envelopes', async t => {
  for (const mutate of [r => {r.attempt.parameters.archivePath = 'F:/Other/Own-One.zip';},
    r => {r.attempt.gameId = 'other';}, r => {r.completion.profileId = 'other';}, r => {delete r.attempt.receiptVersion;}]) {
    const f = fixture(t), result = await f.run(); assert.equal(result.status, 'completed');
    mutate(f.stored.get('own_install_0001'));
    const writes = f.writes.length, inspected = await inspectPlan(result.planId, {call: f.call, journal: f.journal});
    assert.equal(inspected.status, 'partial'); assert.equal(inspected.steps[0].state, 'uncertain');
    assert.equal(f.writes.length, writes); assert.equal(inspected.retryAllowed, false);
  }
});

test('A complete, B acknowledgement lost, C pending: reconcile original B and stop without replay/deploy', async t => {
  const f = fixture(t, {after(name, args) {if (name === 'install_local_archive' && args.requestId === 'own_install_0002') throw Error('TRANSPORT_LOST');}});
  const value = plan(); value.steps.splice(1, 0, install('Own-Two', 2), install('Own-Three', 3));
  const result = await f.run(value); assert.equal(result.status, 'stopped'); assert.equal(result.requestId, 'own_install_0002');
  assert.deepEqual(result.completed.map(v => v.requestId), ['own_install_0001']);
  assert.deepEqual(f.writes.map(v => v.args.requestId), ['own_install_0001', 'own_install_0002']);
  assert.equal(f.calls.at(-1).name, 'reconcile_operation'); assert.equal(f.calls.at(-1).args.requestId, 'own_install_0002');
  const inspected = await inspectPlan(result.planId, {call: f.call, journal: f.journal});
  assert.equal(inspected.status, 'partial'); assert.equal(inspected.steps[1].state, 'adapter_completed');
  assert.equal(inspected.steps[2].state, 'intent_not_recorded'); assert.equal(inspected.resumeSupported, false);
});

test('cancellation during install waits for original receipt and stops later steps', async t => {
  let release, entered;
  const gate = new Promise(resolve => {release = resolve;}), started = new Promise(resolve => {entered = resolve;});
  const f = fixture(t, {after: async name => {if (name === 'install_local_archive') {entered(); await gate;}}});
  const controller = new AbortController(), running = f.run(plan(), {signal: controller.signal});
  await started; controller.abort(); release();
  const result = await running; assert.equal(result.code, 'PLAN_CANCELLED'); assert.equal(f.writes.length, 1);
  assert.equal(result.completed.length, 1);
  assert.equal(f.calls.at(-1).name, 'reconcile_operation');
  assert.equal(f.calls.at(-1).args.requestId, 'own_install_0001');
  const journal = f.journal.read(result.planId);
  assert.deepEqual(journal.events.map(e => e.kind), ['intent', 'observed', 'terminal']);
});
