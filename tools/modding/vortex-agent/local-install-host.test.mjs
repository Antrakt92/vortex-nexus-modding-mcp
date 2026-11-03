import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import host from './local-install-host.cjs';

const sha = value => crypto.createHash('sha256').update(value).digest('hex');
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'local-install-host-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const packagePath = path.join(root, 'app.asar'), plugin = path.join(root, 'plugin');
  await fs.mkdir(plugin);
  await fs.writeFile(packagePath, 'reviewed official host');
  await fs.writeFile(path.join(plugin, 'index.js'), 'reviewed entry');
  await fs.writeFile(path.join(plugin, 'helper.js'), 'reviewed imported helper');
  const expected = { appAsarSha256: sha('reviewed official host'), dynamic: [{ path: plugin, files: [
    { path: 'index.js', sha256: sha('reviewed entry') },
    { path: 'helper.js', sha256: sha('reviewed imported helper') },
  ] }] };
  let extensions = [{ path: plugin, dynamic: true }], opened = 0;
  const api = { getLoadedExtensions: () => extensions };
  const fsImpl = { ...fs, open: async (...args) => { opened++; return fs.open(...args); } };
  const make = overrides => host.createLocalInstallHostAdmission({ packagePath, expected, api, fsImpl, ...overrides });
  return { root, packagePath, plugin, expected, api, make,
    opened: () => opened, setExtensions: value => { extensions = value; } };
}

test('reviews explicit source closure once and reuses hash only for matching generations', async t => {
  const f = await fixture(t), admit = f.make();
  const first = await admit();
  assert.equal(first.dynamicExtensions, 1);
  assert.equal(first.sources.length, 3);
  assert.equal(f.opened(), 3);
  assert.deepEqual(await admit(), first);
  assert.equal(f.opened(), 3);
  const temporary = path.join(f.plugin, 'replacement');
  await fs.writeFile(temporary, 'reviewed imported helper');
  await fs.rename(temporary, path.join(f.plugin, 'helper.js'));
  const replaced = await admit();
  assert.equal(f.opened(), 4);
  assert.notEqual(replaced.sources[2].generation, first.sources[2].generation);
});

test('host or imported helper drift refuses admission after a successful cached check', async t => {
  const f = await fixture(t), admit = f.make();
  await admit();
  await fs.writeFile(path.join(f.plugin, 'helper.js'), 'unreviewed executable code');
  await assert.rejects(admit(), /SOURCE_HASH_MISMATCH/);
  await fs.writeFile(path.join(f.plugin, 'helper.js'), 'reviewed imported helper');
  await fs.writeFile(f.packagePath, 'different official host');
  await assert.rejects(admit(), /SOURCE_HASH_MISMATCH/);
});

test('supports explicitly pinned CommonJS entrypoints used by bundled extensions', async t => {
  const f = await fixture(t);
  await fs.rename(path.join(f.plugin, 'index.js'), path.join(f.plugin, 'index.cjs'));
  f.expected.dynamic[0].files[0].path = 'index.cjs';
  const proof = await f.make()();
  assert.equal(proof.dynamicExtensions, 1);
  assert.ok(proof.sources.some(source => source.path.endsWith('index.cjs')));
});

test('accepts a bounded explicit source manifest for more than 32 loaded extensions', async t => {
  const f = await fixture(t), dynamic = [], extensions = [];
  for (let index = 0; index < 33; index++) {
    const plugin = path.join(f.root, 'reviewed-plugin-' + index);
    await fs.mkdir(plugin);
    await fs.writeFile(path.join(plugin, 'index.cjs'), 'reviewed extension');
    dynamic.push({ path: plugin, files: [{ path: 'index.cjs', sha256: sha('reviewed extension') }] });
    extensions.push({ path: plugin, dynamic: true });
  }
  f.setExtensions(extensions);
  const proof = await f.make({ expected: { ...f.expected, dynamic } })();
  assert.equal(proof.dynamicExtensions, 33);
  assert.equal(proof.sources.length, 34);
  assert.throws(() => f.make({ expected: { ...f.expected, dynamic: Array(257).fill(dynamic[0]) } }),
    /BINDING_INVALID/);
});

test('unknown dynamic extensions refuse even when their entrypoint happens to match', async t => {
  const f = await fixture(t), admit = f.make();
  f.setExtensions([{ path: f.root, dynamic: true }]);
  await assert.rejects(admit(), /UNKNOWN_EXTENSION/);
  assert.equal(f.opened(), 0);
});

test('does not trust client-mutated bindings after creation', async t => {
  const f = await fixture(t), admit = f.make();
  f.expected.appAsarSha256 = sha('unreviewed host');
  f.expected.dynamic[0].files[0].sha256 = sha('unreviewed entry');
  await fs.writeFile(f.packagePath, 'unreviewed host');
  await assert.rejects(admit(), /SOURCE_HASH_MISMATCH/);
});

test('extension list change while source is read refuses the operation', async t => {
  const f = await fixture(t);
  let calls = 0;
  const api = { getLoadedExtensions() {
    return ++calls === 1 ? [{ path: f.plugin, dynamic: true }] : [];
  } };
  await assert.rejects(f.make({ api })(), /EXTENSIONS_CHANGED/);
});

test('a file modified during hashing cannot produce an admitted generation', async t => {
  const f = await fixture(t);
  let changed = false;
  const fsImpl = { ...fs, async open(target, flags) {
    const handle = await fs.open(target, flags);
    return { stat: (...args) => handle.stat(...args), close: () => handle.close(),
      async read(...args) {
        const result = await handle.read(...args);
        if (!changed) {
          changed = true;
          await fs.writeFile(target, 'changed while source hash was being read');
        }
        return result;
      } };
  } };
  await assert.rejects(f.make({ fsImpl })(), /SOURCE_CHANGED/);
});

test('symlink source and source directories are refused', async t => {
  const f = await fixture(t), outside = path.join(f.root, 'outside');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'index.js'), 'reviewed entry');
  const linked = path.join(f.root, 'linked');
  await fs.symlink(outside, linked, 'junction');
  const expected = { ...f.expected, dynamic: [{ path: linked,
    files: [{ path: 'index.js', sha256: sha('reviewed entry') }] }] };
  f.setExtensions([{ path: linked, dynamic: true }]);
  await assert.rejects(f.make({ expected })(), /REPARSE_PATH/);
});

test('invalid bindings and unavailable or malformed loaded-extension inventory refuse', async t => {
  const f = await fixture(t);
  const expected = { ...f.expected, dynamic: [{ path: f.plugin,
    files: [{ path: '../outside.js', sha256: sha('x') }] }] };
  assert.throws(() => f.make({ expected }), /BINDING_INVALID/);
  assert.throws(() => f.make({ api: {} }), /BINDING_INVALID/);
  f.setExtensions([{ path: f.plugin }]);
  await assert.rejects(f.make()(), /EXTENSIONS_UNAVAILABLE/);
});
