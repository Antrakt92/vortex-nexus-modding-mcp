#!/usr/bin/env node
// Independent, post-shutdown disk/receipt check. Does not contact or alter Vortex.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import paths from './paths.cjs';
import receipts from './receipts.cjs';
import { validInstallDiagnostics } from './install-diagnostics.cjs';
import { assertOrdinaryModSnapshot } from './native-fixture-snapshot.mjs';
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
  assert.ok(Object.values(baseline.profileFlags).every(flags => flags[baseline.modId] !== true));
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
const before = read('ordinary-before.json'), after = read('ordinary-after.json');
assertOrdinaryModSnapshot(before.mods); assertOrdinaryModSnapshot(after.mods);
assert.deepEqual(before.health, after.health); assert.deepEqual(before.profiles, after.profiles); assert.deepEqual(before.mods, after.mods);
assert.equal(before.manifestSha256, after.manifestSha256);
const log = fs.readFileSync(path.join(root, 'userdata/vortex.log'), 'utf8');
assert.match(log, /clean application end/);
const proof = { passed: true, root, checks: ['native import/install', 'authenticated compiled agent enable/deploy/disable/restore', 'manifest ownership', 'deployed hardlink identity', 'original hash and filesystem identity restored', 'post-shutdown game/staging hashes', 'ZIP size/SHA-256/CRC',
  completionSuffixes.length === 5 ? 'five durable completions without unresolved marker' : 'four durable completions without unresolved marker',
  ...(input.withExistingMod ? ['existing mod/flags/staged identity preserved', 'same-archive collision refused before effects'] : []),
  ...(input.installRoute === 'mcp-local-archive' ? ['live bounded install diagnostics and retained sidecar bound to original attempt'] : []),
  'ordinary health/profile/mod inventory/manifest/process preservation', 'clean native shutdown'], nexusReuse: receipt.nexusReuse, at: new Date().toISOString() };
fs.writeFileSync(path.join(root, 'independent-verification.json'), JSON.stringify(proof, null, 2), { flag: 'wx' });
console.log(JSON.stringify(proof));
