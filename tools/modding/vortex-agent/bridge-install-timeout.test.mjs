import test from 'node:test';
import assert from 'node:assert/strict';
import { remote, MAX_RESPONSE_BYTES } from './bridge.mjs';
import receipts from './receipts.cjs';
import diagnostics from './install-diagnostics.cjs';
const token = async () => 'synthetic-bearer';
const args = { name: 'install_local_archive', arguments: { requestId: 'private-request-id', archivePath: 'F:/private-path/owned-mod.zip' } };
const unavailable = 'Vortex MCP unavailable or timed out. Start Vortex with the audited vortex-agent extension, verify port 3701 ownership; inspect receipts before retrying a write.';
const lost = 'Vortex local archive transport lost or timed out. Native work may continue. Reconcile the original requestId with reconcile_operation; do not retry install_local_archive.';
const abort = name => new DOMException('private-token private-request-id private-path', name);
const acknowledgement = { protocol: 'vortex-agent/1', operation: 'install_local_archive', requestId: args.arguments.requestId,
  operationCompleted: true, diskDeploymentVerified: false, verificationRequired: receipts.VERIFICATION, modId: 'owned-mod',
  downloadId: 'download-a', installedRecordVerified: true, enabled: false, archiveSha256Verified: true, payloadFilesVerified: 2 };
const toolReply = (textValue, structuredContent = textValue) => ({content: [{type: 'text', text: JSON.stringify(textValue)}], structuredContent});
const wireReply = result => async () => Response.json({jsonrpc: '2.0', id: 1, result});
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

const unusableResponses = [
  ['oversized declared length', () => new Response('', {headers: {'content-length': String(MAX_RESPONSE_BYTES + 1)}}), 'MCP response too large'],
  ['oversized body', () => new Response(new Uint8Array(MAX_RESPONSE_BYTES + 1)), 'MCP response too large'],
  ['missing body', () => new Response(null, {status: 204})],
  ['invalid JSON', () => new Response('not json')],
  ['empty JSON', () => new Response('')],
  ['partial JSON at clean EOF', () => new Response('{"jsonrpc":"2.0","id":1,"result":')],
  ['wrong JSON-RPC ID', () => Response.json({jsonrpc: '2.0', id: 2, result: {}})],
  ['missing JSON-RPC outcome', () => Response.json({jsonrpc: '2.0', id: 1})],
  ['invalid SSE', () => new Response('data: not json\n\n', {headers: {'content-type': 'text/event-stream'}})],
  ['unterminated SSE at clean EOF', () => new Response('data: {"jsonrpc":"2.0","id":1,"result":{}}\n', {headers: {'content-type': 'text/event-stream'}})],
];
for (const [reason, response, otherMessage = 'Invalid Vortex MCP response'] of unusableResponses) {
  test(`unusable local install response reports uncertain native work exactly once for ${reason}`, async () => {
    let calls = 0;
    await assert.rejects(remote('tools/call', args, async () => { calls++; return response(); }, token), {message: lost});
    assert.equal(calls, 1);
    await assert.rejects(remote('tools/call', {name: 'health'}, async () => response(), token), {message: otherMessage});
  });
}

test('an unusable local install result needs reconciliation', async () => {
  const text = {type: 'text', text: 'ok'};
  for (const result of [null, [], {}, {content: []}, {content: [null]}, {content: [{type: 'text'}]},
    {content: [text]}, {structuredContent: {}}, {content: [text], structuredContent: []}, {isError: true, content: [null]}]) {
    await assert.rejects(remote('tools/call', args, async () => Response.json({jsonrpc: '2.0', id: 1, result}), token), {message: lost});
  }
});

test('internal and malformed JSON-RPC errors cannot prove no local archive effects', async () => {
  const rejected = 'Vortex MCP rejected the request; verify tool arguments and adapted protocol.';
  for (const error of [[], {}, {code: -32603, message: 'private-path'}, {code: -32602}]) {
    const response = async () => Response.json({jsonrpc: '2.0', id: 1, error});
    await assert.rejects(remote('tools/call', args, response, token), {message: lost});
    await assert.rejects(remote('tools/call', {name: 'health'}, response, token),
      {message: Array.isArray(error) ? 'Invalid Vortex MCP response' : rejected});
  }
});

test('explicit local install refusals retain authentication and JSON-RPC errors', async () => {
  const refusals = [
    [() => new Response('', {status: 401}), 'Vortex MCP authentication failed. Run credential.cjs --initialize once as the same Windows user as Vortex, then verify extension and credential ownership.'],
    ...[-32700, -32600, -32601, -32602].map(code =>
      [() => Response.json({jsonrpc: '2.0', id: 1, error: {code, message: 'private-path'}}), 'Vortex MCP rejected the request; verify tool arguments and adapted protocol.']),
  ];
  for (const [response, message] of refusals) {
    let calls = 0;
    await assert.rejects(remote('tools/call', args, async () => { calls++; return response(); }, token), {message});
    assert.equal(calls, 1);
  }
});

test('HTTP server errors after a local install dispatch require original-ID reconciliation', async () => {
  for (const status of [500, 502, 503, 504, 599]) {
    let calls = 0;
    const response = async () => {calls++; return new Response('private-upstream-text', {status});};
    await assert.rejects(remote('tools/call', args, response, token), {message: lost});
    assert.equal(calls, 1);
    await assert.rejects(remote('tools/call', {name: 'health'}, response, token),
      {message: `Vortex MCP HTTP ${status}; verify the adapted extension and port ownership.`});
  }
});

test('ambiguous JSON and SSE replies cannot overwrite an earlier install result', async () => {
  const data = '{"jsonrpc":"2.0","id":1,"result":null,"\\u0072esult":'
    + '{"content":[{"type":"text","text":"ok"}],"structuredContent":{"operationCompleted":true}}}';
  for (const type of ['application/json', 'text/event-stream']) {
    const wire = type === 'text/event-stream' ? `data: ${data}\r\n\r\n` : data;
    await assert.rejects(remote('tools/call', args, async () => new Response(wire, {headers: {'content-type': type}}), token),
      {message: lost});
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
  const expected = { content: [{type: 'text', text: JSON.stringify(acknowledgement)}], structuredContent: acknowledgement };
  assert.deepEqual(await remote('tools/call', args, async () => Response.json({jsonrpc: '2.0', id: 1, result: expected}), token), expected);
});

test('local install rejects empty, foreign, incomplete and contradictory success acknowledgements', async () => {
  const wrongId = {...acknowledgement, requestId: 'foreign-request'};
  const duplicate = toolReply(acknowledgement);
  duplicate.content[0].text = duplicate.content[0].text.replace('"requestId":', '"requestId":"foreign-request","requestId":');
  for (const result of [toolReply({}), toolReply(wrongId), toolReply(acknowledgement, wrongId),
    toolReply({...acknowledgement, operation: 'deploy_mods'}), toolReply({...acknowledgement, modId: 'different-owner'}),
    toolReply({...acknowledgement, payloadFilesVerified: 0}), toolReply({...acknowledgement, diskDeploymentVerified: true}), duplicate]) {
    await assert.rejects(remote('tools/call', args, wireReply(result), token), {message: lost});
  }
});

test('local install structured tool failure is returned unchanged', async () => {
  const expected = { isError: true, content: [{type: 'text', text: '{"error":"CONTEXT_CHANGED"}'}] };
  assert.deepEqual(await remote('tools/call', args, async () => Response.json({jsonrpc: '2.0', id: 1, result: expected}), token), expected);
});

test('local install retains safe refusal, failed and possibly-pending native diagnostics', async () => {
  const failed = diagnostics.createInstallDiagnostics().finish('failed_before_effect', 'operation_error');
  const active = diagnostics.createInstallDiagnostics(); active.markEffects();
  const held = active.finish('held', 'stage_timeout');
  const action = 'Re-read health/context, inspect external receipts and Vortex UI/log privately. Never blindly retry a mutation.';
  for (const value of [{error:'TOOL_CONCURRENCY_LIMIT'}, {error:'CONTEXT_CHANGED', action, installDiagnostics:failed},
    {error:'LOCAL_ARCHIVE_STAGE_TIMEOUT', action, installDiagnostics:held}]) {
    const expected = {isError:true, content:[{type:'text', text:JSON.stringify(value)}]};
    assert.deepEqual(await remote('tools/call', args, wireReply(expected), token), expected);
  }
  for (const value of ['plain private text', '{}', '{"error":"arbitrary text"}',
    '{"error":"CONTEXT_CHANGED","action":"private text"}', '{"error":"CONTEXT_CHANGED","installDiagnostics":{}}']) {
    await assert.rejects(remote('tools/call', args, wireReply({isError:true, content:[{type:'text',text:value}]}), token), {message:lost});
  }
  await assert.rejects(remote('tools/call', args, wireReply({...toolReply(acknowledgement),isError:true}),token),{message:lost});
});

test('pinned SDK pre-handler local-install input refusal is returned as a safe tool error', async () => {
  const errorReply = text => ({isError:true,content:[{type:'text',text}]});
  const prefix = 'Input validation error: Invalid arguments for tool install_local_archive: ';
  const refusal = errorReply(prefix + 'gameId: Invalid input: expected string, received undefined');
  const malformed = {name: 'install_local_archive', arguments: {archivePath: 'own.zip'}};
  assert.deepEqual(await remote('tools/call', malformed, wireReply(refusal), token),
    errorReply('{"error":"INVALID_LOCAL_INSTALL_ARGUMENTS"}'));
  for (const result of [errorReply('Output validation error: Invalid result for tool install_local_archive: malformed'),
    errorReply(prefix), errorReply(prefix.replace('install_local_archive','other_tool') + 'detail'),
    {...refusal,structuredContent:{}}]) {
    await assert.rejects(remote('tools/call', malformed, wireReply(result), token), {message:lost});
  }
});

test('an interrupted local-install response body preserves the original operation for reconciliation', async () => {
  const disconnected = new TypeError('terminated');
  const output = new Response(new ReadableStream({pull(controller) {
    controller.error(disconnected);
  }}), {headers: {'content-type': 'application/json'}});
  await assert.rejects(remote('tools/call', args, async () => output, token), {message: lost});
});
