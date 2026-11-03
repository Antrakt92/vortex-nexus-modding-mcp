import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHelperContents, verifyHelper } from './prepare-native-helper.mjs';
import strictJSON from './strict-json.cjs';
import ownZip from './own-zip.cjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const scratch = path.resolve(here, '../../../local-state');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const need = (ok, code) => { if (!ok) throw Error(code); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const key = value => typeof value === 'string' && /^[A-Za-z0-9_.-]{1,200}$/.test(value);
const canonical = value => JSON.stringify(value, null, 2) + '\n';
const sameMap = (a, b) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());
export const LIMITS = ownZip.LIMITS;
export const inspectOwnZip = ownZip.inspectOwnZip;
const relative = ownZip.relativePayloadPath;
const family = Object.freeze({ id: 'ci-own-local-20261029', gameId: 'cyberpunk2077', profileId: 'ptndev1016',
  hostVersion: '2.9.1', appAsarSHA256: 'ec3a29d58ea65a1ca84e456742c894a19efe96920a6710063d221d451a26d59a',
  entrySHA256: 'af1fa13f3ca78e8bc896d10e225c316f59cf18d2d0cffdfc3db7616fb622de2f',
  oldKey: 'own-CIStashFamily', oldSHA256: '739f0253224e727a325944a22dd2f4485cf6d1b64eae9172e4b4f5c92c6f3d1d', oldBytes: 752151,
  modules: Object.freeze({
    'engine.cjs': '25665272a27def2cb1d8a32a23653e2e369b31a4c305344e18c64bb16e40d1e8',
    'extractor-admission.cjs': '7d7da582e58f7af2ae492421617cdd168a4476b524287848b2805e7c201a2e93',
    'install-exclusivity.cjs': '0271fc55eb70f70dc11a4edce93d74855bf2e278830f138dc5c2d86d7b4a1211',
    'local-import-readiness.cjs': 'd3eb568434139eba999c8747cbb5cd93ee309d3bc07e1e247975523894c560c4',
    'local-policy.cjs': 'b839c1eb3339cc60863bcc2f56937df3163b3e96b44ec4e7913577f23f3aa69c',
    'metadata-preflight.cjs': '1aeec1071fc0d231353252a17636d5e45f72b7beecfd6a8b1e84221cb636a340',
    'native-selectors.cjs': '54946b7a3b1fb5f4ab5cc697abab4a345f26e3c41da0072cad96cf86f9b529ba',
    'nexus-identity.cjs': '33fd52ffa4fe465d07326cabdb656a3b14a48b5a3c0acf8e11bb5a1117c3561c',
    'poller.cjs': '14a57d3b49a32389fb17e58f1f2b0af4c9a2ba42233ea5e4218750f608f1a9ea',
    'protected-settings.cjs': 'bf303c3767ab5fa78187cecf6ed83e5a473115b4ae05f25e6225ca1119096fb5',
    'protected-stages.cjs': '2f07e5b723626688c35df9893d7fed09e620702990a617fb20e54a8cf2f34476',
    'settings-guard.cjs': 'bf6345c34707bd413b6d1da4592070b5d7407715dfc37429b49c4c9f1d0f8212',
    'settlement.cjs': 'cdc71c8d3c6d65421f42c41dd3188dd9f9de687f46297d2f262202e20826026a',
    'source-tree.cjs': '5bb8e9a358835380e11b531e986b43db58dacd94e99f1d8118703b362404719e',
    'tool-timestamps.cjs': 'a50d4f9f8da135e214542ef89dd970c3c38c569dd2a4ae7b12c4cac43cb7b0a7',
  }) });
export const SUPPORTED_FAMILY = family;
export const MISSING_BINDINGS = Object.freeze(['fresh host/source/loaded-extension admission', 'native metadata/no-previous-provider selection',
  'active game/profile and filesystem root identities', 'all-profile/mod/download/settings projections',
  'deployment owners and physical baseline', 'protected stages and saved preferences', 'native temp and process guard',
  'unresolved-operation/interlock reconciliation', 'fresh plugin identity and reviewed host/materializer',
  'complete READY copy map and root effect approval']);

function exact(value, names, code) {
  need(object(value) && Object.keys(value).length === names.length && names.every(n => Object.hasOwn(value, n)), code);
}
function ordinary(file) {
  for (let p = path.resolve(file); ; p = path.dirname(p)) {
    try { need(!fs.lstatSync(p).isSymbolicLink(), 'OWN_BINDER_REPARSE_PATH'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (p === path.dirname(p)) return;
  }
}
function absolute(value) {
  need(typeof value === 'string' && path.isAbsolute(value), 'OWN_BINDER_ABSOLUTE_PATH_REQUIRED');
  const result = path.resolve(value); ordinary(result); return result;
}
const stamp = stat => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.nlink].join(':');
function boundedRead(value, maxBytes, observations) {
  const file = absolute(value), fd = fs.openSync(file, 'r');
  try {
    const before = fs.fstatSync(fd, { bigint: true });
    need(before.isFile() && before.size <= BigInt(maxBytes), 'OWN_BINDER_BOUNDED_FILE_REQUIRED');
    need(stamp(fs.lstatSync(file, { bigint: true })) === stamp(before), 'OWN_BINDER_INPUT_CHANGED');
    const buffer = Buffer.alloc(Number(before.size) + 1); let used = 0, read;
    while (used < buffer.length && (read = fs.readSync(fd, buffer, used, buffer.length - used, null)) > 0) used += read;
    need(used === Number(before.size) && stamp(fs.fstatSync(fd, { bigint: true })) === stamp(before)
      && stamp(fs.lstatSync(file, { bigint: true })) === stamp(before), 'OWN_BINDER_INPUT_CHANGED');
    ordinary(file); observations?.set(file, stamp(before)); return buffer.subarray(0, used);
  } finally { fs.closeSync(fd); }
}
function json(bytes) {
  try { return strictJSON.parseStrictJSON(bytes, { maxBytes: LIMITS.evidenceBytes }); }
  catch { throw Error('OWN_BINDER_INVALID_JSON'); }
}
function evidence(ref, observations) {
  exact(ref, ['path', 'sha256'], 'OWN_BINDER_EVIDENCE_REFERENCE_REQUIRED');
  need(digest(ref.sha256) && typeof ref.path === 'string' && /\.json$/i.test(ref.path), 'OWN_BINDER_EVIDENCE_REFERENCE_REQUIRED');
  const bytes = boundedRead(ref.path, LIMITS.evidenceBytes, observations);
  need(sha(bytes) === ref.sha256, 'OWN_BINDER_EVIDENCE_CHANGED'); return bytes;
}

function payload(value) {
  need(object(value) && Object.keys(value).length > 0 && Object.keys(value).length <= LIMITS.entries,
    'OWN_BINDER_PAYLOAD_REQUIRED');
  // The pinned family's tree uses an ordinary object; this root filename would
  // change its prototype instead of producing a comparable own-property proof.
  need(!Object.hasOwn(value, '__proto__'), 'OWN_BINDER_UNSUPPORTED_PAYLOAD');
  for (const [name, pin] of Object.entries(value)) {
    relative(name);
    need(path.posix.basename(name).toLowerCase() !== '__folder_managed_by_vortex', 'OWN_BINDER_UNSUPPORTED_PAYLOAD');
    need(digest(pin), 'OWN_BINDER_PAYLOAD_REQUIRED');
  }
}

function planValue(value) {
  exact(value, ['schema', 'family', 'gameId', 'targetProfileId', 'expectedHostVersion', 'sourceHostSHA256', 'package', 'provenance'], 'OWN_BINDER_PLAN_REQUIRED');
  need(value.schema === 'own-local-helper-plan/1' && value.family === family.id && value.gameId === family.gameId
    && value.targetProfileId === family.profileId && value.expectedHostVersion === family.hostVersion
    && value.sourceHostSHA256 === family.appAsarSHA256, 'OWN_BINDER_UNSUPPORTED_FAMILY');
  const pkg = value.package;
  exact(pkg, ['key', 'archive', 'fileName', 'expectedModId', 'bytes', 'sha256', 'md5', 'expectedUncompressedBytes', 'payload'], 'OWN_BINDER_PACKAGE_REQUIRED');
  need(key(pkg.key) && typeof pkg.fileName === 'string' && /^[A-Za-z0-9_. -]{1,200}\.zip$/.test(pkg.fileName)
    && typeof pkg.expectedModId === 'string' && /^[A-Za-z0-9_. -]{1,200}$/.test(pkg.expectedModId)
    && !/[. ]$/.test(pkg.expectedModId) && pkg.expectedModId === pkg.expectedModId.trim()
    && Number.isSafeInteger(pkg.bytes) && pkg.bytes > 0 && pkg.bytes <= LIMITS.archiveBytes
    && digest(pkg.sha256) && /^[a-f0-9]{32}$/.test(pkg.md5 || '')
    && Number.isSafeInteger(pkg.expectedUncompressedBytes) && pkg.expectedUncompressedBytes > 0
    && pkg.expectedUncompressedBytes <= LIMITS.totalBytes, 'OWN_BINDER_PACKAGE_REQUIRED');
  relative(pkg.fileName); relative(pkg.expectedModId); payload(pkg.payload);
  need(path.basename(absolute(pkg.archive)) === pkg.fileName, 'OWN_BINDER_ARCHIVE_NAME_DIFFERS');
  need(pkg.expectedModId === pkg.fileName.slice(0, -4).trim(), 'OWN_BINDER_NATIVE_OWNER_DIFFERS');
  exact(value.provenance, ['projectId', 'sourceCommit', 'sourceManifest', 'buildReceipt'], 'OWN_BINDER_PROVENANCE_REQUIRED');
  need(typeof value.provenance.projectId === 'string' && /^[A-Za-z0-9_./-]{1,200}$/.test(value.provenance.projectId)
    && /^[a-f0-9]{40}$/.test(value.provenance.sourceCommit || ''), 'OWN_BINDER_PROVENANCE_REQUIRED');
  return value;
}
function replaceOnce(text, old, replacement) {
  need(text.split(old).length === 2, 'OWN_BINDER_UNSUPPORTED_REFERENCE'); return text.replace(old, replacement);
}
function readReference(reference, observations) {
  const dir = absolute(reference);
  need(!/[\\/]vortex[\\/]plugins(?:[\\/]|$)/i.test(dir), 'OWN_BINDER_ACTIVE_PATH_REFUSED');
  need(!fs.readdirSync(dir).some(n => /^(?:reviewed\.json|READY|frozen|root-ready|capture-ready|attempt|failed|completed|preflight-failed|HOST)/i.test(n)),
    'OWN_BINDER_ATTEMPTED_REFERENCE_REFUSED');
  // Diagnose only the closed reference family here, before hashing its entry.
  // Unrelated plan/build/archive filesystem failures keep their existing codes.
  for (const name of ['index.prepared.js', ...Object.keys(family.modules)]) {
    const file = path.join(dir, name); ordinary(file);
    try { fs.lstatSync(file); }
    catch (error) { if (error.code === 'ENOENT') throw Error('OWN_BINDER_REFERENCE_MISSING'); throw error; }
  }
  const input = boundedRead(path.join(dir, 'index.prepared.js'), 1024 * 1024, observations);
  need(sha(input) === family.entrySHA256, 'OWN_BINDER_REFERENCE_DRIFT'); const modules = new Map();
  for (const [name, pin] of Object.entries(family.modules)) {
    const bytes = boundedRead(path.join(dir, name), 1024 * 1024, observations);
    need(sha(bytes) === pin, 'OWN_BINDER_REFERENCE_DRIFT'); modules.set(name, bytes);
  }
  return { input, modules };
}
function buildEvidence(plan, observations) {
  const provenance = plan.provenance, manifest = json(evidence(provenance.sourceManifest, observations));
  need(object(manifest) && manifest.schemaVersion === 1 && manifest.variantKind === 'script-core'
    && object(manifest.payloadSHA256), 'OWN_BINDER_SOURCE_MANIFEST_DIFFERS');
  payload(manifest.payloadSHA256);
  const covered = new Set();
  for (const [name, pin] of Object.entries(manifest.payloadSHA256)) {
    need(Object.hasOwn(plan.package.payload, name) && plan.package.payload[name] === pin, 'OWN_BINDER_SOURCE_MANIFEST_DIFFERS'); covered.add(name);
  }
  const receipt = json(evidence(provenance.buildReceipt, observations));
  exact(receipt, ['schema', 'projectId', 'sourceCommit', 'sourceManifestSHA256', 'package', 'retainedPayload', 'evidence'], 'OWN_BINDER_BUILD_RECEIPT_REQUIRED');
  need(receipt.schema === 'own-local-build-evidence/1' && receipt.projectId === provenance.projectId
    && receipt.sourceCommit === provenance.sourceCommit && receipt.sourceManifestSHA256 === provenance.sourceManifest.sha256,
    'OWN_BINDER_BUILD_RECEIPT_DIFFERS');
  const expected = { ...plan.package }; delete expected.archive;
  exact(receipt.package, Object.keys(expected), 'OWN_BINDER_BUILD_RECEIPT_DIFFERS');
  need(Object.keys(expected).filter(k => k !== 'payload').every(k => receipt.package[k] === expected[k])
    && object(receipt.package.payload) && sameMap(receipt.package.payload, expected.payload) && Array.isArray(receipt.evidence)
    && receipt.evidence.length > 0 && receipt.evidence.length <= 16, 'OWN_BINDER_BUILD_RECEIPT_DIFFERS');
  need(Array.isArray(receipt.retainedPayload) && receipt.retainedPayload.length <= 4, 'OWN_BINDER_RETAINED_PAYLOAD_DIFFERS');
  const retainedSources = new Set();
  for (const component of receipt.retainedPayload) {
    exact(component, ['manifest', 'paths'], 'OWN_BINDER_RETAINED_PAYLOAD_DIFFERS');
    need(Array.isArray(component.paths) && component.paths.length > 0 && component.paths.length <= LIMITS.entries,
      'OWN_BINDER_RETAINED_PAYLOAD_DIFFERS');
    const retained = json(evidence(component.manifest, observations));
    need(object(retained) && object(retained.payloadSHA256) && !retainedSources.has(component.manifest.sha256),
      'OWN_BINDER_RETAINED_PAYLOAD_DIFFERS'); retainedSources.add(component.manifest.sha256);
    for (const name of component.paths) {
      relative(name);
      need(!covered.has(name) && Object.hasOwn(plan.package.payload, name) && Object.hasOwn(retained.payloadSHA256, name)
        && digest(retained.payloadSHA256[name]) && retained.payloadSHA256[name] === plan.package.payload[name],
      'OWN_BINDER_RETAINED_PAYLOAD_DIFFERS'); covered.add(name);
    }
  }
  need(covered.size === Object.keys(plan.package.payload).length, 'OWN_BINDER_SOURCE_COVERAGE_INCOMPLETE');
  for (const ref of receipt.evidence) evidence(ref, observations);
}
function scopeTest(pkg) {
  return Buffer.from(`'use strict';\nconst assert=require('node:assert/strict'),{createRunner}=require('./engine.cjs');\nconst c=require('./reviewed.prepared.json');\n(async()=>{let effects=0,guards=0;const options=packages=>({packages,guard:async()=>{guards++;throw Error('OFFLINE_SCOPE_HOLD');},record:()=>{},findTracked:()=>effects++,importOnce:()=>effects++,install:()=>effects++});\nawait assert.rejects(createRunner(options(c.packages)).run(),/OFFLINE_SCOPE_HOLD/);assert.equal(guards,1);assert.equal(effects,0);\nconst wrong={...c.packages[0],sha256:${JSON.stringify(pkg.sha256 === family.oldSHA256 ? '0'.repeat(64) : family.oldSHA256)}};await assert.rejects(createRunner(options([wrong])).run(),/EXACT_ONE/);assert.equal(guards,1);assert.equal(effects,0);console.log(JSON.stringify({actualPreparedPackageScopeVerified:true,nativeEffects:false}));})().catch(()=>{process.stderr.write('OWN_PACKAGE_SCOPE_TEST_FAILED\\n');process.exitCode=1;});\n`);
}
function makeContents(plan, reference, output, planSHA256, sourceProofMode) {
  const pkg = { ...plan.package, expectedEnabled: false, oldEnabledModIds: [], expectedType: '' };
  let entry = reference.input.toString('utf8');
  entry = replaceOnce(entry, "c.purpose==='one-own-ci-stash-family-disabled-only'", "c.purpose==='one-own-local-disabled-only'");
  entry = replaceOnce(entry,
    `c.packages[0].key==='${family.oldKey}'&&c.packages[0].sha256==='${family.oldSHA256}'&&c.packages[0].bytes===${family.oldBytes}`,
    `c.packages[0].key==='${pkg.key}'&&c.packages[0].sha256==='${pkg.sha256}'&&c.packages[0].bytes===${pkg.bytes}`);
  const modules = new Map(reference.modules);
  modules.set('engine.cjs', Buffer.from(replaceOnce(modules.get('engine.cjs').toString('utf8'),
    `o.packages[0].key==='${family.oldKey}'&&o.packages[0].sha256==='${family.oldSHA256}'`,
    `o.packages[0].key==='${pkg.key}'&&o.packages[0].sha256==='${pkg.sha256}'`)));
  const input = Buffer.from(entry);
  const config = { purpose: 'one-own-local-disabled-only', activationApproved: false, activationHold: true,
    freshActualBaselineBound: false, noEffects: true, health: { gameId: family.gameId }, control: output, pluginPath: null,
    packages: [pkg], modulePins: Object.fromEntries([...modules].map(([name, bytes]) => [name, sha(bytes)])),
    baselineFile: null, baselineSHA256: null, admissionFile: null, nativeSourceAdmissionSHA256: null,
    sourcePins: null, processGuard: null, interlocks: null, nativeTempPath: null, nativeTempId: null,
    stagingPath: null, protectedStageInventoryPath: null, expectedOriginalProviderIds: null,
    expectedProtectedStageFiles: null, retainedOldStageFiles: null, expectedSavedSettingsCount: null,
    expectedNativeModRecordsSHA256: null, expectedNativeProfilesSHA256: null, expectedNativeDownloadsSHA256: null,
    expectedNativeSettingsComparableSHA256: null, reviewedPeerExtensions: null, sourceParityPins: null,
    appAsar: null, appAsarSHA256: null, provenance: structuredClone(plan.provenance) };
  const contents = createHelperContents({ input, config, modules, output, sourceSha256: sha(input), sourceProofMode,
    tests: new Map([['test-package-scope.cjs', scopeTest(pkg)]]) });
  const held = JSON.parse(contents.get('reviewed.prepared.json')); held.helperSHA256 = sha(contents.get('index.prepared.js'));
  contents.set('reviewed.prepared.json', Buffer.from(canonical(held)));
  const helper = JSON.parse(contents.get('HELPER-KIT.json'));
  helper.files['reviewed.prepared.json'] = sha(contents.get('reviewed.prepared.json'));
  contents.set('HELPER-KIT.json', Buffer.from(canonical(helper)));
  const runtime = Object.keys(held.modulePins), maps = [['index.js', 'index.prepared.js'], ['info.json', 'info.prepared.json'],
    ['reviewed.json', 'reviewed.json'], ...runtime.map(n => [n, n])];
  contents.set('COPY-MAP.prepared.json', Buffer.from(canonical(maps.map(([destination, source]) => ({ source, destination,
    sha256: contents.has(source) ? sha(contents.get(source)) : null })))));
  const proof = { schema: 'own-local-helper-binding/1', family: family.id, sourceReferenceSHA256: family.entrySHA256,
    planSHA256, packageSHA256: pkg.sha256, expectedHostVersion: family.hostVersion, targetProfileId: family.profileId,
    sourceHostSHA256: family.appAsarSHA256, provenance: plan.provenance,
    archiveCRCVerified: true, payloadHashesVerified: true, sourceBuildAcceptanceRequiresReview: true,
    sourceBuildAcceptanceVerified: false, installReady: false, activationGranted: false, nativeEffects: false,
    ...(sourceProofMode === 'worker' ? {sourceProofMode, sourceProof: null} : {}),
    missingBindings: [...MISSING_BINDINGS, ...(sourceProofMode === 'worker' ? ['exact fresh source-proof roots/rows/epoch/host generation'] : [])], files: Object.fromEntries([...contents].map(([name, bytes]) => [name, sha(bytes)])) };
  contents.set('BINDER-PROOF.json', Buffer.from(canonical(proof))); return contents;
}
export function prepareOwnHelper({ reference, planFile, planSHA256, output, apply = false, sourceProofMode = 'cached-sync' }) {
  need(['cached-sync', 'worker'].includes(sourceProofMode), 'OWN_BINDER_INVALID_SOURCE_PROOF_MODE');
  need(typeof apply === 'boolean', 'OWN_BINDER_INVALID_ARGUMENTS');
  if (apply) need(process.platform === 'win32', 'OWN_BINDER_PUBLICATION_PLATFORM_UNSUPPORTED');
  output = absolute(output); const relativeOutput = path.relative(scratch, output);
  need(relativeOutput && relativeOutput !== '..' && !relativeOutput.startsWith('..' + path.sep)
    && !path.isAbsolute(relativeOutput) && !fs.existsSync(output), 'OWN_BINDER_NEW_OUTPUT_REQUIRED');
  need(fs.statSync(path.dirname(output)).isDirectory(), 'OWN_BINDER_OUTPUT_PARENT_REQUIRED');
  const observations = new Map();
  const unchanged = () => { for (const [file, generation] of observations) {
    ordinary(file); need(stamp(fs.lstatSync(file, { bigint: true })) === generation, 'OWN_BINDER_INPUT_CHANGED');
  } };
  const planBytes = boundedRead(planFile, LIMITS.evidenceBytes, observations);
  need(digest(planSHA256) && sha(planBytes) === planSHA256, 'OWN_BINDER_PLAN_PIN_MISMATCH');
  const plan = planValue(json(planBytes)), source = readReference(reference, observations); buildEvidence(plan, observations);
  const withinReference = path.relative(absolute(reference), output);
  need(withinReference === '..' || withinReference.startsWith('..' + path.sep) || path.isAbsolute(withinReference),
    'OWN_BINDER_OUTPUT_INSIDE_REFERENCE');
  const archive = boundedRead(plan.package.archive, LIMITS.archiveBytes, observations), inspected = inspectOwnZip(archive);
  need(['bytes', 'sha256', 'md5', 'expectedUncompressedBytes'].every(k => inspected[k] === plan.package[k])
    && sameMap(inspected.payload, plan.package.payload), 'OWN_BINDER_ARCHIVE_PROJECTION_DIFFERS');
  const contents = makeContents(plan, source, output, planSHA256, sourceProofMode);
  unchanged();
  if (apply) {
    // Windows directory rename refuses an existing target; POSIX rename can
    // replace an empty directory and is deliberately not used as no-replace.
    const parent = path.dirname(output), node = stat => `${stat.dev}:${stat.ino}`;
    const parentNode = node(fs.lstatSync(parent, { bigint: true }));
    const temp = fs.mkdtempSync(path.join(parent, '.own-helper-'));
    const tempNode = node(fs.lstatSync(temp, { bigint: true })), ownedFiles = new Map(); let published = false;
    const ownedDirectory = () => {
      ordinary(parent); ordinary(temp);
      const p = fs.lstatSync(parent, { bigint: true }), d = fs.lstatSync(temp, { bigint: true });
      need(p.isDirectory() && d.isDirectory() && node(p) === parentNode && node(d) === tempNode, 'OWN_BINDER_TEMP_CLEANUP_HELD');
    };
    const ownedFile = (name, complete) => {
      const file = path.join(temp, name), stat = fs.lstatSync(file, { bigint: true }), owned = ownedFiles.get(name), expected = contents.get(name);
      need(owned && expected && stat.isFile() && !stat.isSymbolicLink() && stamp(stat) === owned.generation
        && stat.size === BigInt(owned.bytes) && stat.size <= BigInt(expected.length)
        && (!complete || stat.size === BigInt(expected.length)), 'OWN_BINDER_PACKET_DRIFT');
      need(boundedRead(file, expected.length).equals(expected.subarray(0, owned.bytes)), 'OWN_BINDER_PACKET_DRIFT');
    };
    const generatedPacket = () => {
      ownedDirectory();
      need(JSON.stringify(fs.readdirSync(temp).sort()) === JSON.stringify([...contents.keys()].sort()), 'OWN_BINDER_PACKET_DRIFT');
      for (const name of contents.keys()) ownedFile(name, true);
    };
    const cleanup = () => {
      try {
        ownedDirectory();
        const names = fs.readdirSync(temp);
        need(JSON.stringify([...names].sort()) === JSON.stringify([...ownedFiles.keys()].sort()), 'OWN_BINDER_TEMP_CLEANUP_HELD');
        for (const name of names) ownedFile(name, false);
        for (const name of names) {
          ownedDirectory(); ownedFile(name, false);
          fs.unlinkSync(path.join(temp, name));
        }
        ownedDirectory(); fs.rmdirSync(temp);
      } catch { throw Error('OWN_BINDER_TEMP_CLEANUP_HELD'); }
    };
    try {
      for (const [name, bytes] of contents) {
        ownedDirectory(); const file = path.join(temp, name), fd = fs.openSync(file, 'wx');
        try {
          const initial = fs.fstatSync(fd, { bigint: true }); ownedFiles.set(name, { generation: stamp(initial), bytes: Number(initial.size) });
          try { fs.writeFileSync(fd, bytes); }
          finally { const current = fs.fstatSync(fd, { bigint: true }); ownedFiles.set(name, { generation: stamp(current), bytes: Number(current.size) }); }
        } finally { fs.closeSync(fd); }
      }
      verifyHelper(temp); generatedPacket(); unchanged(); ownedDirectory(); ordinary(output); need(!fs.existsSync(output), 'OWN_BINDER_NEW_OUTPUT_REQUIRED');
      fs.renameSync(temp, output); published = true;
    } finally {
      if (!published) cleanup();
    }
  }
  return { status: apply ? 'own-helper-held' : 'plan', output, files: contents.size, runtimeModules: Object.keys(JSON.parse(contents.get('reviewed.prepared.json')).modulePins).length,
    archiveCRCVerified: true, payloadHashesVerified: true, payloadFiles: inspected.payloadFiles,
    sourceBuildAcceptanceRequiresReview: true, installReady: false, activationGranted: false, nativeEffects: false,
    ...(sourceProofMode === 'worker' ? {sourceProofMode} : {}),
    missingBindings: [...MISSING_BINDINGS, ...(sourceProofMode === 'worker' ? ['exact fresh source-proof roots/rows/epoch/host generation'] : [])] };
}
export function main(args = process.argv.slice(2)) {
  const values = {};
  for (let n = 0; n < args.length; n++) {
    const name = args[n];
    if (name === '--apply' && !values.apply) values.apply = true;
    else if (['--reference', '--plan', '--plan-sha256', '--output', '--source-proof-mode'].includes(name) && !values[name] && args[n + 1]) values[name] = args[++n];
    else throw Error('OWN_BINDER_INVALID_ARGUMENTS');
  }
  return prepareOwnHelper({ reference: values['--reference'], planFile: values['--plan'], planSHA256: values['--plan-sha256'],
    output: values['--output'], sourceProofMode: values['--source-proof-mode'] ?? 'cached-sync', apply: values.apply === true });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.stdout.write(JSON.stringify(main()) + '\n'); }
  catch (error) { process.stderr.write((/^OWN_BINDER_[A-Z_]+$/.test(error.message) ? error.message : 'OWN_BINDER_PREPARATION_FAILED') + '\n'); process.exitCode = 1; }
}
