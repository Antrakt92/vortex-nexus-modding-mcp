import test from 'node:test';
import assert from 'node:assert/strict';
import diagnostics from './install-diagnostics.cjs';
import serialization from './serialization.cjs';
const { createInstallDiagnostics, validInstallDiagnostics } = diagnostics;

function fixture(budgetMs = 100) {
  let time = 0, next = 0;
  const queue = new Map();
  const timers = {
    setTimeout(fn, delay) { const id = ++next; queue.set(id, { fn, at: time + delay }); return id; },
    clearTimeout(id) { queue.delete(id); },
  };
  return { d: createInstallDiagnostics({ budgetMs, now: () => time, timers }),
    advance(ms, fire = true) {
      time += ms;
      if (fire) for (const [id, timer] of [...queue]) if (timer.at <= time) { queue.delete(id); timer.fn(); }
    }, queue };
}
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

test('diagnostic labels survive account-name overlap only at curated positions', () => {
  const d = createInstallDiagnostics();
  d.phase('import');
  const snapshot = d.snapshot();
  const api = {getState: () => ({persistent:{nexus:{userInfo:{name:'import'}}}})};
  for (const kind of ['operation_status','install_local_archive','reconcile_operation']) {
    const value = serialization.safe({installDiagnostics:snapshot,display:'import'},api,kind);
    assert.deepEqual(value.installDiagnostics,snapshot);
    assert.equal(value.display,'[redacted]');
  }
  assert.equal(serialization.safe({phase:'import'},api).phase,'[redacted]');
  assert.throws(() => serialization.safe(snapshot,api,'install_diagnostics',['import']),/OPERATIONAL_SECRET_OVERLAP/);
});

test('diagnostic serialization refuses arbitrary labels and extra data is not valid diagnostics', () => {
  const snapshot = createInstallDiagnostics().snapshot();
  assert.throws(() => serialization.safe({...snapshot,phase:'arbitrary text'},null,'install_diagnostics'),/OPERATIONAL_VALUE_NOT_CURATED/);
  assert.equal(validInstallDiagnostics({...snapshot,extra:'private text'}),false);
});

test('exported schema enums are frozen', () => {
  for (const name of ['PHASES', 'METRICS', 'STATES', 'REASONS', 'WAITS']) {
    assert.equal(Object.isFrozen(diagnostics[name]), true);
    assert.throws(() => { diagnostics[name].push('unbounded'); }, TypeError);
  }
});

test('wait invokes native thunk synchronously before returning', async () => {
  const { d } = fixture();
  const order = [];
  const pending = d.wait('native_import', () => { order.push('native'); return 42; });
  order.push('returned');
  assert.deepEqual(order, ['native', 'returned']);
  assert.equal(await pending, 42);
});

test('fixed labels, strict schema and no unbounded data', () => {
  const { d } = fixture();
  assert.equal(validInstallDiagnostics(d.snapshot()), true);
  for (const method of [() => d.phase('private path'), () => d.enter('x'),
    () => d.measureSync('x', () => {}), () => d.wait('x', () => {})]) assert.throws(method, TypeError);
  for (const mutate of [s => { s.path = 'secret'; }, s => { s.metrics.foo = {}; },
    s => { s.metrics.metadata.path = 'secret'; }, s => { s.elapsedMs = Infinity; },
    s => { s.remainingMs = -1; }, s => { s.reason = 'raw error'; },
    s => { s.phaseTimes.native_hook = 0.5; }, s => { s.budgetMs = 0; },
    s => { s.nativeMayContinue = true; }, s => { s.state = 'arbitrary'; },
    s => { s.waitReason = 'arbitrary'; }, s => { s.extra = undefined; }]) {
    const s = d.snapshot(); mutate(s); assert.equal(validInstallDiagnostics(s), false);
  }
  assert.equal(validInstallDiagnostics(null), false);
});

test('phase nesting and overlapping measurement use monotonic elapsed time', async () => {
  const f = fixture(), { d } = f;
  d.phase('import'); f.advance(5);
  const leave = d.enter('native_hook');
  await d.measure('native_import', async () => {
    f.advance(7); d.measureSync('context_checks', () => f.advance(3));
  });
  leave(); leave(); f.advance(2);
  const s = d.snapshot();
  assert.equal(s.phase, 'import');
  assert.equal(s.phaseTimes.native_hook, 10);
  assert.equal(s.phaseTimes.import, 7);
  assert.deepEqual(s.metrics.native_import, { calls: 1, totalMs: 10 });
  assert.deepEqual(s.metrics.context_checks, { calls: 1, totalMs: 3 });
  f.advance(-3); assert.equal(d.snapshot().elapsedMs, 17);
});

test('measurement alone does not throw after sync overrun; admission then trips', () => {
  const f = fixture(), { d } = f;
  assert.equal(d.measureSync('archive_proof', () => { f.advance(101, false); return 'resource'; }), 'resource');
  assert.equal(d.snapshot().reason, 'none');
  assert.throws(() => d.assertWork(), { code: 'LOCAL_ARCHIVE_DEADLINE_EXCEEDED' });
  assert.equal(d.remainingMs(30), 0);
});

test('async resource measurement is not raced and zero-cap wait never invokes work', async () => {
  const f = fixture(), { d } = f;
  const resource = {};
  assert.equal(await d.measure('metadata', async () => { f.advance(101, false); return resource; }), resource);
  assert.equal(d.snapshot().reason, 'none');
  assert.throws(() => d.assertWork(), { code: 'LOCAL_ARCHIVE_DEADLINE_EXCEEDED' });
  const zero = fixture(); let invoked = false;
  await assert.rejects(zero.d.wait('metadata', () => { invoked = true; }, 0), { code: 'LOCAL_ARCHIVE_STAGE_TIMEOUT' });
  assert.equal(invoked, false); assert.equal(zero.queue.size, 0);
});

test('stage timeout poisons before trip and timeout handlers, ignores late resolution', async () => {
  const f = fixture(), { d } = f;
  let resolve, called = 0, trips = 0;
  d.markEffects();
  d.onTrip(() => { trips++; assert.throws(() => d.assertWork(), { code: 'LOCAL_ARCHIVE_STAGE_TIMEOUT' }); });
  const pending = d.wait('metadata', () => new Promise(r => { resolve = r; }), 30, {
    onTimeout() { called++; assert.throws(() => d.assertWork(), { code: 'LOCAL_ARCHIVE_STAGE_TIMEOUT' }); },
  });
  await flush(); assert.equal(d.snapshot().waitReason, 'metadata_reply');
  const rejected = assert.rejects(pending, { code: 'LOCAL_ARCHIVE_STAGE_TIMEOUT', message: 'LOCAL_ARCHIVE_STAGE_TIMEOUT' });
  f.advance(30); await rejected;
  assert.equal(called, 1); assert.equal(trips, 1);
  const s = d.finish('held', 'operation_error');
  assert.equal(s.nativeMayContinue, true); assert.equal(s.reason, 'stage_timeout');
  assert.equal(s.waitReason, 'metadata_reply');
  resolve('late'); await flush(); f.advance(1000);
  assert.deepEqual(d.snapshot(), s);
});

test('deadline and nested hook leave cannot restore phase after poison', async () => {
  const f = fixture(), { d } = f;
  d.phase('import'); const leave = d.enter('native_hook');
  let synchronous = false;
  d.onTrip(() => { synchronous = true; leave(); d.phase('package'); });
  const pending = d.wait('native_import', () => new Promise(() => {}));
  await flush(); const rejected = assert.rejects(pending, { code: 'LOCAL_ARCHIVE_DEADLINE_EXCEEDED', message: 'LOCAL_ARCHIVE_DEADLINE_EXCEEDED' });
  f.advance(100); assert.equal(synchronous, true); await rejected;
  leave(); assert.equal(d.snapshot().phase, 'native_hook');
  assert.throws(() => d.assertWork(), { code: 'LOCAL_ARCHIVE_DEADLINE_EXCEEDED' });
});

test('event-loop delay cannot accept a callback beyond either cutoff', async () => {
  for (const [cap, elapsed, code] of [[30, 31, 'LOCAL_ARCHIVE_STAGE_TIMEOUT'], [100, 101, 'LOCAL_ARCHIVE_DEADLINE_EXCEEDED']]) {
    const f = fixture();
    await assert.rejects(f.d.wait('native_install', () => { f.advance(elapsed, false); return 'late'; }, cap), { code });
    assert.equal(f.queue.size, 0);
  }
});

test('successful/rejected waits measure and restore reason without poisoning', async () => {
  const f = fixture(), { d } = f;
  assert.equal(await d.wait('host_admission', () => {
    assert.equal(d.snapshot().waitReason, 'source_proof'); f.advance(10); return 42;
  }, 30), 42);
  assert.equal(d.snapshot().waitReason, 'none');
  await assert.rejects(d.wait('native_install', () => { f.advance(5); throw new Error('native'); }, 30), /native/);
  assert.equal(d.snapshot().reason, 'none');
  assert.deepEqual(d.snapshot().metrics.native_install, { calls: 1, totalMs: 5 });
});

test('finalizing is non-cancelable and finish freezes all observations', async () => {
  const f = fixture(), { d } = f;
  d.markEffects(); d.finalizing();
  assert.throws(() => d.assertWork(), { code: 'LOCAL_ARCHIVE_WORK_CLOSED' });
  assert.throws(() => d.wait('native_install', () => {}), { code: 'LOCAL_ARCHIVE_WORK_CLOSED' });
  d.phase('install'); assert.equal(d.snapshot().phase, 'finalizing_receipt');
  await d.measure('receipt_commit', async () => f.advance(150));
  const s = d.finish('completed', 'none', true);
  assert.equal(s.reason, 'none'); assert.equal(s.nativeMayContinue, false);
  assert.equal(s.waitReason, 'none');
  f.advance(1000); d.phase('install');
  assert.deepEqual(d.finish('held', 'receipt_cleanup'), s);
  assert.equal(validInstallDiagnostics(s), true);
});

test('completion publication suppresses conservative held continuation and late metrics freeze', async () => {
  const f = fixture(), { d } = f;
  d.markEffects(); let resolve;
  const pending = d.measure('native_import', () => new Promise(r => { resolve = r; }));
  f.advance(8); const s = d.finish('held', 'receipt_cleanup', true);
  assert.equal(s.nativeMayContinue, false); assert.equal(s.metrics.native_import.totalMs, 8);
  resolve(); await pending; f.advance(2); assert.deepEqual(d.snapshot(), s);
});

test('an outstanding wait cannot change a final snapshot when timer or callback arrives', async () => {
  const f = fixture(), { d } = f;
  let resolve;
  const pending = d.wait('native_import', () => new Promise(r => { resolve = r; }), 30);
  await flush(); f.advance(5);
  const s = d.finish('held', 'operation_error');
  const rejected = assert.rejects(pending, { code: 'LOCAL_ARCHIVE_WORK_CLOSED' });
  f.advance(30); await rejected; resolve('late'); await flush();
  assert.deepEqual(d.snapshot(), s);
  const altered = d.snapshot(); altered.metrics.metadata.totalMs = 123; altered.phaseTimes.import = 456;
  assert.deepEqual(d.snapshot(), s);
});
