import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough, Readable, Writable} from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import credential from './credential.cjs';
import {handler, main, runStdio} from './bridge.mjs';
import {createPlanJournal} from './plan-journal.mjs';

const deferred = () => {let resolve; const promise = new Promise(r => {resolve = r;}); return {promise, resolve};};
const reply = value => ({content: [{type: 'text', text: JSON.stringify(value)}]});
const context = {gameId: 'cyberpunk2077', profileId: 'test-profile', gamePath: 'F:/Game',
  stagingPath: 'F:/Stage', downloadPath: 'D:/Downloads',
  filesystemIds: {gamePath: '1:2', stagingPath: '1:3', downloadPath: '2:4'}};
const unused = () => ({protocol: 'vortex-agent/1', attempt: null, completion: null, failure: null, interlock: null,
  receiptIssues: [], incompleteCompletionObserved: false, adapterTerminalReceiptObserved: false, terminalOperationVerified: false});

test('bridge CLI rejects invalid arguments before reading the Vortex credential', async t => {
  const tokenReads = t.mock.method(credential, 'readToken', async () => {throw Error('unexpected credential read');});
  for (const argv of [['--health', 'extra'], ['--call', 'health', '{}', 'extra']]) {
    await assert.rejects(main(argv), /Usage: bridge/);
  }
  for (const args of ['', '{', 'null', '[]']) {
    await assert.rejects(main(['--call', 'health', args]), /Invalid MCP JSON payload|JSON object/);
  }
  assert.equal(tokenReads.mock.callCount(), 0);
});

test('initialization refuses malformed health results with a stable diagnostic', async () => {
  const accepted = reply({protocol: 'vortex-agent/1'});
  const other = reply({protocol: 'different-adapter'});
  for (const health of [null, 'upstream', {content: {}}, reply(null), {isError: 'false', ...accepted},
    {content: [...accepted.content, ...other.content]}, {...accepted, structuredContent: {protocol: 'different-adapter'}}]) {
    const handle = handler(async () => health);
    const init = await handle({jsonrpc: '2.0', id: 1, method: 'initialize'});
    assert.match(init.error.message, /Wrong server on port 3701/);
    const next = await handle({jsonrpc: '2.0', id: 2, method: 'tools/list'});
    assert.match(next.error.message, /Initialize the bridge first/);
  }
});

test('MCP tool calls refuse malformed results and preserve valid tool errors', async () => {
  let response;
  const handle = handler(async (_method, params) =>
    params.name === 'health' ? reply({protocol: 'vortex-agent/1'}) : response);
  const init = await handle({jsonrpc: '2.0', id: 1, method: 'initialize'});
  assert.equal(init.error, undefined);
  const request = {jsonrpc: '2.0', id: 2, method: 'tools/call', params: {name: 'list_dialogs', arguments: {}}};
  for (response of [null, [], {content: null}, {isError: 'false', ...reply([])}]) {
    const rejected = await handle(request);
    assert.equal(rejected.error?.message, 'Invalid Vortex tool result');
    assert.equal(Object.hasOwn(rejected, 'result'), false);
  }
  response = {isError: true, ...reply({error: 'TOOL_CONCURRENCY_LIMIT'})};
  assert.deepEqual((await handle(request)).result, response);
});

test('bridge CLI refuses malformed tool results before stdout and preserves legitimate error status', async t => {
  let health = reply(null), response;
  const cliOutput = t.mock.method(process.stdout, 'write', () => true);
  t.mock.method(credential, 'readToken', async () => 'synthetic-token');
  t.mock.method(globalThis, 'fetch', async (_url, request) => {
    const value = JSON.parse(request.body).params.name === 'health' ? health : response;
    return new Response(JSON.stringify({jsonrpc: '2.0', id: 1, result: value}));
  });
  const exit = process.exitCode;
  try {
    await assert.rejects(main(['--health']), /Wrong server on port 3701/);
    health = reply({protocol: 'vortex-agent/1'});
    for (response of [null, 1, [], {content: null}]) {
      await assert.rejects(main(['--call', 'list_dialogs']), /Invalid Vortex tool result/);
    }
    assert.equal(cliOutput.mock.callCount(), 0);
    response = {isError: true, ...reply({error: 'TOOL_CONCURRENCY_LIMIT'})};
    await main(['--call', 'list_dialogs']);
    assert.equal(cliOutput.mock.callCount(), 1);
    assert.equal(process.exitCode, 1);
  } finally { process.exitCode = exit; }
});

test('stdio refuses duplicate decoded apply keys before dispatch and accepts the next frame', async () => {
  const requests = [], responses = [];
  const ambiguous = '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":'
    + '{"name":"run_mod_plan","arguments":{"apply":false,"\\u0061pply":true,"plan":{}}}}\n';
  const valid = '{"jsonrpc":"2.0","id":2,"method":"ping"}\n';
  await runStdio(Readable.from([ambiguous, valid]), new Writable({write(bytes, _, callback) {
    responses.push(JSON.parse(bytes)); callback();
  }}), async request => {requests.push(request); return {jsonrpc: '2.0', id: request.id, result: {}};});
  assert.deepEqual(requests, [{jsonrpc: '2.0', id: 2, method: 'ping'}]);
  assert.deepEqual(responses.map(r => [r.id, r.error?.code]), [[null, -32700], [2, undefined]]);
});

test('invalid RPC IDs cannot dispatch direct mutations, reads or initialization', async () => {
  let calls = 0;
  const handle = handler(async (_method, params) => {
    calls++; return reply(params.name === 'health' ? {protocol: 'vortex-agent/1'} : {});
  });
  await handle({jsonrpc: '2.0', id: 1, method: 'initialize'});
  for (const id of [null, {}, [], true, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    for (const method of ['initialize', 'tools/list', 'tools/call']) {
      const result = await handle({jsonrpc: '2.0', id, method,
        params: {name: 'set_mods_enabled', arguments: {...context, requestId: 'invalid_rpc_request', modIds: ['own'], enabled: true}}});
      assert.equal(result.error?.code, -32600);
      assert.equal(result.id, null);
    }
  }
  assert.equal(calls, 1);
});

test('a cancellation at pending capacity stops later plan steps after settling its invoked write', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-plan-test-'));
  t.after(() => fs.rmSync(root, {recursive: true}));
  const entered = deferred(), release = deferred(), answered = deferred();
  const receipts = new Map(), writes = [];
  const handle = handler(async (_method, params) => {
    const {name, arguments: args} = params;
    if (name === 'health') return reply({protocol: 'vortex-agent/1', ...context});
    if (name === 'reconcile_operation') return reply(receipts.get(args.requestId) || unused());
    assert.equal(name, 'set_mods_enabled');
    writes.push(args.requestId);
    if (writes.length === 1) {entered.resolve(); await release.promise;}
    const result = {protocol: 'vortex-agent/1', requestId: args.requestId, operation: name,
      operationCompleted: true, diskDeploymentVerified: false, modIds: args.modIds,
      enabled: args.enabled, enabledFlagsVerified: true};
    receipts.set(args.requestId, {...unused(), adapterTerminalReceiptObserved: true, terminalOperationVerified: true,
      attempt: {operation: name, requestId: args.requestId, gameId: args.gameId, profileId: args.profileId, parameters: args},
      completion: {...result, gameId: args.gameId, profileId: args.profileId}});
    return reply(result);
  }, {journal: createPlanJournal({root: path.join(root, 'plans')})});
  await handle({jsonrpc: '2.0', id: 'init', method: 'initialize'});
  const input = new PassThrough(), output = new PassThrough();
  let text = '';
  output.on('data', chunk => {text += chunk; if (text.includes('\n')) answered.resolve();});
  const work = runStdio(input, output, handle, 1);
  const plan = {version: 1, context, steps: [0, 1].map(i => ({operation: 'set_mods_enabled',
    requestId: 'capacity_plan_step_' + i, modIds: ['own'], enabled: true})), deploy: null};
  input.write(JSON.stringify({jsonrpc: '2.0', id: 'plan', method: 'tools/call',
    params: {name: 'run_mod_plan', arguments: {plan, apply: true}}}) + '\n');
  await entered.promise;
  input.write(JSON.stringify({jsonrpc: '2.0', method: 'notifications/cancelled', params: {requestId: 'plan'}}) + '\n');
  await new Promise(resolve => setImmediate(resolve));
  release.resolve();
  await answered.promise;
  input.end();
  await work;
  assert.deepEqual(writes, ['capacity_plan_step_0']);
  const result = JSON.parse(text).result.structuredContent;
  assert.equal(result.code, 'PLAN_CANCELLED');
  assert.equal(result.completed.length, 1);
  assert.equal(result.completed[0].adapterReceiptVerified, true);
});

test('a queued parse error does not delay cancellation behind backpressured stdout', async () => {
  const entered = deferred(), settle = deferred(), blocked = deferred();
  const input = new PassThrough(), replies = [];
  let cancelled = false, finishWrite;
  const output = new Writable({write(bytes, _, callback) {
    const response = JSON.parse(bytes);
    replies.push(response);
    if (response.error?.code === -32700) {
      finishWrite = callback;
      blocked.resolve();
    } else callback();
  }});
  const work = runStdio(input, output, async request => {
    if (request.method === 'notifications/cancelled') {cancelled = true; return;}
    entered.resolve();
    await settle.promise;
    return {jsonrpc: '2.0', id: request.id, result: {cancelled}};
  }, 2);
  input.write('{"jsonrpc":"2.0","id":"plan","method":"tools/call"}\n');
  await entered.promise;
  input.write('{\n{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":"plan"}}\n');
  await blocked.promise;
  await new Promise(resolve => setImmediate(resolve));
  const cancelledBeforeDrain = cancelled;
  finishWrite();
  settle.resolve();
  input.end();
  await work;
  assert.equal(cancelledBeforeDrain, true);
  assert.deepEqual(replies.map(reply => [reply.id, reply.error?.code, reply.result?.cancelled]),
    [[null, -32700, undefined], ['plan', undefined, true]]);
});

test('ordinary overload is bounded, cancels pending plans and never dispatches the excess request', async () => {
  const entered = deferred(), release = deferred();
  let calls = 0, cancelled = false;
  const handle = async request => {
    calls++; entered.resolve(); await release.promise;
    return {jsonrpc: '2.0', id: request.id, result: {}};
  };
  handle.cancelPendingPlans = () => {cancelled = true;};
  const input = new PassThrough(), output = new PassThrough(); output.resume();
  const work = runStdio(input, output, handle, 1).then(() => null, error => error);
  input.write('{"jsonrpc":"2.0","id":1,"method":"tools/call"}\n');
  await entered.promise;
  input.write('{"jsonrpc":"2.0","id":2,"method":"tools/call"}\n');
  await new Promise(resolve => setImmediate(resolve));
  const cancelledBeforeSettlement = cancelled;
  release.resolve(); input.end();
  const error = await work;
  assert.equal(cancelledBeforeSettlement, true);
  assert.equal(calls, 1);
  assert.match(error?.message || '', /MCP request capacity exceeded/);
});
