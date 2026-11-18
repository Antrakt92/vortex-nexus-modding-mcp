import paths from './paths.cjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { compileInputs, runtimeWorkspace } from './build.mjs';
const ROOT = paths.build;
const sha = async file => crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');
test('packaged entrypoint and source/lockfile provenance match verified isolated build', async () => {
  const plugin = path.join(ROOT, 'plugin/vortex-agent');
  const provenance = JSON.parse(await fs.readFile(path.join(plugin, 'provenance.json'), 'utf8'));
  const compileReceipt = JSON.parse(await fs.readFile(path.join(ROOT, 'adapted-compile.json'), 'utf8'));
  assert.equal(provenance.workspaceRoot, runtimeWorkspace());
  assert.equal(compileReceipt.inputs.workspaceRoot, provenance.workspaceRoot);
  assert.equal(await sha(path.join(plugin, 'index.js')), provenance.pluginSha256);
  assert.equal(await sha(path.join(ROOT, 'upstream/adapted-dist/index.js')), provenance.pluginSha256);
  assert.equal(await sha(path.join(ROOT, 'upstream/pnpm-lock.yaml')), provenance.lockfileSha256);
  for (const [name, hash] of Object.entries(provenance.sources)) assert.equal(await sha(path.join(provenance.maintainedSource, name)), hash, name);
  assert.equal(provenance.installSupported, false);
  assert.equal(provenance.version, '1.1.0'); assert.equal(provenance.receiptVersion, 2);
  assert.equal(await sha(path.join(ROOT, 'upstream/src/vortexControl.ts')), provenance.upstreamControlSha256);
  for (const name of Object.keys(provenance.sources).filter(name => name.endsWith('.cjs'))) assert.equal(await sha(path.join(ROOT, 'upstream/src', name)), provenance.sources[name]);
  assert.equal(provenance.authentication, 'Windows-DPAPI-CurrentUser-bearer');
  assert.equal(provenance.vortexSourceCommit, '41be6d4556568a605d6131b8c5ca90ff26dec6ac');
  assert.equal(JSON.parse(await fs.readFile(path.join(plugin, 'info.json'), 'utf8')).version, provenance.version);
  assert.deepEqual((await fs.readdir(plugin)).sort(), ['LICENSE.md', 'THIRD-PARTY-NOTICES.md', 'index.js', 'info.json', 'provenance.json'].sort());
  assert.equal(provenance.packageSchemaVersion, 2);
  assert.deepEqual(Object.keys(provenance.licenseFileSHA256).sort(), ['LICENSE.md', 'THIRD-PARTY-NOTICES.md']);
  for (const [name, hash] of Object.entries(provenance.licenseFileSHA256)) {
    assert.equal(await sha(path.join(plugin, name)), hash);
    assert.equal(await sha(path.join(ROOT, 'upstream', name)), hash);
  }
  assert.equal(provenance.sourceOffer.repository, 'https://github.com/Antrakt92/vortex-nexus-modding-mcp');
});

async function buildFixture(t) {
  const prefix = path.join(os.tmpdir(), 'vortex-build-guard-');
  const root = await fs.mkdtemp(prefix);
  t.after(async () => {
    assert(path.resolve(root).startsWith(path.resolve(prefix)));
    assert((await fs.lstat(root)).isDirectory());
    await fs.rm(root, { recursive: true, force: true });
  });
  const env = { ...process.env, NEXUS_WORKSPACE: root, NEXUS_RUNTIME_WORKSPACE: root };
  const run = flag => spawnSync(process.execPath, [fileURLToPath(new URL('./build.mjs', import.meta.url)), flag],
    { env, encoding: 'utf8', windowsHide: true });
  return {root, build: path.join(root, 'local-state/vortex-agent-build'), run};
}

test('build refusal preserves files aliased to a generated regression fixture', async t => {
  const {root, build, run} = await buildFixture(t);
  const keeper = path.join(root, 'unrelated.ts');
  const copy = path.join(build, 'upstream/src/regression.test.ts');
  await fs.mkdir(path.dirname(copy), { recursive: true });
  await fs.writeFile(keeper, 'protected bytes');
  await fs.link(keeper, copy);
  const result = run('--regression');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Build hardlink path refused/);
  assert.equal(await fs.readFile(keeper, 'utf8'), 'protected bytes');
});

test('package preflight preserves the prior package when frozen compile sources differ from maintained sources', async t => {
  const {root, build, run} = await buildFixture(t);
  for (const flag of ['--prepare', '--patch']) {
    const phase = run(flag);
    assert.equal(phase.status, 0, phase.stderr);
  }
  const tree = path.join(build, 'upstream');
  const previous = path.join(build, 'plugin/vortex-agent');
  const bundle = path.join(tree, 'adapted-dist/index.js');
  await fs.mkdir(previous, { recursive: true });
  await fs.writeFile(path.join(previous, 'index.js'), 'prior usable bundle');
  await fs.writeFile(path.join(previous, 'provenance.json'), '{"version":"1.1.0"}');
  await fs.mkdir(path.dirname(bundle));
  await fs.writeFile(bundle, 'new bundle');
  await fs.writeFile(path.join(tree, 'src/guard.cjs'), 'different input frozen by this build');
  await fs.writeFile(path.join(build, 'adapted-compile.json'),
    JSON.stringify({inputs: await compileInputs(tree, root), bundleSha256: await sha(bundle)}));
  const result = run('--package');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Build copy differs: guard\.cjs/);
  assert.deepEqual((await fs.readdir(previous)).sort(), ['index.js', 'provenance.json']);
  assert.equal(await fs.readFile(path.join(previous, 'index.js'), 'utf8'), 'prior usable bundle');
});

test('packaging refuses an existing output with unrelated contents before writing files', async t => {
  const {root, build, run} = await buildFixture(t);
  for (const flag of ['--prepare', '--patch']) {
    const phase = run(flag);
    assert.equal(phase.status, 0, phase.stderr);
  }
  const tree = path.join(build, 'upstream');
  const bundle = path.join(tree, 'adapted-dist/index.js');
  const plugin = path.join(build, 'plugin/vortex-agent');
  await fs.mkdir(path.dirname(bundle));
  await fs.writeFile(bundle, 'new bundle');
  await fs.writeFile(path.join(build, 'adapted-compile.json'),
    JSON.stringify({inputs: await compileInputs(tree, root), bundleSha256: await sha(bundle)}));
  await fs.mkdir(plugin, {recursive: true});
  await fs.writeFile(path.join(plugin, 'index.js'), 'previous bundle');
  await fs.writeFile(path.join(plugin, 'notes.txt'), 'keep my notes');

  const result = run('--package');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unexpected package output: notes\.txt/);
  assert.deepEqual((await fs.readdir(plugin)).sort(), ['index.js', 'notes.txt']);
  assert.equal(await fs.readFile(path.join(plugin, 'index.js'), 'utf8'), 'previous bundle');
  assert.equal(await fs.readFile(path.join(plugin, 'notes.txt'), 'utf8'), 'keep my notes');
});

test('legacy rollback provenance refuses traversal before making any archive', async t => {
  const {root, build, run} = await buildFixture(t);
  const plugin = path.join(build, 'plugin/vortex-agent');
  await fs.mkdir(plugin, { recursive: true });
  await fs.writeFile(path.join(plugin, 'index.js'), 'prior usable bundle');
  const pluginSha256 = await sha(path.join(plugin, 'index.js'));
  const pin = 'a'.repeat(64);
  for (const [metadata, code] of [
    [{version: '../../../escaped', sources: {'guard.cjs': pin}}, /Unsupported previous package provenance/],
    [{version: '1.0.4', sources: {'../../../../escaped.cjs': pin}}, /Invalid previous package source provenance/],
  ]) {
    await fs.writeFile(path.join(plugin, 'provenance.json'), JSON.stringify({...metadata, pluginSha256}));
    const result = run('--patch');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, code);
    await assert.rejects(fs.stat(path.join(build, 'archives')), {code: 'ENOENT'});
    assert.deepEqual(await fs.readdir(root), ['local-state']);
  }
});

test('legacy archive preserves exact build inputs and refuses reuse if the archive is incomplete', async t => {
  const {build, run} = await buildFixture(t);
  for (const flag of ['--prepare', '--patch']) {
    const phase = run(flag);
    assert.equal(phase.status, 0, phase.stderr);
  }
  const plugin = path.join(build, 'plugin/vortex-agent');
  const compiled = path.join(build, 'upstream/adapted-dist');
  for (const directory of [plugin, compiled]) {
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, 'index.js'), 'prior usable bundle');
  }
  const pluginSha256 = await sha(path.join(plugin, 'index.js'));
  const guard = await sha(path.join(build, 'upstream/src/guard.cjs'));
  await fs.writeFile(path.join(plugin, 'provenance.json'),
    JSON.stringify({version: '1.0.4', pluginSha256, sources: {'guard.cjs': guard}}));
  const archive = path.join(build, 'archives', '1.0.4-' + pluginSha256);
  const extra = path.join(plugin, 'notes.txt');
  await fs.writeFile(extra, 'keep with the candidate');
  const refused = run('--patch');
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /Unexpected package output: notes\.txt/);
  await assert.rejects(fs.stat(archive), { code: 'ENOENT' });
  assert.equal(await fs.readFile(extra, 'utf8'), 'keep with the candidate');
  await fs.unlink(extra);
  for (let n = 0; n < 2; n++) {
    const result = run('--patch');
    assert.equal(result.status, 0, result.stderr);
  }
  assert.equal(await sha(path.join(archive, 'src/guard.cjs')), guard);
  assert.equal(await sha(path.join(archive, 'adapted-dist/index.js')), pluginSha256);
  await fs.unlink(path.join(archive, 'src/guard.cjs'));
  const result = run('--patch');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Previous archive incomplete or mismatched/);
  assert.equal(await sha(path.join(plugin, 'index.js')), pluginSha256);
});
