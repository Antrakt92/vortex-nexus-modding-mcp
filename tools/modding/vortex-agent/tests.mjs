import paths from './paths.cjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { handler, remote as httpRemote } from './bridge.mjs';
const remote = (method, params, fetcher) => httpRemote(method, params, fetcher, async () => '7'.repeat(64));
const require = createRequire(import.meta.url);
const { createOperations, safe, exclusive, stopped, identity } = require('./guard.cjs');
const { fixtureDirectory } = require('./test-fixture-directory.cjs');
const ROOT = paths.build + '/tests';
function fixture(t) {
  const dir = fixtureDirectory(t, ROOT, 'case-');
  const state = { settings: {}, persistent: { profiles: { p: { gameId: 'cyberpunk2077', modState: {} } },
    mods: { cyberpunk2077: { m: { state: 'installed' } } }, downloads: { files: {} } }, session: { base: {} } };
  let profile = 'p';
  const selectors = { activeProfileId: () => profile, activeGameId: () => 'cyberpunk2077',
    installPathForGame: () => dir, downloadPathForGame: () => dir };
  state.settings.gameMode = { discovered: { cyberpunk2077: { path: dir } } };
  const api = { getState: () => state, ext: {}, events: new EventEmitter() };
  const calls = [];
  const actions = { setModsEnabled: async (...args) => { calls.push(args); for (const id of args[2]) state.persistent.profiles.p.modState[id] = { enabled: args[3] }; } };
  const args = { gameId: 'cyberpunk2077', profileId: 'p', gamePath: dir, stagingPath: dir, downloadPath: dir, requestId: crypto.randomUUID(), modIds: ['m'], enabled: true };
  args.filesystemIds = { gamePath: identity(dir), stagingPath: identity(dir), downloadPath: identity(dir) };
  const ops = createOperations(api, actions, selectors, { receipts: path.join(dir, 'receipts'), stopped: () => {} });
  return { dir, state, api, actions, selectors, calls, args, ops, change: () => { profile = 'other'; } };
}
test('enable disables auto-deploy, verifies flags and writes external receipts', async t => {
  const f = fixture(t); const result = await f.ops.set_mods_enabled(f.args);
  assert.deepEqual(f.calls[0].slice(1), ['p', ['m'], true, { allowAutoDeploy: false, reason: 'user_manual', installed: true }]);
  assert.equal(result.enabledFlagsVerified, true); assert.equal(result.diskDeploymentVerified, false);
  await fs.access(path.join(f.dir, 'receipts', f.args.requestId + '.attempt.json'));
  await fs.access(path.join(f.dir, 'receipts', f.args.requestId + '.completion.json'));
  await assert.rejects(f.ops.set_mods_enabled(f.args), /EEXIST/);
  assert.equal(f.calls.length, 1);
});
test('stale context and wrong path prevent writes', async t => {
  const f = fixture(t); await assert.rejects(f.ops.set_mods_enabled({ ...f.args, gamePath: f.dir + '-wrong' }), /PATH_PIN/);
  f.change(); await assert.rejects(f.ops.set_mods_enabled(f.args), /STALE/); assert.equal(f.calls.length, 0);
});
test('context change during wait records uncertainty, never success', async t => {
  const f = fixture(t); f.actions.setModsEnabled = async () => f.change();
  await assert.rejects(f.ops.set_mods_enabled(f.args), /STALE/);
  const failed = JSON.parse(await fs.readFile(path.join(f.dir, 'receipts', f.args.requestId + '.failed.json')));
  assert.equal(failed.effectsMayHaveOccurred, true);
  await assert.rejects(fs.access(path.join(f.dir, 'receipts', f.args.requestId + '.completion.json')));
});
test('unretained enabled flag is rejected', async t => {
  const f = fixture(t); f.actions.setModsEnabled = async () => {};
  await assert.rejects(f.ops.set_mods_enabled(f.args), /FLAGS_UNVERIFIED/);
});
function reportDeployment(f, profileId, progress) {
  progress('Loading deployment manifest', 0);
  f.api.events.emit('mods-did-deploy', profileId, {});
  f.state.persistent.deployment = { needToDeploy: { cyberpunk2077: false } };
}
test('deploy uses the exact profile and reports operation-level result', async t => {
  const f = fixture(t);
  f.api.ext.awaitModsDeployment = async (profileId, progress, options) => {
    assert.equal(profileId, 'p');
    assert.deepEqual(options, { failOnError: true });
    reportDeployment(f, profileId, progress);
  };
  const result = await f.ops.deploy_mods(f.args);
  assert.equal(result.deploymentPromiseResolved, true); assert.equal(result.diskDeploymentVerified, false);
});
async function downloadFixture(t) {
  const f = fixture(t); const data = Buffer.from('pinned archive fixture');
  await fs.writeFile(path.join(f.dir, 'archive.zip'), data);
  const record = { game: ['cyberpunk2077'], state: 'finished', localPath: 'archive.zip', modInfo: { nexus: { ids: { modId: 42, fileId: 43 } } } };
  f.state.persistent.downloads.files.d = record;
  f.args = { ...f.args, downloadId: 'd', nexusModId: 42, nexusFileId: 43, size: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex') };
  return f;
}
test('native install is disabled, including valid pinned fresh archives', async t => {
  const f = await downloadFixture(t); let called = false;
  f.state.persistent.mods.cyberpunk2077 = {};
  f.api.events.emit = () => { called = true; };
  await assert.rejects(f.ops.install_download(f.args), /INSTALL_DISABLED/);
  assert.equal(called, false);
});
test('wrong package hash prevents install event', async t => {
  const f = await downloadFixture(t); let called = false; f.api.events.emit = () => { called = true; };
  await assert.rejects(f.ops.install_download({ ...f.args, sha256: '0'.repeat(64) }), /PIN_MISMATCH/); assert.equal(called, false);
});
test('Nexus existing-download reuse and exact download-only arguments', async t => {
  const f = await downloadFixture(t); let calls = 0;
  f.api.ext.nexusDownload = async (...args) => { calls++; assert.deepEqual(args, ['cyberpunk2077', 42, 43, undefined, false]);
    f.state.persistent.downloads.files.d = record; return 'd'; };
  const reused = await f.ops.download_nexus(f.args); assert.equal(reused.reused, true); assert.equal(calls, 0);
  const record = f.state.persistent.downloads.files.d; delete f.state.persistent.downloads.files.d;
  const fresh = await f.ops.download_nexus({ ...f.args, requestId: crypto.randomUUID() }); assert.equal(fresh.reused, false); assert.equal(calls, 1);
});
test('unsupported Windows game guard fails closed', () => {
  assert.throws(() => stopped({}, 'unknown'), /UNSUPPORTED|WINDOWS/);
});
test('Windows guard rejects game process and Vortex running-tool state', async () => {
  const module = { exports: {} };
  let tasks = ['Cyberpunk2077.exe'];
  const mockRequire = id => id === 'node:child_process' ? { spawnSync: () => ({status: 0, stderr: '', stdout: JSON.stringify({schema: 1, complete: true, count: tasks.length, names: tasks})}) } : require(id);
  vm.runInNewContext('(function(require,module,exports){' + await fs.readFile(new URL('./guard.cjs', import.meta.url), 'utf8') + '\n})', { process: { platform: 'win32', env: { SystemRoot: 'C:\\Windows' } }, Buffer })(mockRequire, module, module.exports);
  assert.throws(() => module.exports.stopped({}, 'cyberpunk2077'), /GAME_RUNNING/);
  tasks = ['Vortex.exe'];
  assert.doesNotThrow(() => module.exports.stopped({}, 'cyberpunk2077'));
  assert.throws(() => module.exports.stopped({ session: { base: { toolsRunning: { any: true } } } }, 'cyberpunk2077'), /GAME_OR_TOOL/);
});
test('unexpected unrelated enabled changes during deployment are rejected', async t => {
  const f = fixture(t); f.api.ext.awaitModsDeployment = async (profileId, progress) => {
    f.state.persistent.profiles.p.modState.unrelated = { enabled: true };
    reportDeployment(f, profileId, progress);
  };
  await assert.rejects(f.ops.deploy_mods(f.args), /OTHER_ENABLED/);
});
test('cross-process mutation exclusion', async t => {
  const dir = fixtureDirectory(t, ROOT, 'lock-'); const module = fileURLToPath(new URL('./guard.cjs', import.meta.url));
  const code = `const {exclusive}=require(${JSON.stringify(module)});exclusive(${JSON.stringify(dir)},async()=>{process.stdout.write('entered\\n');await new Promise(r=>setTimeout(r,150));process.stdout.write('leaving\\n')});`;
  const events = [];
  const children = [0, 1, 2].map(id => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', code]); child.stdout.on('data', data => { for (const s of data.toString().trim().split('\n')) events.push([id, s]); });
    let launchError;
    child.once('error', error => { launchError = error; });
    child.once('close', code => {
      if (launchError) reject(launchError);
      else if (code === 0) resolve();
      else reject(new Error('child failed'));
    });
  }));
  const outcomes = await Promise.allSettled(children);
  const failed = outcomes.find(outcome => outcome.status === 'rejected');
  if (failed) throw failed.reason;
  assert.equal(events.length, children.length * 2);
  for (let i = 0; i < events.length; i += 2) { assert.equal(events[i][1], 'entered'); assert.deepEqual(events[i + 1], [events[i][0], 'leaving']); }
});
test('a request stops attempting to acquire the shared mutation lock after its deadline', async () => {
  const source = await fs.readFile(new URL('./guard.cjs', import.meta.url), 'utf8');
  for (const delayedOpen of [false, true]) {
    let now = 0, opens = 0, actions = 0, closes = 0, unlinks = 0, writes = 0;
    const module = {exports: {}};
    const info = {dev: 1n, ino: 2n, isFile: () => true};
    const handle = {async stat() {return info;}, async writeFile() {writes++;}, async close() {closes++;}};
    const model = {
      async mkdir() {},
      async open() {
        opens++;
        if (!delayedOpen && opens === 1) throw Object.assign(Error('held'), {code: 'EEXIST'});
        now = 30000;
        return handle;
      },
      async lstat() {return info;},
      async unlink() {unlinks++;},
    };
    const mockRequire = name => name === 'node:fs/promises' ? model
      : name === 'node:perf_hooks' ? {performance: {now: () => now}}
        : require(name);
    const Wall = class extends Date {static now() {return -1000000;}};
    const context = {process, Buffer, Date: Wall, setTimeout(resolve) {now = 30000; resolve();}};
    vm.runInNewContext('(function(require,module,exports){' + source + '\n})', context)(mockRequire, module, module.exports);
    await assert.rejects(module.exports.exclusive(ROOT, () => actions++), /MUTATION_BUSY_INSPECT_RECEIPTS/);
    assert.equal(opens, 1);
    assert.deepEqual({actions, writes, closes, unlinks}, {actions: 0, writes: 0,
      closes: Number(delayedOpen), unlinks: Number(delayedOpen)});
  }
});

test('mutation cleanup preserves a different lock generation and the original operation error', async () => {
  const source = await fs.readFile(new URL('./guard.cjs', import.meta.url), 'utf8');
  for (const outcome of ['completed', 'operation_failed']) {
    const module = {exports: {}};
    const primary = new Error('PRIMARY_OPERATION_HELD');
    const original = {dev: 1n, ino: 2n, isFile: () => true};
    let closed = false, unlinked = false;
    const model = {
      async mkdir() {},
      async open() {
        return {async stat() {return original;}, async writeFile() {}, async close() {closed = true;}};
      },
      async lstat() {return {...original, ino: 3n};},
      async unlink() {
        unlinked = true;
        throw Object.assign(new Error('Secondary cleanup error'), {code: 'EPERM'});
      },
    };
    const mockRequire = name => name === 'node:fs/promises' ? model : require(name);
    vm.runInNewContext('(function(require,module,exports){' + source + '\n})', {process, Buffer})(mockRequire, module, module.exports);
    const expected = outcome === 'completed' ? /MUTATION_LOCK_CLEANUP_PENDING_RECONCILE/ : error => error === primary;
    await assert.rejects(module.exports.exclusive(ROOT, () => {
      if (outcome === 'operation_failed') throw primary;
    }), expected);
    assert.equal(closed, true);
    assert.equal(unlinked, false);
  }
});

test('legacy handshake is local; notifications silent; ids preserved; reads concurrent', async () => {
  const seen = []; const handle = handler(async (method, params) => { seen.push(method); return params.name === 'health'
    ? { content: [{ type: 'text', text: '{"protocol":"vortex-agent/1"}' }] } : { tools: [] }; });
  assert.equal((await handle({ jsonrpc: '2.0', id: 'init', method: 'initialize', params: { protocolVersion: '2024-11-05' } })).result.protocolVersion, '2024-11-05');
  assert.equal(await handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), undefined);
  assert.equal((await handle({ jsonrpc: '2.0', id: 7, method: 'tools/list' })).id, 7);
  assert.deepEqual(seen, ['tools/call', 'tools/list']);
  assert.equal((await handle({ jsonrpc: '2.0', id: 8, method: 'vortex_dispatch' })).error.code, -32601);
});
test('HTTP JSON and chunked SSE wire decoding', async () => {
  const payload = { jsonrpc: '2.0', id: 1, result: { tools: [] } };
  assert.deepEqual(await remote('tools/list', {}, async () => new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } })), { tools: [] });
  const encoded = new TextEncoder().encode('event: message\r\ndata: ' + JSON.stringify(payload) + '\r\n\r\n');
  const stream = new ReadableStream({ start(c) { for (const byte of encoded) c.enqueue(new Uint8Array([byte])); c.close(); } });
  assert.deepEqual(await remote('tools/list', {}, async () => new Response(stream, { headers: { 'content-type': 'text/event-stream' } })), { tools: [] });
});
test('bridge hides unsupported installs and rejects calls before credentials or HTTP', async () => {
  const payload = { jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'health' }, { name: 'install_download' }] } };
  const listed = await remote('tools/list', {}, async () => new Response(JSON.stringify(payload)));
  assert.deepEqual(listed.tools.map(t => t.name), ['health']);
  await assert.rejects(httpRemote('tools/call', { name: 'install_download', arguments: {} },
    async () => assert.fail('HTTP must not be invoked'), async () => assert.fail('Credential must not be read')), /unsupported/);
});
test('wrong endpoint and unavailable Vortex yield actionable errors', async () => {
  const handle = handler(async () => ({ content: [{ type: 'text', text: '{}' }] }));
  assert.match((await handle({ jsonrpc: '2.0', id: 1, method: 'initialize' })).error.message, /Wrong server/);
  await assert.rejects(remote('tools/list', {}, async () => { throw new Error('private-url'); }), /Start Vortex/);
});
test('output redacts credentials and URLs', () => {
  const result = safe({ apiKey: 'secret', message: 'see https://example.test/?token=secret', url: 'secret' });
  assert.ok(!JSON.stringify(result).includes('secret'));
  const hidden = safe({ text: 'credential-is-private embedded' }, { getState: () => ({ confidential: { key: 'credential-is-private' } }) });
  assert.ok(!hidden.text.includes('credential-is-private'));
});
