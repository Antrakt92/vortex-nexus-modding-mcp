import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import manifest from './stock-vortex-2.9.1-admission.json' with { type: 'json' };

function fixture() {
  const app = path.resolve('fixture-host/Vortex.exe'), own = path.resolve('fixture-user/plugins/vortex-agent');
  const userData = path.resolve('fixture-user'), ownHash = 'a'.repeat(64), calls = [];
  const known = manifest.extensions.find(e => e.kind === 'bundled');
  const loaded = [{ dynamic: true, path: own }, { dynamic: true,
    path: path.join(path.dirname(app), 'resources/app.asar.unpacked/bundledPlugins', known.folder) }];
  const api = { getLoadedExtensions: () => loaded }, module = { exports: {} };
  const sandbox = { module, exports: module.exports, process: { execPath: app }, __dirname: own,
    require(name) {
      if (name === 'node:path') return path;
      if (name === 'node:fs') return { readFileSync(file) {
        assert.equal(file, path.join(own, 'provenance.json'));
        return JSON.stringify({ pluginSha256: ownHash });
      } };
      if (name === 'original-fs') return { promises: {} };
      if (name === './stock-vortex-2.9.1-admission.json') return manifest;
      if (name === './local-install-host.cjs') return { createLocalInstallHostAdmission(binding) {
        calls.push(binding); return async () => ({ dynamicExtensions: binding.expected.dynamic.length });
      } };
      throw Error('Unexpected dependency ' + name);
    } };
  vm.runInNewContext(fs.readFileSync(new URL('./local-install-binding.cjs', import.meta.url), 'utf8'), sandbox);
  const read = override => module.exports.localInstallAdmission(api, { getVortexPath: id => {
    assert.equal(id, 'userData'); return userData;
  } }, override);
  return { app, own, loaded, calls, read, known, ownHash };
}

test('binds shipped reviewed sources to the running host and actual own installed provenance', async () => {
  const f = fixture(); await f.read()();
  const binding = f.calls[0];
  assert.equal(binding.packagePath, path.join(path.dirname(f.app), 'resources/app.asar'));
  assert.equal(binding.expected.appAsarSha256, manifest.appAsarSha256);
  assert.equal(binding.expected.dynamic[0].path, f.own);
  assert.equal(binding.expected.dynamic[0].files[0].sha256, f.ownHash);
  assert.equal(binding.expected.dynamic[1].files, f.known.files);
  await f.read()(); assert.equal(f.calls.length, 1);
});

test('unknown loaded extension cannot become admitted by discovery alone', async () => {
  const f = fixture(); f.loaded.push({ dynamic: true, path: path.resolve('fixture-user/plugins/unknown') });
  await assert.rejects(f.read()(), /LOCAL_INSTALL_HOST_UNKNOWN_EXTENSION/);
  assert.equal(f.calls.length, 0);
});

test('authentic host hash from another path cannot attest the running package', async () => {
  const f = fixture();
  await assert.rejects(f.read({ packagePath: path.resolve('retained-copy/app.asar'), expected: {
    appAsarSha256: manifest.appAsarSha256, dynamic: [] } })(), /LOCAL_INSTALL_HOST_RUNTIME_PATH_MISMATCH/);
  assert.equal(f.calls.length, 0);
});

test('internal binding cannot authorize an unreviewed official-host generation', async () => {
  const f = fixture();
  await assert.rejects(f.read({ packagePath: path.join(path.dirname(f.app), 'resources/app.asar'), expected: {
    appAsarSha256: 'b'.repeat(64), dynamic: [] } })(), /LOCAL_INSTALL_HOST_UNREVIEWED_VERSION/);
  assert.equal(f.calls.length, 0);
});
