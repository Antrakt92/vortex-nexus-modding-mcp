import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(new URL('./native-fixture.mjs', import.meta.url), 'utf8');
const reader = source.slice(source.indexOf('function processes()'), source.indexOf('function crc32('));
const row = (ProcessId = 100, ParentProcessId = 20, IsMain = true, StartTicks = '639000000000000000') =>
  ({ ProcessId, ParentProcessId, ExecutablePath: 'C:\\Program Files\\Vortex\\Vortex.exe', StartTicks, IsMain });
const envelope = rows => ({ Schema: 'fixture-process-inventory/1', Complete: true, Count: rows.length, Processes: rows });
const good = rows => ({ status: 0, signal: null, stdout: JSON.stringify(envelope(rows)), stderr: '' });
function fixture(run, env = {SystemRoot: 'C:\\Windows'}) {
  const calls = [];
  const processes = vm.runInNewContext(reader + '; processes', {
    process: { platform: 'win32', env }, path, here,
    must: (ok, code) => { if (!ok) throw Error(code); },
    spawnSync: (...args) => { calls.push(args); return run(...args); },
  });
  return { processes, calls };
}

test('strict complete generation proof maps main/helper rows and permits separate fixture roots', () => {
  const f = fixture(() => good([row(), row(101, 100, false, '639000000000000001'), row(200, 20)]));
  const rows = JSON.parse(JSON.stringify(f.processes()));
  assert.deepEqual(rows, [
    {pid: 100, parent: 20, exe: row().ExecutablePath, type: '', generation: row().StartTicks},
    {pid: 101, parent: 100, exe: row().ExecutablePath, type: 'helper', generation: '639000000000000001'},
    {pid: 200, parent: 20, exe: row().ExecutablePath, type: '', generation: row().StartTicks},
  ]);
  const [exe, args, options] = f.calls[0];
  assert.equal(exe, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.deepEqual(Array.from(args).slice(0, -1), ['-NoLogo', '-NoProfile', '-NonInteractive', '-File']);
  assert.equal(args.at(-1), path.join(here, 'fixture-process-inventory.ps1'));
  assert.equal(options.timeout, 20000); assert.equal(options.maxBuffer, 1024 * 1024);
  assert.equal(options.windowsHide, true);
});

test('bad Windows roots never invoke PATH or the helper', () => {
  for (const SystemRoot of [undefined, 'Windows', 'C:\\Windows\\..\\Temp', 'C:\\Windows:stream', 'C:\\Windows\n']) {
    const f = fixture(() => { throw Error('must not invoke'); }, {SystemRoot});
    assert.throws(f.processes, /FIXTURE_PROCESS_LIST_UNVERIFIABLE/); assert.equal(f.calls.length, 0);
  }
});

test('process failures, partial output, stderr and trailing data fail closed', () => {
  const normal = good([row()]);
  for (const result of [undefined, {...normal, error: Error('private')}, {...normal, status: 1},
    {...normal, signal: 'SIGTERM'}, {...normal, stderr: 'private'}, {...normal, stdout: normal.stdout.slice(0, -1)},
    {...normal, stdout: normal.stdout + '\n{}'}, {...normal, stdout: ''}]) {
    assert.throws(fixture(() => result).processes, /FIXTURE_PROCESS_LIST_UNVERIFIABLE/);
  }
  assert.throws(fixture(() => { throw Error('private'); }).processes, /FIXTURE_PROCESS_LIST_UNVERIFIABLE/);
});

test('unknown schema, incomplete cohorts and malformed generation/parent proofs fail closed', () => {
  const mutations = [
    v => { v.Schema = 'wrong'; }, v => { v.Complete = false; }, v => { v.Count++; },
    v => { v.extra = 'private'; }, v => { v.Processes[0].CommandLine = 'private'; },
    v => { v.Processes = []; v.Count = 0; }, v => { v.Processes[0].IsMain = false; },
    v => { v.Processes[0].StartTicks = 639000000000000000; }, v => { v.Processes[0].StartTicks = '9999999999999999999'; },
    v => { v.Processes[0].ExecutablePath = 'D:\\other\\Vortex.exe'; },
    v => { v.Processes[0].ParentProcessId = v.Processes[0].ProcessId; },
    v => { v.Processes.push(row()); v.Count++; },
    v => { v.Processes.push(row(101, 100, false, '638000000000000000')); v.Count++; },
    v => { v.Processes.push(row(101, 200, false), row(200, 101, false)); v.Count += 2; },
  ];
  for (const mutate of mutations) {
    const value = envelope([row()]); mutate(value);
    assert.throws(fixture(() => ({...good([]), stdout: JSON.stringify(value)})).processes, /FIXTURE_PROCESS_LIST_UNVERIFIABLE/);
  }
});

test('opt-in actual read-only stock Vortex inventory', {skip: process.platform !== 'win32' || process.env.VORTEX_FIXTURE_PROCESS_READ_TEST !== '1'}, () => {
  const f = fixture(spawnSync, process.env), rows = f.processes();
  assert.ok(rows.some(row => row.type === ''));
  assert.ok(rows.every(row => Object.keys(row).sort().join(',') === 'exe,generation,parent,pid,type'));
});
