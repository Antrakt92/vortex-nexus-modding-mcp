#!/usr/bin/env node
// Independent, post-shutdown disk/receipt check. Does not contact or alter Vortex.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import paths from './paths.cjs';
import receipts from './receipts.cjs';
import { validInstallDiagnostics } from './install-diagnostics.cjs';
import { assertOrdinaryModSnapshot, ordinaryProcessesPreserved } from './native-fixture-snapshot.mjs';
const base = path.join(paths.workspace, 'local-state/vortex-agent-native-fixture');
const root = path.resolve(process.argv[2] || '');
const rel = path.relative(base, root);
assert.ok(rel && !rel.startsWith('..') && !path.isAbsolute(rel), 'Root outside fixture');
const read = name => JSON.parse(fs.readFileSync(path.join(root, name)));
const hash = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const input = read('prepared.json'), receipt = read('native-receipt.json'), result = read('runner-result.json');
if (input.runtimeVersion) {
  assert.equal(eventVersion(receipt), input.runtimeVersion);
  assert.equal(input.runtimeSourceSha256, hash(path.join(paths.build, 'plugin/vortex-agent/index.js')));
}
function eventVersion(value) { return value.events.find(item => item.phase === 'authenticated-native-health')?.health?.extensionVersion; }
assert.equal(receipt.status, 'passed'); assert.equal(result.fixtureExited, true); assert.equal(result.ordinaryUnchanged, true); assert.deepEqual(result.remainingFixturePids, []);
const event = phase => { const found = receipt.events.filter(e => e.phase === phase); assert.equal(found.length, 1, phase); return found[0]; };
const install = event('native-install-only'), deploy = event('independent-disk-deployment-proof'), rollback = event('independent-rollback-proof');
assert.equal(deploy.manifest.files.length, 1);
assert.equal(deploy.manifest.files[0].source, install.installationPath);
assert.equal(deploy.manifest.deploymentMethod, 'hardlink_activator');
assert.equal(deploy.game.filesystemId, deploy.staging.filesystemId); assert.ok(deploy.game.links >= 2);
assert.equal(deploy.game.sha256, input.payloadSha256); assert.equal(deploy.backup.sha256, input.sentinelSha256);
assert.equal(rollback.original.filesystemId, install.original.filesystemId, 'Original file identity restored');
assert.equal(hash(rollback.original.path), input.sentinelSha256); assert.equal(hash(rollback.staging.path), input.payloadSha256);
assert.equal(fs.existsSync(rollback.original.path + '.vortex_backup'), false); assert.equal(rollback.enabled, false);
assert.equal(rollback.manifest.files.length, 0);
const completionSuffixes = [...(input.installRoute === 'mcp-local-archive' ? ['install'] : []), 'enable', 'deploy', 'disable', 'restore'];
for (const suffix of completionSuffixes) {
  const completion = read(`local-state/vortex-agent-build/receipts/${input.runId}_${suffix}.completion.json`);
  assert.equal(completion.operationCompleted, true);
  assert.equal(completion.diskDeploymentVerified, false);
  if (['1.0.4', '1.1.0'].includes(input.runtimeVersion)) { assert.equal(completion.receiptVersion, 2); assert.equal(completion.requestId, `${input.runId}_${suffix}`); }
  if (suffix === 'install') {
    const attempt = read(`local-state/vortex-agent-build/receipts/${input.runId}_install.attempt.json`);
    assert.equal(receipts.validAttempt(attempt), true);
    assert.equal(receipts.validCompletion(completion, attempt), true);
    assert.equal(completion.modId, install.modId); assert.equal(completion.downloadId, install.downloadId);
    assert.equal(completion.archiveSha256Verified, true); assert.equal(completion.installedRecordVerified, true);
    assert.equal(completion.enabled, false); assert.equal(completion.payloadFilesVerified, 1);
    const observation = event('mcp-local-install-diagnostics');
    const completed = event('mcp-local-install-completed').result;
    const sidecar = read(`local-state/vortex-agent-build/receipts/${input.runId}_install.diagnostics.json`);
    assert.deepEqual(Object.keys(sidecar).sort(), ['attemptAt', 'diagnostics', 'operation', 'requestId', 'schema']);
    assert.equal(sidecar.schema, 'install-diagnostic-record/1');
    assert.equal(sidecar.operation, attempt.operation); assert.equal(sidecar.requestId, attempt.requestId);
    assert.equal(sidecar.attemptAt, attempt.at);
    assert.equal(observation.requestId, attempt.requestId); assert.equal(completed.requestId, attempt.requestId);
    assert.ok(Array.isArray(observation.samples) && observation.samples.length > 0 && observation.samples.length <= 90);
    assert.ok(observation.samples.some(sample => sample.source === 'live' && sample.diagnostics), 'Live installation diagnostics were never observed');
    for (const sample of observation.samples) {
      assert.deepEqual(Object.keys(sample).sort(), ['attemptAt', 'diagnostics', 'source']);
      assert.ok(['unavailable', 'live', 'retained'].includes(sample.source));
      if (sample.diagnostics) {
        assert.equal(validInstallDiagnostics(sample.diagnostics), true);
        assert.equal(sample.attemptAt, attempt.at);
        assert.notEqual(sample.source, 'unavailable');
      } else assert.equal(sample.source, 'unavailable');
    }
    assert.deepEqual(Object.keys(observation.retained).sort(), ['attemptAt', 'diagnostics', 'source']);
    assert.equal(observation.retained.source, 'retained'); assert.equal(observation.retained.attemptAt, attempt.at);
    const final = sidecar.diagnostics;
    assert.equal(validInstallDiagnostics(final), true);
    assert.equal(final.state, 'completed'); assert.equal(final.phase, 'finalizing_receipt');
    assert.equal(final.reason, 'none'); assert.equal(final.waitReason, 'none');
    assert.equal(final.effectsMayHaveOccurred, true); assert.equal(final.nativeMayContinue, false);
    assert.ok(Object.values(final.metrics).every(metric => metric.calls >= 1));
    assert.equal(final.metrics.archive_proof.calls, 2);
    for (const metric of ['native_import', 'import_settle', 'native_install', 'staged_proof', 'receipt_commit']) assert.equal(final.metrics[metric].calls, 1);
    assert.deepEqual(final, completed.installDiagnostics); assert.deepEqual(final, observation.retained.diagnostics);
  }
}
assert.equal(fs.existsSync(path.join(root, 'local-state/vortex-agent-build/receipts/unresolved.json')), false);
assert.equal(fs.existsSync(path.join(root, 'local-state/vortex-agent-build/receipts/mutation.lock')), false);
assert.equal(hash(input.archive), input.archiveSha256);
const archiveEvents = receipt.events.filter(e => ['native-local-archive-finished', 'native-import-finished'].includes(e.phase));
assert.equal(archiveEvents.length, 1, 'Exactly one archive acquisition proof');
const imported = archiveEvents[0].archive;
assert.equal(hash(imported.path), input.archiveSha256); assert.equal(fs.statSync(imported.path).size, input.archiveSize);
const zip = fs.readFileSync(imported.path);
assert.equal(zip.readUInt32LE(0), 0x04034b50); assert.equal(zip.readUInt16LE(8), 0);
const size = zip.readUInt32LE(18), nameSize = zip.readUInt16LE(26), extraSize = zip.readUInt16LE(28);
assert.equal(zip.subarray(30, 30 + nameSize).toString(), input.payloadPath);
const bytes = zip.subarray(30 + nameSize + extraSize, 30 + nameSize + extraSize + size);
let crc = 0xffffffff;
for (const b of bytes) { crc ^= b; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
assert.equal((crc ^ 0xffffffff) >>> 0, zip.readUInt32LE(14), 'ZIP CRC');
assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), input.payloadSha256);
assert.equal(rollback.trackedDownloads, input.installRoute === 'local-archive' ? 0 : 1);
assert.equal(rollback.installedMods, input.withExistingMod ? 2 : 1);
if (input.withExistingMod) {
  assert.equal(input.installRoute, 'mcp-local-archive');
  const project = value => Object.fromEntries(['modId', 'mod', 'profileFlags', 'staged'].map(key => [key, value[key]]));
  const baseline = project(event('existing-mod-baseline'));
  const settled = event('existing-mod-baseline-settled');
  assert.equal(settled.modId, baseline.modId); assert.equal(settled.didInstall, true);
  assert.equal(settled.enabled, false); assert.equal(settled.modSize, baseline.staged.size);
  assert.equal(baseline.mod.attributes.modSize, baseline.staged.size);
  assert.equal(baseline.profileFlags['native-agent-fixture'][baseline.modId], false);
  assert.deepEqual(project(event('existing-mod-preserved-after-install')), baseline);
  assert.deepEqual(project(event('existing-mod-preserved-after-rollback')), baseline);
  assert.equal(baseline.modId, 'native-agent-existing');
  assert.equal(baseline.mod.state, 'installed');
  assert.ok(Object.entries(baseline.profileFlags).every(([profile, flags]) =>
    input.ownLocalPlan && profile === 'native-agent-plan-second' ? flags[baseline.modId] === true : flags[baseline.modId] !== true));
  assert.equal(hash(input.existingMod.archivePath), input.existingMod.archiveSha256);
  assert.equal(fs.statSync(input.existingMod.archivePath).size, input.existingMod.archiveSize);
  assert.equal(hash(baseline.staged.path), input.existingMod.payloadSha256);
  const staged = fs.statSync(baseline.staged.path, { bigint: true });
  assert.equal(`${staged.dev}:${staged.ino}`, baseline.staged.filesystemId);
  assert.equal(fs.existsSync(path.join(input.game, input.existingMod.payloadPath)), false);
  const collision = event('same-archive-collision-refused');
  assert.equal(collision.installedMods, 2); assert.equal(collision.unresolved, false);
  const attempt = read(`local-state/vortex-agent-build/receipts/${input.runId}_collision.attempt.json`);
  const failed = read(`local-state/vortex-agent-build/receipts/${input.runId}_collision.failed.json`);
  assert.equal(receipts.validAttempt(attempt), true); assert.equal(receipts.validFailure(failed, attempt), true);
  assert.deepEqual(collision.failed, failed); assert.deepEqual(project(collision.existing), baseline);
  assert.equal(failed.effectsMayHaveOccurred, false); assert.equal(failed.inspectBeforeRetry, false);
  assert.equal(failed.errorCode, 'LOCAL_ARCHIVE_MOD_COLLISION');
  assert.equal(fs.existsSync(path.join(input.adapterReceipts, input.runId + '_collision.completion.json')), false);
}
if (input.candidateAssessment) {
  assert.equal(input.installRoute, 'mcp-local-archive'); assert.equal(input.withExistingMod, true);
  const setup = event('candidate-assessment-fixture-setup'), finished = event('candidate-assessment-fixture-finished');
  assert.equal(setup.metadataRecordsOnly, true); assert.equal(setup.payloadVerified, false);
  assert.equal(finished.metadataRecordsOnly, true); assert.equal(finished.noAdditionalDeployment, true);
  assert.equal(setup.fixtureWorkerSha256, input.fixtureWorkerSha256);
  assert.equal(setup.candidateAssessmentSourceSha256, input.candidateAssessmentSourceSha256);
  assert.equal(hash(path.join(root, 'userdata/plugins/native-agent-fixture/index.js')), input.fixtureWorkerSha256);
  assert.equal(hash(new URL('./installed-candidate-assessment.cjs', import.meta.url)), input.candidateAssessmentSourceSha256);
  const provenance = JSON.parse(fs.readFileSync(path.join(paths.build, 'plugin/vortex-agent/provenance.json')));
  assert.equal(provenance.sources['installed-candidate-assessment.cjs'], input.candidateAssessmentSourceSha256);
  assert.equal(provenance.pluginSha256, input.runtimeSourceSha256);
  assert.equal(hash(path.join(root, 'userdata/plugins/native-agent-fixture/runtime.cjs')), input.runtimeSourceSha256);
  assert.equal(setup.records.length, 8); assert.deepEqual(finished.records, setup.records);
  assert.deepEqual(finished.preserved, setup.preserved);
  assert.deepEqual(finished.secondProfile, { ...setup.secondProfile, pendingRemove: true });
  assert.equal(setup.secondProfile.modState['native-assessment-old-vanilla'].enabled, true);
  assert.equal(setup.secondProfile.pendingRemove, false);
  for (const [phase, expected] of [['candidate-assessment-setup-profile-settled', 2], ['candidate-assessment-pending-profile-settled', 0]]) {
    const barrier = event(phase);
    assert.equal(barrier.profileId, setup.secondProfileId); assert.equal(barrier.activeProfileId, 'native-agent-fixture');
    assert.equal(barrier.starts, expected); assert.equal(barrier.stops, expected);
    assert.equal(barrier.loadOrderCompletionObserved, true); assert.equal(barrier.emptyLoadOrderObserved, true);
    assert.equal(barrier.loadOrderHash, crypto.createHash('sha256').update('[]').digest('hex'));
    assert.deepEqual(barrier.sourceBlobs, { profiles: '4b4cddc08c29f5fa2d78b0e7f59ebea8dc3380c1',
      installManager: '6f847f3f878a0f8a8082b827d8b2bc4ebbcbe221', activity: '250cf30f897938ed1705cfec654b3b6b4f79d598',
      loadOrder: '8f3044cc73c8d97629da3f4f304382eb7fe71149', loadOrderAction: 'b8f88de149399ed01d346ae8e6b4788438078f30' });
  }
  assert.equal(setup.preserved.nativeMod.id, install.modId);
  assert.equal(setup.preserved.existingMod.id, 'native-agent-existing');
  assert.equal(setup.preserved.targetProfile.modState[install.modId].enabled, false);
  assert.equal(setup.preserved.targetProfile.modState['native-agent-existing'].enabled, false);
  assert.deepEqual(setup.preserved.original, rollback.original); assert.deepEqual(setup.preserved.staging, rollback.staging);
  const baselineExisting = event('existing-mod-preserved-after-rollback');
  assert.deepEqual(setup.preserved.existingMod, baselineExisting.mod);
  assert.deepEqual(setup.preserved.existingStaging, baselineExisting.staged);
  for (const record of setup.records) assert.equal(fs.existsSync(path.join(input.stage, record.installationPath)), false,
    'Metadata fixture must not masquerade as installed disk payload');
  const rows = {};
  for (const name of ['vanilla', 'exact-conflict', 'choices', 'ignored', 'pending-profile']) {
    const observed = event('candidate-assessment-' + name), value = observed.result;
    assert.equal(observed.before, observed.after); assert.match(observed.before, /^[a-f0-9]{64}$/);
    assert.equal(observed.dispatches, 0); assert.equal(observed.nativeEffects, 0);
    assert.equal(observed.args.gameId, 'cyberpunk2077'); assert.equal(observed.args.profileId, 'native-agent-fixture');
    assert.equal(observed.args.collectionModId, setup.collectionModId); assert.equal(observed.args.expectedRevisionId, 900002);
    assert.equal(value.schema, 'installed-candidate-assessment/1'); assert.equal(value.protocol, 'vortex-agent/1');
    assert.equal(value.gameId, observed.args.gameId); assert.equal(value.profileId, observed.args.profileId);
    assert.equal(value.collection.modId, setup.collectionModId); assert.equal(value.collection.revisionId, 900002);
    assert.equal(value.metadataOnly, true); assert.equal(value.effectsAllowed, false);
    assert.equal(value.migrationReady, false); assert.equal(value.diskDeploymentVerified, false);
    assert.ok(value.counts.matcherChecks > 0); assert.equal(value.comparisons.length, 1);
    const row = rows[name] = value.comparisons[0];
    assert.equal(row.oldModId, observed.args.comparisons[0].oldModId);
    assert.equal(row.candidateModId, observed.args.comparisons[0].candidateModId);
    assert.match(row.fingerprint, /^[a-f0-9]{64}$/); assert.match(row.selectedRule.ruleIdHash, /^[a-f0-9]{64}$/);
    assert.match(row.selectedRule.fingerprint, /^[a-f0-9]{64}$/);
    assert.equal(JSON.stringify(value).includes('"ruleId":'), false);
  }
  assert.equal(rows.vanilla.status, 'compatible_installed_variant'); assert.deepEqual(rows.vanilla.reasons, []);
  assert.ok(rows.vanilla.profiles.old.some(p => p.id === setup.secondProfileId && p.enabled && !p.pendingRemove));
  assert.ok(rows.vanilla.archiveReferences.old.some(r => r.modId === 'native-assessment-old-vanilla'));
  assert.ok(rows.vanilla.archiveReferences.candidate.some(r => r.modId === 'native-assessment-candidate-vanilla'));
  assert.equal(rows['exact-conflict'].status, 'conflict'); assert.ok(rows['exact-conflict'].reasons.includes('CANDIDATE_IDENTITY_CONFLICT'));
  assert.ok(['conflict', 'insufficient_evidence'].includes(rows.choices.status));
  assert.ok(rows.choices.reasons.includes('CUSTOMIZATIONS_REVIEW_REQUIRED'));
  assert.ok(rows.choices.incomingRequires.some(r => r.oldInstallSpecMatches === true && r.installSpecMatches === false));
  assert.equal(rows.ignored.status, 'insufficient_evidence'); assert.ok(rows.ignored.reasons.includes('IGNORED_REQUIREMENT_REVIEW_REQUIRED'));
  assert.equal(rows['pending-profile'].status, 'insufficient_evidence'); assert.ok(rows['pending-profile'].reasons.includes('PROFILE_PENDING_REMOVE'));
  assert.ok(rows['pending-profile'].profiles.old.some(p => p.id === setup.secondProfileId && p.pendingRemove));
  const setupIndex = receipt.events.indexOf(setup);
  assert.ok(setupIndex > receipt.events.indexOf(event('existing-mod-preserved-after-rollback')));
  assert.equal(receipt.events.slice(setupIndex).some(e => e.phase.startsWith('deploy_mods_')), false);
}
if (input.ownLocalPlan) {
  assert.equal(input.installRoute, 'mcp-local-archive'); assert.equal(input.withExistingMod, true);
  assert.equal(input.candidateAssessment, false); assert.equal(input.planPackages.length, 2);
  const preflight = event('own-local-plan-client-preflight'), intent = event('own-local-plan-intent');
  const completed = event('own-local-plan-completed'), deployed = event('own-local-plan-disk-deployment-proof');
  const restored = event('own-local-plan-rollback-proof');
  assert.equal(preflight.nativeEffects, false); assert.equal(preflight.entry, 'session.mjs');
  assert.deepEqual(preflight.sources, input.planClientSources); assert.deepEqual(intent.sources, input.planClientSources);
  assert.equal(preflight.fixtureWorkerSha256, input.fixtureWorkerSha256);
  assert.equal(hash(path.join(root, 'userdata/plugins/native-agent-fixture/index.js')), input.fixtureWorkerSha256);
  assert.ok(receipt.events.indexOf(preflight) < receipt.events.indexOf(event('existing-mod-baseline-settled')));
  assert.ok(receipt.events.indexOf(intent) > receipt.events.indexOf(event('existing-mod-preserved-after-rollback')));
  for (const [relative, pin] of Object.entries(input.planClientSources)) {
    assert.match(relative, /^[a-zA-Z0-9_.-]+\.(?:mjs|cjs|json)$/);
    const file = path.join(input.planClientRoot, relative), stat = fs.statSync(file, {bigint: true});
    assert.equal(hash(file), pin.sha256);
    assert.equal([stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':'), pin.generation);
  }
  assert.equal(completed.result.status, 'completed'); assert.equal(completed.result.planId, intent.planId);
  assert.deepEqual(event('own-local-plan-result').result, completed.result);
  assert.equal(completed.result.diskDeploymentVerified, false); assert.equal(completed.result.completed.length, 4);
  assert.deepEqual(completed.writes.map(item => item.operation), ['install_local_archive', 'install_local_archive', 'set_mods_enabled', 'deploy_mods']);
  const queue = [...intent.plan.steps, {operation: 'deploy_mods', ...intent.plan.deploy}];
  assert.deepEqual(completed.writes.map(item => item.requestId), queue.map(item => item.requestId));
  const journalRoot = path.join(root, 'plan-journals', intent.planId);
  const journal = JSON.parse(fs.readFileSync(path.join(journalRoot, 'plan.json')));
  assert.deepEqual(journal.plan, intent.plan); assert.equal(journal.planId, intent.planId);
  const names = fs.readdirSync(journalRoot).filter(n => n !== 'plan.json').sort();
  assert.deepEqual(names, Array.from({length: 9}, (_, i) => String(i + 1).padStart(6, '0') + '.json'));
  const journalEvents = names.map(name => JSON.parse(fs.readFileSync(path.join(journalRoot, name))));
  assert.deepEqual(journalEvents, completed.events);
  for (const [index, item] of queue.entries()) {
    const pending = journalEvents[index * 2], observed = journalEvents[index * 2 + 1];
    assert.equal(pending.kind, 'intent'); assert.equal(pending.index, index); assert.equal(pending.operation, item.operation);
    const {operation, ...args} = item;
    assert.deepEqual(pending.args, {...intent.plan.context, ...args});
    assert.equal(observed.kind, 'observed'); assert.equal(observed.index, index);
  }
  assert.equal(journalEvents[8].kind, 'terminal'); assert.equal(journalEvents[8].status, 'completed');
  assert.equal(journalEvents[8].code, null);
  for (const item of [...queue, {operation: 'set_mods_enabled', requestId: input.runId + '_plan_disable'},
    {operation: 'deploy_mods', requestId: input.runId + '_plan_restore'}]) {
    const attempt = read('local-state/vortex-agent-build/receipts/' + item.requestId + '.attempt.json');
    const completion = read('local-state/vortex-agent-build/receipts/' + item.requestId + '.completion.json');
    assert.equal(receipts.validAttempt(attempt), true); assert.equal(receipts.validCompletion(completion, attempt), true);
    assert.equal(attempt.operation, item.operation); assert.equal(completion.operationCompleted, true);
    assert.equal(completion.diskDeploymentVerified, false);
  }
  assert.equal(deployed.manifest.files.length, 2); assert.equal(deployed.manifest.deploymentMethod, 'hardlink_activator');
  assert.equal(restored.manifest.files.length, 0); assert.equal(restored.installedMods, 4); assert.equal(restored.trackedDownloads, 3);
  assert.equal(restored.sourceGenerationVerified, true); assert.deepEqual(restored.originals, intent.originals);
  assert.deepEqual(intent.originals.game, rollback.original); assert.deepEqual(intent.originals.staged, rollback.staging);
  const second = event('own-local-plan-second-profile-baseline');
  assert.equal(second.activeProfileId, 'native-agent-fixture'); assert.equal(second.loadOrderCompletionObserved, true);
  assert.equal(second.starts, 2); assert.equal(second.stops, 2);
  assert.equal(second.profile.id, 'native-agent-plan-second');
  assert.deepEqual(second.profile.modState, {'native-agent-existing': {enabled: true, enabledTime: 1}});
  assert.deepEqual(intent.originals.secondProfile, second.profile); assert.deepEqual(restored.originals.secondProfile, second.profile);
  assert.equal(event('existing-mod-baseline').profileFlags[second.profile.id]['native-agent-existing'], true);
  assert.deepEqual(second.sourceBlobs, { profiles: '4b4cddc08c29f5fa2d78b0e7f59ebea8dc3380c1',
    installManager: '6f847f3f878a0f8a8082b827d8b2bc4ebbcbe221', activity: '250cf30f897938ed1705cfec654b3b6b4f79d598',
    loadOrder: '8f3044cc73c8d97629da3f4f304382eb7fe71149', loadOrderAction: 'b8f88de149399ed01d346ae8e6b4788438078f30' });
  assert.equal(completed.checkpoints.length, 2);
  const beforeActivation = event('own-local-plan-before-activation');
  assert.deepEqual(beforeActivation.disabledModIds, input.planPackages.map(item => item.modId));
  assert.equal(beforeActivation.allSentinelsPreserved, true); assert.equal(beforeActivation.installedCheckpoints, 2);
  assert.ok(receipt.events.indexOf(beforeActivation) > receipt.events.indexOf(event('own-local-plan-disabled-install-2')));
  for (const [index, item] of input.planPackages.entries()) {
    const disabled = event('own-local-plan-disabled-install-' + (index + 1));
    const proof = deployed.deployed[index], restoredItem = restored.restoredPackages[index];
    assert.deepEqual(completed.checkpoints[index], Object.fromEntries(Object.entries(disabled).filter(([key]) => !['at', 'phase'].includes(key))));
    assert.equal(disabled.modId, item.modId); assert.equal(disabled.enabled, false);
    assert.ok(disabled.flagProof.entryPresent === false && disabled.flagProof.enabledType === 'undefined' && disabled.flagProof.enabled === null
      || disabled.flagProof.entryPresent === true && disabled.flagProof.enabledType === 'boolean' && disabled.flagProof.enabled === false);
    assert.equal(hash(item.archivePath), item.archiveSha256); assert.equal(fs.statSync(item.archivePath).size, item.archiveSize);
    assert.equal(hash(disabled.imported.path), item.archiveSha256); assert.equal(disabled.imported.size, item.archiveSize);
    const archive = fs.readFileSync(disabled.imported.path);
    assert.equal(archive.readUInt32LE(0), 0x04034b50); assert.equal(archive.readUInt16LE(8), 0);
    const size = archive.readUInt32LE(18), nameSize = archive.readUInt16LE(26), extraSize = archive.readUInt16LE(28);
    assert.equal(archive.subarray(30, 30 + nameSize).toString(), item.payloadPath);
    const payload = archive.subarray(30 + nameSize + extraSize, 30 + nameSize + extraSize + size);
    let crc = 0xffffffff;
    for (const byte of payload) { crc ^= byte; for (let n = 0; n < 8; n++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
    assert.equal((crc ^ 0xffffffff) >>> 0, archive.readUInt32LE(14));
    assert.equal(crypto.createHash('sha256').update(payload).digest('hex'), item.payloadSha256);
    assert.equal(disabled.installed.sha256, item.payloadSha256); assert.equal(disabled.original.sha256, item.sentinelSha256);
    assert.deepEqual(disabled.original, intent.packages[index].original);
    assert.equal(proof.modId, item.modId); assert.equal(proof.game.sha256, item.payloadSha256);
    assert.equal(proof.game.filesystemId, proof.installed.filesystemId); assert.ok(proof.game.links >= 2);
    assert.equal(proof.backup.sha256, item.sentinelSha256); assert.equal(proof.backup.filesystemId, disabled.original.filesystemId);
    const owner = deployed.manifest.files.find(file => file.relPath.replace(/\\/g, '/') === item.payloadPath);
    assert.equal(owner.source, item.modId);
    assert.equal(restoredItem.modId, item.modId); assert.equal(restoredItem.enabled, false);
    assert.deepEqual(restoredItem.original, disabled.original);
    assert.equal(hash(restoredItem.original.path), item.sentinelSha256); assert.equal(hash(restoredItem.installed.path), item.payloadSha256);
    const stat = fs.statSync(restoredItem.original.path, {bigint: true});
    assert.equal(`${stat.dev}:${stat.ino}`, disabled.original.filesystemId);
    const installedStat = fs.statSync(restoredItem.installed.path, {bigint: true});
    assert.equal(`${installedStat.dev}:${installedStat.ino}`, disabled.installed.filesystemId);
    assert.equal(fs.existsSync(restoredItem.original.path + '.vortex_backup'), false);
  }
}
const before = read('ordinary-before.json'), after = read('ordinary-after.json');
assertOrdinaryModSnapshot(before.mods); assertOrdinaryModSnapshot(after.mods);
assert.deepEqual(before.health, after.health); assert.deepEqual(before.profiles, after.profiles); assert.deepEqual(before.mods, after.mods);
assert.equal(before.manifestSha256, after.manifestSha256);
assert.equal(ordinaryProcessesPreserved(before.processes, after.processes), true, 'Ordinary process generations changed or unavailable');
const log = fs.readFileSync(path.join(root, 'userdata/vortex.log'), 'utf8');
assert.match(log, /clean application end/);
const proof = { passed: true, root, checks: ['native import/install', 'authenticated compiled agent enable/deploy/disable/restore', 'manifest ownership', 'deployed hardlink identity', 'original hash and filesystem identity restored', 'post-shutdown game/staging hashes', 'ZIP size/SHA-256/CRC',
  input.ownLocalPlan ? 'eleven durable completions without unresolved marker' : completionSuffixes.length === 5 ? 'five durable completions without unresolved marker' : 'four durable completions without unresolved marker',
  ...(input.withExistingMod ? ['existing mod/flags/staged identity preserved', 'same-archive collision refused before effects'] : []),
  ...(input.installRoute === 'mcp-local-archive' ? ['live bounded install diagnostics and retained sidecar bound to original attempt'] : []),
  ...(input.ownLocalPlan ? ['actual two-ZIP runPlan with disabled installation checkpoints, strict receipts/journal, one final deployment and independent restoration'] : []),
  ...(input.candidateAssessment ? ['built native candidate assessment: compatible/conflict/choices/ignored/pending-profile, immutable state and no payload authority'] : []),
  'ordinary health/profile/mod inventory/manifest/process preservation', 'clean native shutdown'], nexusReuse: receipt.nexusReuse, at: new Date().toISOString() };
fs.writeFileSync(path.join(root, 'independent-verification.json'), JSON.stringify(proof, null, 2), { flag: 'wx' });
console.log(JSON.stringify(proof));
