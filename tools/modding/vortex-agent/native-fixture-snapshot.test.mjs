import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { ORDINARY_MOD_LIMIT, assertOrdinaryModSnapshot, ordinaryProcessesPreserved, stoppedOrdinaryCohort } from './native-fixture-snapshot.mjs';

test('ordinary process preservation rejects PID reuse, missing generations and changed identities', () => {
  const row = {pid:123,parent:1,exe:'C:/Vortex.exe',type:'',generation:'639000000000000000'};
  assert.equal(ordinaryProcessesPreserved([row],[{...row}]),true);
  for (const changed of [{generation:'639000000000000001'},{generation:undefined},{exe:'foreign'},
    {parent:2},{type:'helper'},{pid:124}]) assert.equal(ordinaryProcessesPreserved([row],[{...row,...changed}]),false);
  assert.equal(ordinaryProcessesPreserved([row],[row,row]),false);
  assert.equal(ordinaryProcessesPreserved([],[]),false);
});

function runnerSnapshot(count) {
  const source = fs.readFileSync(new URL('./native-fixture.mjs', import.meta.url), 'utf8');
  const body = source.slice(source.indexOf('async function snapshot()'), source.indexOf('async function main()'));
  const mods = Array.from({ length: count }, (_, index) => ({ id: 'mod_' + index }));
  const context = {
    tool: async name => name === 'health' ? { gamePath: 'C:/synthetic-game' }
      : name === 'list_mods' ? mods : [],
    fs: { readFileSync: () => Buffer.from('synthetic manifest') }, path,
    sha: () => 'synthetic hash', processes: () => [],
    ORDINARY_MOD_LIMIT, assertOrdinaryModSnapshot,
  };
  return vm.runInNewContext(body + '; snapshot()', context);
}

test('native fixture refuses capped ordinary inventories before claiming preservation', async () => {
  for (const count of [500, 501]) {
    await assert.rejects(runnerSnapshot(count), /ORDINARY_MOD_INVENTORY_INCOMPLETE/);
  }
});

test('empty and under-limit inventories remain usable for modeled preservation checks', async () => {
  for (const count of [0, 1, 499]) {
    const snapshot = await runnerSnapshot(count);
    assert.equal(snapshot.mods.length, count);
  }
});

test('malformed and duplicate identities cannot masquerade as a complete snapshot', () => {
  for (const mods of [undefined, null, {}, [null], [[]], [{}], [{ id: '' }],
    [{ id: 1 }], [{ id: 'same' }, { id: 'same' }]]) {
    assert.throws(() => assertOrdinaryModSnapshot(mods), /ORDINARY_MOD_INVENTORY_INVALID/);
  }
});

test('a capped legacy receipt is also refused by the independent verifier', () => {
  const source = fs.readFileSync(new URL('./native-fixture-verify.mjs', import.meta.url), 'utf8');
  const start = source.indexOf("const before = read('ordinary-before.json')");
  const end = source.indexOf('const log =', start);
  const code = source.slice(start, end);
  const complete = { mods: [{ id: 'own' }], health: {}, profiles: [], manifestSha256: 'same' };
  for (const cappedSide of ['ordinary-before.json', 'ordinary-after.json']) {
    const context = { assert, assertOrdinaryModSnapshot, ordinaryProcessesPreserved,
      read: name => name === cappedSide ? { ...complete,
        mods: Array.from({ length: ORDINARY_MOD_LIMIT }, (_, index) => ({ id: 'mod_' + index })) } : complete };
    assert.throws(() => vm.runInNewContext(code, context), /ORDINARY_MOD_INVENTORY_INCOMPLETE/);
  }
});

test('stopped ordinary admits only no host or the separately spawned fixture cohort', () => {
  const main = { pid: 100, type: '' };
  const helper = { pid: 101, type: 'helper' };
  const unexpected = { pid: 200, type: '' };
  assert.equal(stoppedOrdinaryCohort([]), true);
  assert.equal(stoppedOrdinaryCohort([], 100), false);
  assert.equal(stoppedOrdinaryCohort([main]), false);
  assert.equal(stoppedOrdinaryCohort([main, helper], 100), true);
  assert.equal(stoppedOrdinaryCohort([main, unexpected], 100), false);
  assert.equal(stoppedOrdinaryCohort([unexpected], 100), false);
  assert.equal(stoppedOrdinaryCohort(null), false);
});

test('fixture host admission is chosen from tracked versions and exhausts only the reviewed bundled sources', () => {
  const source = fs.readFileSync(new URL('./native-fixture.mjs', import.meta.url), 'utf8');
  const helpers = source.slice(source.indexOf('function loadFixtureAdmission('), source.indexOf('async function stoppedSnapshot('));
  const files = [];
  const support = 'Cyberpunk 2077 Support for Vortex exact';
  const sourceCommit = 'a'.repeat(40), appAsarSha256 = 'b'.repeat(64), indexHash = 'c'.repeat(64);
  const manifest = { schema: 'stock-vortex-source-admission/1', vortexVersion: '2.10.1', appAsarSha256,
    provenance: { vortexSourceCommit: sourceCommit }, extensions: [
      { kind: 'bundled', folder: 'offered-by-stock', files: [{ path: 'index.cjs', sha256: indexHash }] },
      { kind: 'user', folder: support, files: [{ path: 'index.js', sha256: indexHash }] },
      { kind: 'user', folder: 'ordinary-profile-plugin', files: [{ path: 'index.js', sha256: indexHash }] },
    ] };
  const { loadFixtureAdmission, reviewedFixtureExtensions } = vm.runInNewContext(helpers
    + '; ({loadFixtureAdmission, reviewedFixtureExtensions})', {
    fs: { readFileSync: file => { files.push(file); return Buffer.from(JSON.stringify(manifest)); } },
    must: (ok, code) => { if (!ok) throw Error(code); },
    here: 'C:\\review', path: path.win32, sha: () => 'd'.repeat(64),
  });
  assert.throws(() => loadFixtureAdmission('..\\evil'), /FIXTURE_HOST_VERSION_UNREVIEWED/);
  assert.equal(files.length, 0);
  const review = loadFixtureAdmission('2.10.1');
  assert.equal(files[0], 'C:\\review\\stock-vortex-2.10.1-admission.json');
  const resolved = reviewedFixtureExtensions(review, path.win32.join('C:\\support', support), indexHash,
    'C:\\Program Files\\Vortex\\Vortex.exe');
  assert.equal(resolved.hostVersion, '2.10.1');
  assert.equal(resolved.appAsarSha256, appAsarSha256);
  assert.equal(resolved.supportIndexSha256, indexHash);
  assert.equal(resolved.dynamicSources.length, 1);
  assert.equal(resolved.dynamicSources[0].path,
    'C:\\Program Files\\Vortex\\resources\\app.asar.unpacked\\bundledPlugins\\offered-by-stock');
  assert.throws(() => reviewedFixtureExtensions(review, support, appAsarSha256, 'C:/Vortex.exe'),
    /FIXTURE_SUPPORT_NOT_STOCK_REVIEWED/);
  assert.throws(() => reviewedFixtureExtensions(review, 'ordinary-profile-plugin', indexHash, 'C:/Vortex.exe'),
    /FIXTURE_SUPPORT_NOT_STOCK_REVIEWED/);
  delete manifest.provenance.vortexSourceCommit;
  assert.throws(() => loadFixtureAdmission('2.10.1'), /FIXTURE_HOST_ADMISSION_INVALID/);
});
