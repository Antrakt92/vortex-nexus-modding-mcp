import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import fixtures from './test-fixture-directory.cjs';

const bridge = fileURLToPath(new URL('./bridge.mjs', import.meta.url));
const credential = new URL('./credential.cjs', import.meta.url).href;
const preload = `
import credential from ${JSON.stringify(credential)};
credential.readToken = async () => {
  process.stderr.write('fixture credential read\\n');
  return 'synthetic fixture token';
};
globalThis.fetch = async (_url, options) => {
  const {id, params} = JSON.parse(options.body);
  const value = params.name === 'health' ? {protocol: 'vortex-agent/1'} : params.arguments;
  return new Response(JSON.stringify({jsonrpc: '2.0', id, result: {content: [{type: 'text', text: JSON.stringify(value)}]}}));
};
`;
const call = (args, seam = '') => spawnSync(process.execPath,
  ['--import', 'data:text/javascript,' + encodeURIComponent(preload + seam), bridge, ...args],
  {encoding: 'utf8', timeout: 5000, windowsHide: true});

test('bridge CLI forwards exact UTF-8 arguments from a bounded ordinary file', t => {
  const root = fixtures.fixtureDirectory(t, os.tmpdir(), 'vortex-bridge-cli-');
  const file = path.join(root, 'tool arguments.json');
  const value = {gameId: 'cyberpunk2077', modIds: ['мод "exact"', 'Other']};
  const text = JSON.stringify(value);
  const bound = 1024 * 1024;
  fs.writeFileSync(file, text + ' '.repeat(bound - Buffer.byteLength(text)), 'utf8');
  const result = call(['--call', 'read_mod_lifecycle', '--args-file', file]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(JSON.parse(result.stdout).content[0].text), value);
  assert.equal(result.stderr, 'fixture credential read\n'.repeat(2));
});

test('bridge CLI rejects invalid argument files and legacy stripped JSON before transport', t => {
  const root = fixtures.fixtureDirectory(t, os.tmpdir(), 'vortex-bridge-cli-');
  const file = path.join(root, 'args.json');
  const refuse = (args, diagnostic) => {
    const result = call(['--call', 'read_mod_lifecycle', ...args]);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, diagnostic);
    assert.doesNotMatch(result.stderr, /fixture credential read/);
  };
  refuse(['{gameId:cyberpunk2077}'], /Invalid MCP JSON payload/);
  refuse(['--args-file'], /Usage: bridge/);
  refuse(['--args-file', file, 'extra'], /Usage: bridge/);
  refuse(['--args-file', root], /ordinary arguments file/);
  refuse(['--args-file', file], /ordinary arguments file/);
  for (const [data, error] of [
    ['{"gameId":1,"gameId":2}', /Invalid MCP JSON payload/],
    ['null', /JSON object/], ['[]', /JSON object/],
    [Buffer.from([0xff]), /Invalid MCP JSON payload/],
    [Buffer.from('\ufeff{"gameId":"cyberpunk2077"}', 'utf16le'), /Invalid MCP JSON payload/],
    [Buffer.alloc(1024 * 1024 + 1, 32), /ordinary arguments file/],
  ]) {
    fs.writeFileSync(file, data);
    refuse(['--args-file', file], error);
  }
});

test('argument-file descriptor close failures give the same bounded diagnostic before transport', t => {
  const root = fixtures.fixtureDirectory(t, os.tmpdir(), 'vortex-bridge-cli-');
  const file = path.join(root, 'args.json');
  fs.writeFileSync(file, '{}');
  const result = call(['--call', 'read_mod_lifecycle', '--args-file', file], `
    import fs from 'node:fs/promises';
    const open = fs.open;
    fs.open = async (...args) => {
      const handle = await open(...args);
      const close = handle.close.bind(handle);
      handle.close = async () => {
        await close();
        throw Error('synthetic private descriptor diagnostic');
      };
      return handle;
    };
  `);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /ordinary arguments file/);
  assert.doesNotMatch(result.stderr, /synthetic private descriptor diagnostic|fixture credential read/);
});

test('argument-file reads refuse an ancestor alias or replacement at the literal path', async t => {
  const root = fixtures.fixtureDirectory(t, os.tmpdir(), 'vortex-bridge-cli-');
  const ordinary = path.join(root, 'ordinary'), alias = path.join(root, 'alias');
  fs.mkdirSync(ordinary);
  fs.symlinkSync(ordinary, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const file = path.join(ordinary, 'args.json'), replacement = path.join(ordinary, 'replacement.json');
  fs.writeFileSync(file, '{}');
  fs.writeFileSync(replacement, '{}');
  const refuse = (filename, seam) => {
    const result = call(['--call', 'read_mod_lifecycle', '--args-file', filename], seam);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /ordinary arguments file/);
    assert.doesNotMatch(result.stderr, /fixture credential read/);
  };
  await t.test('ancestor alias', () => refuse(path.join(alias, 'args.json')));
  await t.test('literal path replacement while its original descriptor is open', () => refuse(file, `
    import fs from 'node:fs/promises';
    const selected = ${JSON.stringify(file)}, replacement = ${JSON.stringify(replacement)};
    const open = fs.open, lstat = fs.lstat;
    let readFinished = false;
    fs.open = async (filename, ...args) => {
      const handle = await open(filename, ...args);
      if (filename === selected) {
        const read = handle.read.bind(handle);
        handle.read = async (...parts) => {
          const result = await read(...parts);
          readFinished = true;
          return result;
        };
      }
      return handle;
    };
    fs.lstat = (filename, ...args) => lstat(filename === selected && readFinished ? replacement : filename, ...args);
  `));
});
