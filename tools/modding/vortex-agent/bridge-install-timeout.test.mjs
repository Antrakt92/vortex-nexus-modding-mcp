import test from 'node:test';
import assert from 'node:assert/strict';
import { remote, MAX_RESPONSE_BYTES } from './bridge.mjs';
const token = async () => 'synthetic-bearer';
const args = { name: 'install_local_archive', arguments: { requestId: 'private-request-id', archivePath: 'private-path' } };
const unavailable = 'Vortex MCP unavailable or timed out. Start Vortex with the audited vortex-agent extension, verify port 3701 ownership; inspect receipts before retrying a write.';
const lost = 'Vortex local archive transport lost or timed out. Native work may continue. Reconcile the original requestId with reconcile_operation; do not retry install_local_archive.';
const abort = name => new DOMException('private-token private-request-id private-path', name);
function brokenBody(type, name) {
  let count = 0;
  return new Response(new ReadableStream({ pull(controller) {
    if (count++ === 0) controller.enqueue(new TextEncoder().encode(type === 'text/event-stream' ? ': keepalive\n\n' : '{"jsonrpc":'));
    else controller.error(abort(name));
  } }), { headers: { 'content-type': type } });
}
for (const name of ['AbortError', 'TimeoutError']) {
  test(`local install ${name} before headers reports uncertain native work exactly once`, async () => {
    let calls = 0;
    await assert.rejects(remote('tools/call', args, async (_url, options) => {
      calls++; assert.ok(options.signal instanceof AbortSignal); throw abort(name);
    }, token), { message: lost });
    assert.equal(calls, 1);
  });
  for (const type of ['text/event-stream', 'application/json']) {
    test(`local install ${type} body ${name} retains reconciliation guidance`, async () => {
      let calls = 0;
      await assert.rejects(remote('tools/call', args, async () => { calls++; return brokenBody(type, name); }, token), { message: lost });
      assert.equal(calls, 1);
    });
  }
}

test('credential failure is unchanged and cannot dispatch', async () => {
  let calls = 0;
  await assert.rejects(remote('tools/call', args, async () => { calls++; }, async () => { throw abort('AbortError'); }), error => {
    assert.match(error.message, /^Vortex Agent credential unavailable\./);
    assert.doesNotMatch(error.message, /Native work|private-token/); return true;
  });
  assert.equal(calls, 0);
});

test('HTTP authentication refusal and response policy failures stay unchanged', async () => {
  const cases = [
    [() => new Response('', {status: 401}), 'Vortex MCP authentication failed. Run credential.cjs --initialize once as the same Windows user as Vortex, then verify extension and credential ownership.'],
    [() => new Response('', {headers: {'content-length': String(MAX_RESPONSE_BYTES + 1)}}), 'MCP response too large'],
    [() => new Response('not json'), 'Invalid Vortex MCP response'],
    [() => new Response('data: not json\n\n', {headers: {'content-type': 'text/event-stream'}}), 'Invalid Vortex MCP response'],
  ];
  for (const [response, message] of cases) {
    let calls = 0;
    await assert.rejects(remote('tools/call', args, async () => { calls++; return response(); }, token), {message});
    assert.equal(calls, 1);
  }
});

test('read-only and other tools retain existing fetch/body errors', async () => {
  for (const params of [{name: 'health'}, {name: 'reconcile_operation'}, {name: 'set_mods_enabled'}]) {
    await assert.rejects(remote('tools/call', params, async () => { throw abort('AbortError'); }, token), {message: unavailable});
    for (const type of ['text/event-stream', 'application/json']) {
      await assert.rejects(remote('tools/call', params, async () => brokenBody(type, 'AbortError'), token), {message: 'Invalid Vortex MCP response'});
    }
  }
});

test('local install successful response uses original transport and signature', async () => {
  const expected = { content: [{type: 'text', text: 'ok'}] };
  assert.deepEqual(await remote('tools/call', args, async () => Response.json({jsonrpc: '2.0', id: 1, result: expected}), token), expected);
});
