'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const SID = 'S-1-5-21-123';
const PROTECTED = Buffer.from('synthetic encrypted bytes').toString('base64');
const SYSTEM_ROOT = String.raw`D:\Windows`;

async function fixture(t, env = { SystemRoot: SYSTEM_ROOT, PATH: String.raw`C:\ModelTools` }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vortex-credential-test-'));
  t.after(async () => {
    for (const entry of await fs.readdir(root)) await fs.unlink(path.join(root, entry));
    await fs.rmdir(root);
  });
  const commands = [];
  let aclApplied = false, failProtect = false, failSync = false;
  const mockedFs = { ...fs, async open(...args) {
    assert.equal(aclApplied, true);
    const handle = await fs.open(...args);
    return {
      writeFile: (...args) => handle.writeFile(...args),
      close: () => handle.close(),
      async sync() {
        if (failSync) throw new Error('synthetic sync failure');
        await handle.sync();
      },
    };
  } };
  const mockChildProcess = { execFileSync(executable, args, options) {
    commands.push({ executable, args, options });
    const script = Buffer.from(args[3], 'base64').toString('utf16le');
    if (script.includes('::Protect(')) {
      assert.equal(aclApplied, true);
      if (failProtect) throw new Error('synthetic protection failure');
      return PROTECTED;
    }
    if (script.includes('SetAccessControl')) { aclApplied = true; return ''; }
    if (script.includes('GetCurrent().User.Value')) return SID;
    throw new Error('Unexpected PowerShell operation');
  } };
  const source = await fs.readFile(path.join(__dirname, 'credential.cjs'), 'utf8');
  const load = vm.runInNewContext('(function(require, module, process){' + source + '\n})', { Buffer });
  const module = { exports: {} };
  load(id => id === 'node:fs/promises' ? mockedFs : id === 'node:child_process' ? mockChildProcess : require(id),
    module, { platform: 'win32', env });
  return {
    initialize: () => module.exports.initialize(root),
    protect: value => module.exports.protect(value),
    readToken: () => module.exports.readToken(root),
    commands,
    setFailure: (protect, sync) => { failProtect = protect; failSync = sync; },
    entries: () => fs.readdir(root),
    blob: () => fs.readFile(path.join(root, SID + '.dpapi'), 'utf8'),
  };
}

test('credential PowerShell uses validated absolute Windows executable, even when PATH is configured', async t => {
  const f = await fixture(t);
  await f.initialize();
  assert.equal(f.commands.length, 3);
  for (const { executable, args, options } of f.commands) {
    assert.equal(executable, String.raw`D:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`);
    assert.deepEqual([...args.slice(0, 3)], ['-NoProfile', '-NonInteractive', '-EncodedCommand']);
    assert.equal(args.length, 4);
    assert.equal(options.timeout, 20_000);
    assert.deepEqual([...options.stdio], ['pipe', 'pipe', 'pipe']);
  }
  const protection = f.commands.at(-1);
  assert.match(protection.options.input, /^[a-f0-9]{64}$/);
  assert.equal(protection.args.some(arg => arg.includes(protection.options.input)), false);
});

test('missing or noncanonical SystemRoot refuses DPAPI before any subprocess', async t => {
  for (const root of [undefined, 'Windows', String.raw`D:\Windows\..\Windows`, String.raw`\\server\Windows`]) {
    const f = await fixture(t, { SystemRoot: root, PATH: String.raw`C:\ModelTools` });
    assert.throws(() => f.protect('synthetic value'), /DPAPI_CREDENTIAL_OPERATION_FAILED/);
    await assert.rejects(f.initialize(), /DPAPI_CREDENTIAL_OPERATION_FAILED/);
    await assert.rejects(f.readToken(), /CREDENTIAL_NOT_INITIALIZED_RUN_CREDENTIAL_HELPER/);
    assert.equal(f.commands.length, 0);
    assert.deepEqual(await f.entries(), []);
  }
});

for (const [point, protect, sync, message] of [
  ['DPAPI', true, false, /DPAPI_CREDENTIAL_OPERATION_FAILED/],
  ['fsync', false, true, /synthetic sync failure/],
]) test(`credential initialization can retry after a ${point} failure`, async t => {
  const f = await fixture(t);
  f.setFailure(protect, sync);
  await assert.rejects(f.initialize(), message);
  assert.deepEqual(await f.entries(), []);
  f.setFailure(false, false);
  await f.initialize();
  assert.equal(await f.blob(), PROTECTED);
  assert.deepEqual(await f.entries(), [SID + '.dpapi']);
});

test('concurrent credential initializers and repeats leave one intact credential', async t => {
  const f = await fixture(t);
  const outcomes = await Promise.allSettled([f.initialize(), f.initialize()]);
  assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(outcomes.find(result => result.status === 'rejected').reason.code, 'EEXIST');
  await assert.rejects(f.initialize(), { code: 'EEXIST' });
  assert.equal(await f.blob(), PROTECTED);
  assert.deepEqual(await f.entries(), [SID + '.dpapi']);
});
