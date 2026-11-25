import paths from './paths.cjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
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

async function buildFixture(t, envOverrides = {}) {
  const prefix = path.join(os.tmpdir(), 'vortex-build-guard-');
  const root = await fs.mkdtemp(prefix);
  t.after(async () => {
    assert(path.resolve(root).startsWith(path.resolve(prefix)));
    assert((await fs.lstat(root)).isDirectory());
    await fs.rm(root, { recursive: true, force: true });
  });
  const env = { ...process.env, ...envOverrides, NEXUS_WORKSPACE: root, NEXUS_RUNTIME_WORKSPACE: root };
  const invoke = (nodeArgs, args) => spawnSync(process.execPath,
    [...nodeArgs, fileURLToPath(new URL('./build.mjs', import.meta.url)), ...args],
    { env, encoding: 'utf8', windowsHide: true });
  const run = (...args) => invoke([], args);
  const runIntercepted = async (script, ...args) => {
    const preload = path.join(root, 'build-fixture.mjs');
    await fs.writeFile(preload, script);
    return invoke(['--import', pathToFileURL(preload).href], args);
  };
  return {root, build: path.join(root, 'local-state/vortex-agent-build'), run, runIntercepted};
}

test('builder accepts exactly one phase before creating build output', async t => {
  const {root, run} = await buildFixture(t);
  for (const args of [[], ['--prepare', '--compile'], ['--prepare', '--unknown']]) {
    const result = run(...args);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Usage: build\.mjs/);
    assert.deepEqual(await fs.readdir(root), []);
  }
});

test('prepare can retry an interrupted snapshot copy without adopting the unfinished tree',
  { skip: process.platform !== 'win32' }, async t => {
    const {build, run, runIntercepted} = await buildFixture(t);
    const result = await runIntercepted(`
      import fs from 'node:fs/promises';
      const copy = fs.copyFile;
      let calls = 0;
      fs.copyFile = async (...args) => {
        if (++calls === 2) throw Error('Synthetic copy interruption');
        return copy(...args);
      };
    `, '--prepare');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Synthetic copy interruption/);
    const tree = path.join(build, 'upstream');
    await assert.rejects(fs.lstat(tree), {code: 'ENOENT'});
    const [pending] = await fs.readdir(build);
    assert.match(pending, /^upstream-pending-/);
    const retained = await fs.readdir(path.join(build, pending));
    assert.ok(retained.length > 0);
    const retry = run('--prepare');
    assert.equal(retry.status, 0, retry.stderr);
    assert.deepEqual(await fs.readdir(path.join(build, pending)), retained);
    assert.ok((await fs.lstat(path.join(tree, 'UPSTREAM-PROVENANCE.json'))).isFile());
  });

test('prepare refuses a competing empty final tree that appears at publication',
  { skip: process.platform !== 'win32' }, async t => {
    const {build, runIntercepted} = await buildFixture(t);
    const result = await runIntercepted(`
      import fs from 'node:fs/promises';
      const rename = fs.rename;
      fs.rename = async (temporary, destination) => {
        await fs.mkdir(destination);
        return rename(temporary, destination);
      };
    `, '--prepare');
    assert.notEqual(result.status, 0);
    assert.deepEqual(await fs.readdir(path.join(build, 'upstream')), []);
    const pending = (await fs.readdir(build)).find(name => name.startsWith('upstream-pending-'));
    assert.ok(pending);
    assert.ok((await fs.lstat(path.join(build, pending, 'UPSTREAM-PROVENANCE.json'))).isFile());
  });

test('non-Windows preparation retains exclusive direct creation without using directory rename', async t => {
  const {build, runIntercepted} = await buildFixture(t);
  const nonWindows = `
    import fs from 'node:fs/promises';
    if (process.platform === 'win32') Object.defineProperty(process, 'platform', {value: 'linux'});
    fs.rename = () => { throw Error('Portable prepare must not use directory rename'); };
  `;
  const result = await runIntercepted(nonWindows, '--prepare');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(await fs.readdir(build), ['upstream']);
  const provenance = path.join(build, 'upstream', 'UPSTREAM-PROVENANCE.json');
  const original = await fs.readFile(provenance);
  const retry = await runIntercepted(nonWindows, '--prepare');
  assert.notEqual(retry.status, 0);
  assert.match(retry.stderr, /Build tree already exists/);
  assert.deepEqual(await fs.readFile(provenance), original);
});

const gitContext = process.env.VORTEX_BUILD_TEST_GIT_CONTEXT;
test('prepare can retry the pinned Git fallback after checkout is interrupted',
  { skip: process.platform !== 'win32' || !gitContext }, async t => {
    assert.ok(path.isAbsolute(gitContext));
    const {build, runIntercepted} = await buildFixture(t, {NEXUS_CONTEXT_ROOT: gitContext});
    const vendor = fileURLToPath(new URL('../../../dependencies/vortex-mcp', import.meta.url));
    const withoutVendor = `
      import fs from 'node:fs/promises';
      const access = fs.access;
      fs.access = async (file, ...args) => {
        if (file === ${JSON.stringify(vendor)}) throw Object.assign(Error('No vendored snapshot'), {code: 'ENOENT'});
        return access(file, ...args);
      };
    `;
    const checkoutInterrupted = await runIntercepted(withoutVendor + `
      import childProcess from 'node:child_process';
      import { syncBuiltinESMExports } from 'node:module';
      const execFileSync = childProcess.execFileSync;
      childProcess.execFileSync = (file, args, options) => {
        if (file === 'git' && args[0] === 'checkout') throw Error('Synthetic checkout interruption');
        return execFileSync(file, args, options);
      };
      syncBuiltinESMExports();
    `, '--prepare');
    assert.notEqual(checkoutInterrupted.status, 0);
    assert.match(checkoutInterrupted.stderr, /Synthetic checkout interruption/);
    const tree = path.join(build, 'upstream');
    await assert.rejects(fs.lstat(tree), {code: 'ENOENT'});
    const [pending] = await fs.readdir(build);
    assert.match(pending, /^upstream-pending-/);
    assert.ok((await fs.lstat(path.join(build, pending, '.git'))).isDirectory());

    const retry = await runIntercepted(withoutVendor, '--prepare');
    assert.equal(retry.status, 0, retry.stderr);
    assert.deepEqual((await fs.readdir(build)).sort(), ['upstream', pending].sort());
    const head = spawnSync('git', ['rev-parse', 'HEAD'], {cwd: tree, encoding: 'utf8', windowsHide: true});
    assert.equal(head.status, 0, head.stderr);
    assert.equal(head.stdout.trim(), 'd10277b8858ad6d411765aa93131219f4a24533e');
  });

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

async function packageFixture(t) {
  const fixture = await buildFixture(t);
  const {root, build, run} = fixture;
  for (const flag of ['--prepare', '--patch']) {
    const phase = run(flag);
    assert.equal(phase.status, 0, phase.stderr);
  }
  const tree = path.join(build, 'upstream');
  const output = path.join(build, 'plugin/vortex-agent');
  const bundle = path.join(tree, 'adapted-dist/index.js');
  await fs.mkdir(path.dirname(bundle));
  await fs.writeFile(bundle, 'new fixture bundle');
  await fs.writeFile(path.join(build, 'adapted-compile.json'),
    JSON.stringify({inputs: await compileInputs(tree, root), bundleSha256: await sha(bundle)}));
  await fs.mkdir(output, {recursive: true});
  const previous = {'index.js': 'old fixture bundle', 'LICENSE.md': 'old fixture license',
    'provenance.json': '{"version":"1.1.0","evidence":"old fixture provenance"}'};
  for (const [name, value] of Object.entries(previous)) await fs.writeFile(path.join(output, name), value);
  return {...fixture, output, previous};
}

async function assertPackageFiles(directory, files) {
  assert.deepEqual((await fs.readdir(directory)).sort(), Object.keys(files).sort());
  for (const [name, contents] of Object.entries(files)) assert.equal(await fs.readFile(path.join(directory, name), 'utf8'), contents);
}

test('byte-identical packaging preserves the directory generation without retaining another copy', async t => {
  const {output, run} = await packageFixture(t);
  const first = run('--package');
  assert.equal(first.status, 0, first.stderr);
  const original = await fs.lstat(output, {bigint: true});
  const packageParent = path.dirname(output);
  const inventory = (await fs.readdir(packageParent)).sort();
  const files = Object.fromEntries(await Promise.all((await fs.readdir(output)).sort()
    .map(async name => [name, await fs.readFile(path.join(output, name), 'utf8')])));

  const repeat = run('--package');
  assert.equal(repeat.status, 0, repeat.stderr);
  const current = await fs.lstat(output, {bigint: true});
  assert.deepEqual([current.dev, current.ino], [original.dev, original.ino]);
  assert.deepEqual((await fs.readdir(packageParent)).sort(), inventory);
  await assertPackageFiles(output, files);
});

test('a package write failure keeps the prior bundle and provenance together and permits retry', async t => {
  const {output, previous, run, runIntercepted} = await packageFixture(t);
  const failed = await runIntercepted(`
    import fs from 'node:fs/promises';
    import path from 'node:path';
    const write = fs.writeFile;
    fs.writeFile = (file, ...args) => {
      if (path.basename(file) === 'LICENSE.md') throw Object.assign(Error('Synthetic package write failure'), {code: 'ENOSPC'});
      return write(file, ...args);
    };
  `, '--package');
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /Synthetic package write failure/);
  await assertPackageFiles(output, previous);
  const retry = run('--package');
  assert.equal(retry.status, 0, retry.stderr);
  const provenance = JSON.parse(await fs.readFile(path.join(output, 'provenance.json')));
  assert.equal(provenance.pluginSha256, await sha(path.join(output, 'index.js')));
  assert.equal(await fs.readFile(path.join(output, 'index.js'), 'utf8'), 'new fixture bundle');
  const holder = path.dirname(output);
  const retained = [];
  for (const name of await fs.readdir(holder)) {
    if (!name.startsWith('vortex-agent-package-pending-')) continue;
    const attempt = path.join(holder, name);
    if ((await fs.readdir(attempt)).includes('previous')) retained.push(path.join(attempt, 'previous'));
  }
  assert.equal(retained.length, 1);
  await assertPackageFiles(retained[0], previous);
});

test('known Windows package publication failure restores the exact old directory', {skip: process.platform !== 'win32'}, async t => {
  const {output, previous, runIntercepted} = await packageFixture(t);
  const original = await fs.lstat(output, {bigint: true});
  const failed = await runIntercepted(`
    import fs from 'node:fs/promises';
    import path from 'node:path';
    const rename = fs.rename;
    fs.rename = async (source, destination) => {
      if (path.basename(source) === 'next' && path.basename(destination) === 'vortex-agent')
        throw Object.assign(Error('Synthetic package rename refusal'), {code: 'EACCES'});
      return rename(source, destination);
    };
  `, '--package');
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /Synthetic package rename refusal/);
  const restored = await fs.lstat(output, {bigint: true});
  assert.deepEqual([restored.dev, restored.ino], [original.dev, original.ino]);
  await assertPackageFiles(output, previous);
});

test('Windows package publication never replaces a competing destination and keeps the old package', {skip: process.platform !== 'win32'}, async t => {
  const {output, previous, runIntercepted} = await packageFixture(t);
  const original = await fs.lstat(output, {bigint: true});
  const failed = await runIntercepted(`
    import fs from 'node:fs/promises';
    import path from 'node:path';
    const rename = fs.rename;
    fs.rename = async (source, destination) => {
      if (path.basename(source) === 'next' && path.basename(destination) === 'vortex-agent')
        await fs.mkdir(destination);
      return rename(source, destination);
    };
  `, '--package');
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /Package publication uncertain/);
  assert.deepEqual(await fs.readdir(output), []);
  const holder = path.dirname(output);
  const [name] = (await fs.readdir(holder)).filter(name => name.startsWith('vortex-agent-package-pending-'));
  const retained = path.join(holder, name, 'previous');
  await assertPackageFiles(retained, previous);
  const saved = await fs.lstat(retained, {bigint: true});
  assert.deepEqual([saved.dev, saved.ino], [original.dev, original.ino]);
  assert.equal(await fs.readFile(path.join(holder, name, 'next/index.js'), 'utf8'), 'new fixture bundle');
});

test('portable package publication uses exclusive creation and never renames onto a competing destination', async t => {
  const {output, previous, runIntercepted} = await packageFixture(t);
  const failed = await runIntercepted(`
    import fs from 'node:fs/promises';
    import path from 'node:path';
    Object.defineProperty(process, 'platform', {value: 'linux'});
    const mkdir = fs.mkdir, rename = fs.rename;
    fs.mkdir = async (target, options) => {
      if (path.basename(target) === 'vortex-agent') await mkdir(target);
      return mkdir(target, options);
    };
    fs.rename = async (source, destination) => {
      if (path.basename(destination) === 'vortex-agent') throw Error('Unexpected directory rename');
      return rename(source, destination);
    };
  `, '--package');
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /Package publication uncertain/);
  assert.deepEqual(await fs.readdir(output), []);
  const parent = path.dirname(output);
  const [name] = (await fs.readdir(parent)).filter(name => name.startsWith('vortex-agent-package-pending-'));
  await assertPackageFiles(path.join(parent, name, 'previous'), previous);
  assert.equal(await fs.readFile(path.join(parent, name, 'next/index.js'), 'utf8'), 'new fixture bundle');
});

test('all build phases hold for an existing cooperative lock without changing its owner', async t => {
  const {build, run} = await buildFixture(t);
  const lock = path.join(build, 'build-phase.lock');
  await fs.mkdir(lock, {recursive: true});
  const owner = path.join(lock, 'fixture-owner');
  await fs.writeFile(owner, 'original builder');
  for (const phase of ['--prepare', '--regression', '--patch', '--compile', '--package']) {
    const held = run(phase);
    assert.notEqual(held.status, 0);
    assert.match(held.stderr, /Build phase already active or interrupted/);
    assert.equal(await fs.readFile(owner, 'utf8'), 'original builder');
  }
  assert.deepEqual(await fs.readdir(build), ['build-phase.lock']);
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
