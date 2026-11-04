import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {createImmutableRecordIO} from './immutable-records.mjs';

const options = {maxBytes: 1024 * 1024, prefix: 'TEST_RECORD_'};
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'immutable-record-'));
  t.after(() => fs.rmSync(root, {recursive: true}));
  return root;
}
const manyTokens = Buffer.from(JSON.stringify(Array(100000).fill(0)));

test('explicit token budget supports large records while defaults still refuse them', t => {
  const root = fixture(t), file = path.join(root, 'existing.json');
  fs.writeFileSync(file, manyTokens);
  assert.throws(() => createImmutableRecordIO(options).readJSON(file), /TEST_RECORD_CORRUPT/);
  const io = createImmutableRecordIO({...options, maxTokens: 2000000});
  assert.equal(io.readJSON(file).length, 100000);
  const pins = io.ancestry(root);
  const observed = io.publish(root, 'published.json', manyTokens, pins, () => {});
  const observations = new Map();
  assert.equal(io.readJSON(path.join(root, 'published.json'), observations, manyTokens).length, 100000);
  assert.equal(observations.get(path.join(root, 'published.json')), observed);
  assert.throws(() => io.publish(root, 'published.json', manyTokens, pins, () => {}), /EEXIST/);
});

test('explicit depth budget is separate from token and byte budgets', t => {
  const root = fixture(t), file = path.join(root, 'deep.json');
  fs.writeFileSync(file, '['.repeat(40) + '0' + ']'.repeat(40));
  assert.throws(() => createImmutableRecordIO(options).readJSON(file), /CORRUPT/);
  assert.throws(() => createImmutableRecordIO({...options, maxTokens: 2000000}).readJSON(file), /CORRUPT/);
  assert.ok(Array.isArray(createImmutableRecordIO({...options, maxDepth: 64}).readJSON(file)));
  const small = createImmutableRecordIO({maxBytes: 1, prefix: 'TEST_RECORD_'});
  fs.writeFileSync(file, '0');
  assert.equal(small.readJSON(file), 0);
});

test('invalid explicit limits refuse at construction within existing parser hard caps', () => {
  for (const patch of [{maxTokens: 0}, {maxTokens: 2000001}, {maxTokens: 1.5},
    {maxTokens: null}, {maxTokens: Infinity}, {maxDepth: 0}, {maxDepth: 129}, {maxDepth: null}])
    assert.throws(() => createImmutableRecordIO({...options, ...patch}), /IMMUTABLE_RECORD_INVALID_OPTIONS/);
});

test('parse options are captured privately and later caller mutation cannot widen them', t => {
  const root = fixture(t), file = path.join(root, 'existing.json'), supplied = {...options, maxTokens: 200000};
  const io = createImmutableRecordIO(supplied);
  supplied.maxTokens = 2000000;
  fs.writeFileSync(file, manyTokens);
  assert.throws(() => io.readJSON(file), /CORRUPT/);
});

test('larger token budgets retain duplicate-key, malformed UTF-8, byte and exact-readback checks', t => {
  const root = fixture(t), file = path.join(root, 'bad.json');
  const io = createImmutableRecordIO({...options, maxTokens: 2000000});
  for (const bytes of [Buffer.from('{"x":1,"\\u0078":2}'), Buffer.from([0xc3, 0x28]),
    Buffer.alloc(options.maxBytes + 1, 32)]) {
    fs.writeFileSync(file, bytes);
    assert.throws(() => io.readJSON(file), /CORRUPT/);
  }
  fs.writeFileSync(file, '{"x":1}');
  assert.throws(() => io.readJSON(file, new Map(), Buffer.from('{"x":2}')), /TEST_RECORD_CHANGED/);
});

test('larger budgets retain guarded publication and ancestry/reparse refusal', t => {
  const root = fixture(t), io = createImmutableRecordIO({...options, maxTokens: 2000000});
  const pins = io.ancestry(root);
  assert.throws(() => io.publish(root, 'denied.json', manyTokens, pins,
    () => {throw Error('CALLER_GUARD_REFUSED');}), /CALLER_GUARD_REFUSED/);
  assert.equal(fs.existsSync(path.join(root, 'denied.json')), false);
  const actual = path.join(root, 'actual'), link = path.join(root, 'alias');
  fs.mkdirSync(actual); fs.symlinkSync(actual, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => io.ancestry(link), /UNSAFE_PATH/);
  const wrong = new Map(pins); wrong.set(root, 'wrong-node');
  assert.throws(() => io.publish(root, 'changed.json', manyTokens, wrong, () => {}), /PATH_CHANGED/);
  assert.equal(fs.existsSync(path.join(root, 'changed.json')), false);
});

test('a larger modeled physical baseline stays within an explicit bounded token budget', t => {
  const root = fixture(t), file = path.join(root, 'baseline.json');
  const files = Array.from({length: 35000}, (_, i) => ({path: `C:/fixture-stage/provider-${i}/r6/scripts/file.reds`,
    proof: {nodeId: `123:${i}`, bytes: '4096', links: 2, sha256: 'a'.repeat(64)}}));
  const bytes = Buffer.from(JSON.stringify({schema: 'ptn-supported-capture-v1', files, directories: []}));
  assert.ok(bytes.length > 4386417);
  const io = createImmutableRecordIO({maxBytes: 64 * 1024 * 1024, maxTokens: 2000000, prefix: 'TEST_BASELINE_'});
  io.publish(root, 'baseline.json', bytes, io.ancestry(root), () => {});
  assert.equal(io.readJSON(file).files.length, 35000);
});

test('real capture artifact passes unchanged through strict read and fsynced publication',
  {skip: !process.env.IMMUTABLE_RECORD_CAPTURE_FIXTURE}, t => {
    const root = fixture(t), input = process.env.IMMUTABLE_RECORD_CAPTURE_FIXTURE;
    const bytes = fs.readFileSync(input), sha = crypto.createHash('sha256').update(bytes).digest('hex');
    const base = {maxBytes: 64 * 1024 * 1024, prefix: 'TEST_CAPTURE_'};
    assert.throws(() => createImmutableRecordIO(base).readJSON(input), /TEST_CAPTURE_CORRUPT/);
    const io = createImmutableRecordIO({...base, maxTokens: 2000000});
    const captured = io.readJSON(input);
    assert.equal(captured.schema, 'hardening-native-read-only-capture/1');
    assert.equal(captured.rows.length, 3);
    io.publish(root, 'capture.json', bytes, io.ancestry(root), () => {});
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(root, 'capture.json'))).digest('hex'), sha);
    assert.equal(io.readJSON(path.join(root, 'capture.json')).rows.length, 3);
  });
