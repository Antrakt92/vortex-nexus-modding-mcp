'use strict';

const PHASES = Object.freeze(['preflight', 'package', 'import', 'import_settle', 'install', 'native_hook', 'staged_proof', 'finalizing_receipt']);
const METRICS = Object.freeze(['context_checks', 'archive_proof', 'host_admission', 'metadata', 'native_import', 'import_settle', 'native_install', 'staged_proof', 'receipt_commit']);
const STATES = Object.freeze(['running', 'finalizing', 'completed', 'failed_before_effect', 'held']);
const REASONS = Object.freeze(['none', 'deadline', 'stage_timeout', 'native_failure', 'operation_error', 'receipt_cleanup']);
const WAITS = Object.freeze(['none', 'source_proof', 'metadata_reply', 'import_callback', 'download_finished', 'install_callback', 'receipt_commit']);
const WAIT_FOR = { metadata: 'metadata_reply', native_import: 'import_callback', import_settle: 'download_finished', native_install: 'install_callback', receipt_commit: 'receipt_commit' };
const MAX = Number.MAX_SAFE_INTEGER;
const integer = n => Number.isSafeInteger(n) && n >= 0;
const bounded = n => Math.min(MAX, Math.max(0, Math.floor(n)));
const keys = (v, expected) => v !== null && typeof v === 'object' && !Array.isArray(v)
  && Reflect.ownKeys(v).length === expected.length && expected.every(k => Object.hasOwn(v, k));
const TOP = ['schema', 'phase', 'state', 'waitReason', 'reason', 'elapsedMs', 'budgetMs', 'remainingMs', 'effectsMayHaveOccurred', 'nativeMayContinue', 'phaseTimes', 'metrics'];

function validInstallDiagnostics(v) {
  try {
    return keys(v, TOP) && v.schema === 'install-diagnostics/1' && PHASES.includes(v.phase)
      && STATES.includes(v.state) && WAITS.includes(v.waitReason) && REASONS.includes(v.reason)
      && ['elapsedMs', 'budgetMs', 'remainingMs'].every(k => integer(v[k])) && v.budgetMs > 0
      && v.remainingMs === Math.max(0, v.budgetMs - v.elapsedMs)
      && typeof v.effectsMayHaveOccurred === 'boolean' && typeof v.nativeMayContinue === 'boolean'
      && (!v.nativeMayContinue || (v.state === 'held' && v.effectsMayHaveOccurred))
      && keys(v.phaseTimes, PHASES) && PHASES.every(k => integer(v.phaseTimes[k]))
      && keys(v.metrics, METRICS) && METRICS.every(k => keys(v.metrics[k], ['calls', 'totalMs'])
        && integer(v.metrics[k].calls) && integer(v.metrics[k].totalMs));
  } catch { return false; }
}

function createInstallDiagnostics({ budgetMs = 240000, now = () => performance.now(), timers = { setTimeout, clearTimeout } } = {}) {
  if (!integer(budgetMs) || budgetMs === 0) throw new TypeError('Invalid diagnostics budget');
  const started = now();
  if (!Number.isFinite(started)) throw new TypeError('Invalid monotonic clock');
  let clock = 0, frozen, phaseStart = 0, current = 'preflight', state = 'running';
  let reason = 'none', waitReason = 'none', effects = false, completion = false, poison;
  const trips = new Set(), active = new Set(), phaseTimes = Object.fromEntries(PHASES.map(k => [k, 0]));
  const metrics = Object.fromEntries(METRICS.map(k => [k, { calls: 0, totalMs: 0 }]));
  const elapsed = () => {
    if (frozen !== undefined) return frozen;
    const value = now() - started;
    if (!Number.isFinite(value)) throw new TypeError('Invalid monotonic clock');
    clock = Math.max(clock, bounded(value));
    return clock;
  };
  const label = (name, allowed) => { if (!allowed.includes(name)) throw new TypeError('Invalid diagnostics label'); };
  const terminal = () => !['running', 'finalizing'].includes(state);
  const trip = why => {
    if (!poison) {
      reason = why;
      poison = Object.assign(new Error(why === 'deadline' ? 'LOCAL_ARCHIVE_DEADLINE_EXCEEDED' : 'LOCAL_ARCHIVE_STAGE_TIMEOUT'),
        { code: why === 'deadline' ? 'LOCAL_ARCHIVE_DEADLINE_EXCEEDED' : 'LOCAL_ARCHIVE_STAGE_TIMEOUT' });
      for (const fn of trips) { try { fn(poison); } catch { /* A handler cannot undo the interlock. */ } }
    }
    return poison;
  };
  function assertWork() {
    if (poison) throw poison;
    if (state !== 'running') throw Object.assign(new Error('LOCAL_ARCHIVE_WORK_CLOSED'), { code: 'LOCAL_ARCHIVE_WORK_CLOSED' });
    if (elapsed() >= budgetMs) throw trip('deadline');
  }
  function phase(name) {
    label(name, PHASES);
    if (poison || terminal() || state === 'finalizing') return;
    const end = elapsed();
    phaseTimes[current] = bounded(phaseTimes[current] + end - phaseStart);
    phaseStart = end; current = name;
  }
  function enter(name) {
    const previous = current;
    phase(name);
    let left = false;
    return () => { if (!left) { left = true; phase(previous); } };
  }
  function remainingMs(cap = MAX) {
    if (!integer(cap)) throw new TypeError('Invalid diagnostics cap');
    return Math.min(cap, Math.max(0, budgetMs - elapsed()));
  }
  // Measurements never race or cancel resources and do not enforce work admission.
  // Nested measurements may overlap; their totals must not be added as wall time.
  function begin(metric) {
    label(metric, METRICS);
    if (terminal()) throw new Error('Diagnostics already finished');
    const start = elapsed();
    const span = { metric, start }; active.add(span);
    metrics[metric].calls = bounded(metrics[metric].calls + 1);
    let ended = false;
    return () => {
      if (!ended) {
        ended = true; active.delete(span);
        if (frozen === undefined) metrics[metric].totalMs = bounded(metrics[metric].totalMs + elapsed() - start);
      }
    };
  }
  function measureSync(metric, fn) { const end = begin(metric); try { return fn(); } finally { end(); } }
  async function measure(metric, fn) { const end = begin(metric); try { return await fn(); } finally { end(); } }
  function wait(metric, thunk, capMs = remainingMs(), { onTimeout } = {}) {
    label(metric, METRICS);
    assertWork();
    const limit = remainingMs(capMs), waitStart = elapsed(), end = begin(metric), previous = waitReason;
    waitReason = WAIT_FOR[metric] || 'source_proof';
    return new Promise((resolve, reject) => {
      let settled = false, timer;
      const settle = (error, value) => {
        if (settled) return;
        settled = true; timers.clearTimeout(timer); end();
        if (!poison && state === 'running') waitReason = previous;
        if (error) reject(error); else resolve(value);
      };
      const timeout = () => {
        if (settled) return;
        if (state !== 'running') { settle(Object.assign(new Error('LOCAL_ARCHIVE_WORK_CLOSED'), { code: 'LOCAL_ARCHIVE_WORK_CLOSED' })); return; }
        const error = trip(elapsed() >= budgetMs ? 'deadline' : 'stage_timeout');
        try { if (onTimeout) onTimeout(error); } catch { /* Keep original timeout. */ }
        settle(error);
      };
      if (limit === 0) { timeout(); return; }
      timer = timers.setTimeout(timeout, limit);
      let result;
      try { assertWork(); result = thunk(); } catch (error) {
        try { assertWork(); } catch (closed) { error = closed; }
        settle(error); return;
      }
      Promise.resolve(result).then(value => {
        if (settled) return;
        if (elapsed() - waitStart >= limit) { timeout(); return; }
        try { assertWork(); settle(null, value); } catch (error) { settle(error); }
      }, error => { if (!settled) { try { assertWork(); } catch (closed) { error = closed; } settle(error); } });
    });
  }
  function snapshot() {
    const time = elapsed(), times = { ...phaseTimes };
    const measured = Object.fromEntries(METRICS.map(k => [k, { ...metrics[k] }]));
    if (frozen === undefined) for (const span of active) measured[span.metric].totalMs = bounded(measured[span.metric].totalMs + time - span.start);
    if (frozen === undefined) times[current] = bounded(times[current] + time - phaseStart);
    return { schema: 'install-diagnostics/1', phase: current, state, waitReason, reason, elapsedMs: time,
      budgetMs, remainingMs: Math.max(0, budgetMs - time), effectsMayHaveOccurred: effects,
      nativeMayContinue: state === 'held' && effects && !completion, phaseTimes: times,
      metrics: measured };
  }
  function finalizing() { assertWork(); phase('finalizing_receipt'); state = 'finalizing'; waitReason = 'receipt_commit'; }
  function finish(next, why = 'none', completionPublished = false) {
    label(next, ['completed', 'failed_before_effect', 'held']); label(why, REASONS);
    if (typeof completionPublished !== 'boolean') throw new TypeError('Invalid completion flag');
    if (terminal()) return snapshot();
    frozen = elapsed(); phaseTimes[current] = bounded(phaseTimes[current] + frozen - phaseStart);
    for (const span of active) metrics[span.metric].totalMs = bounded(metrics[span.metric].totalMs + frozen - span.start);
    active.clear();
    state = next; reason = poison ? reason : why; completion = completionPublished;
    if (next === 'completed') waitReason = 'none';
    return snapshot();
  }
  return { phase, enter, assertWork, remainingMs, wait, measureSync, measure, finalizing, finish, snapshot,
    onTrip(fn) { if (typeof fn !== 'function') throw new TypeError('Invalid trip handler'); trips.add(fn); if (poison) { try { fn(poison); } catch {} } },
    markEffects() { assertWork(); effects = true; } };
}

module.exports = { createInstallDiagnostics, validInstallDiagnostics, PHASES, METRICS, STATES, REASONS, WAITS };
