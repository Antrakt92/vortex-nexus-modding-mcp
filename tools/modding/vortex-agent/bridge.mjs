#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import credential from './credential.cjs';
import {RUN_PLAN_TOOL, INSPECT_PLAN_TOOL} from './plan-tool.mjs';
import diagnostics from './install-diagnostics.cjs';
import strictJSON from './strict-json.cjs';
export const ENDPOINT = 'http://127.0.0.1:3701/mcp';
const RESTART_GUIDANCE = 'Authorized close/restart: read docs/AUTHORIZED-RESTART.md in the maintained Vortex Nexus Modding MCP checkout. MainWindowHandle=0 does not rule out hidden windows. Use the reviewed native WM_CLOSE route scoped to the exact main PID/generation, executable/source pins, stopped game, pending-operation and updater guards; verify all Vortex processes exit. Never force-kill. A missing MCP shutdown tool alone does not require manual closure.';
function maintainedToolMetadata(tool) {
  if (tool.name !== 'health') return tool;
  const description = typeof tool.description === 'string' ? tool.description : '';
  return description.includes(RESTART_GUIDANCE) ? tool : {...tool,
    description: [description, RESTART_GUIDANCE].filter(Boolean).join(' ')};
}

const MAX_REQUEST_BYTES = 1024 * 1024;
const EMPTY_BYTES = Buffer.alloc(0);
class ByteAccumulator {
  #storage = EMPTY_BYTES;
  #length = 0;
  #limit;

  constructor(limit) { this.#limit = limit; }
  get length() { return this.#length; }
  append(fragment) {
    if (!fragment.byteLength) return;
    const length = this.#length + fragment.byteLength;
    if (length > this.#limit) throw new RangeError('MCP byte accumulation limit exceeded');
    if (length > this.#storage.length) {
      const capacity = Math.min(this.#limit, Math.max(256, length, this.#storage.length * 2));
      const storage = Buffer.allocUnsafe(capacity);
      this.#storage.copy(storage, 0, 0, this.#length);
      this.#storage = storage;
    }
    this.#storage.set(fragment, this.#length);
    this.#length = length;
  }
  view() { return this.#storage.subarray(0, this.#length); }
  reset() {
    this.#length = 0;
    // Keep a small buffer for normal traffic without retaining a peak-sized one.
    if (this.#storage.length > 64 * 1024) this.#storage = EMPTY_BYTES;
  }
}
function parse(input, maxBytes = MAX_RESPONSE_BYTES) {
  try { return strictJSON.parseStrictJSON(typeof input === 'string' ? Buffer.from(input) : input, {maxBytes}); }
  catch { throw new Error('Invalid MCP JSON payload'); }
}
export const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
function cancelBody(body) { if (body) void body.cancel().catch(() => {}); }
function releaseReader(reader) { cancelBody(reader); reader.releaseLock(); }
export async function* boundedLines(input, max = MAX_REQUEST_BYTES) {
  const pending = new ByteAccumulator(max);
  let dropping = false;
  const decode = data => { try { return new TextDecoder('utf-8', { fatal: true }).decode(data); } catch { return null; } };
  for await (const chunk of input) {
    const data = Buffer.from(chunk); let start = 0;
    while (start < data.length) {
      const newline = data.indexOf(10, start), end = newline < 0 ? data.length : newline;
      const fragment = data.subarray(start, end);
      if (!dropping) {
        if (pending.length + fragment.length > max) { pending.reset(); dropping = true; }
        else if (newline < 0 || pending.length) pending.append(fragment);
      }
      if (newline < 0) break;
      const line = dropping ? null : decode(pending.length ? pending.view() : fragment)?.replace(/\r$/, '') ?? null;
      pending.reset(); dropping = false; start = newline + 1;
      yield line;
    }
  }
  if (dropping) yield null;
  else if (pending.length) yield decode(pending.view());
}
const UNAVAILABLE = 'Vortex MCP unavailable or timed out. Start Vortex with the audited vortex-agent extension, verify port 3701 ownership; inspect receipts before retrying a write.';
const LOCAL_INSTALL_TRANSPORT_LOST = 'Vortex local archive transport lost or timed out. Native work may continue. Reconcile the original requestId with reconcile_operation; do not retry install_local_archive.';
class UnusableResponse extends Error {
  constructor(message = 'Invalid Vortex MCP response') { super(message); }
}
function isLocalArchiveInstall(method, params) {
  return method === 'tools/call' && params?.name === 'install_local_archive';
}
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isToolResult = value => isObject(value) && Array.isArray(value.content)
  && (!Object.hasOwn(value, 'isError') || typeof value.isError === 'boolean');
function requireHealth(result) {
  if (isToolResult(result) && !result.isError) {
    const texts = result.content.filter(item => item?.type === 'text');
    if (texts.length === 1 && typeof texts[0].text === 'string') {
      let info;
      try { info = parse(texts[0].text); } catch { /* Report a stable handshake diagnostic below. */ }
      if (isObject(info) && info.protocol === 'vortex-agent/1'
        && (!Object.hasOwn(result, 'structuredContent') || isDeepStrictEqual(info, result.structuredContent))) return;
    }
  }
  throw new Error('Wrong server on port 3701: vortex-agent/1 health required');
}
const INSTALL_ERROR_ACTION = 'Re-read health/context, inspect external receipts and Vortex UI/log privately. Never blindly retry a mutation.';
const INSTALL_INPUT_REFUSAL = 'Input validation error: Invalid arguments for tool install_local_archive: ';
function isInstallInputRefusal(result) {
  // SDK2 wraps its pre-handler Zod refusal in a text tool error. Its distinct
  // post-handler output-validation and runtime errors must still reconcile.
  const text = result?.content?.[0];
  return isObject(result) && result.isError === true && !Object.hasOwn(result, 'structuredContent')
    && Array.isArray(result.content) && result.content.length === 1 && text?.type === 'text'
    && typeof text.text === 'string' && text.text.startsWith(INSTALL_INPUT_REFUSAL)
    && text.text.length > INSTALL_INPUT_REFUSAL.length;
}
async function isLocalInstallResult(result, args) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return false;
  const { content, structuredContent, isError } = result;
  if (!Array.isArray(content) || content.length !== 1) return false;
  const [text] = content;
  if (text?.type !== 'text' || typeof text.text !== 'string' || !text.text.length) return false;
  const parsed = parse(text.text);
  if (!isObject(parsed) || Object.hasOwn(parsed, 'installDiagnostics')
    && !diagnostics.validInstallDiagnostics(parsed.installDiagnostics)) return false;
  if (isError === true) {
    return !Object.hasOwn(result, 'structuredContent')
      && Object.keys(parsed).every(key => ['error', 'action', 'installDiagnostics'].includes(key))
      && typeof parsed.error === 'string' && /^[A-Z][A-Z0-9_]{1,99}$/.test(parsed.error)
      && (!Object.hasOwn(parsed, 'action') || parsed.action === INSTALL_ERROR_ACTION);
  }
  if ((isError !== undefined && isError !== false) || !isObject(structuredContent)
    || !isDeepStrictEqual(structuredContent, parsed)) return false;
  // session.mjs imports this bridge. Load its shared acknowledgement check only
  // when a local-install response arrives.
  const {validateLocalInstallAcknowledgement} = await import('./session.mjs');
  validateLocalInstallAcknowledgement(structuredContent, args);
  return true;
}
export async function remote(method, params = {}, fetcher = fetch, tokenProvider = credential.readToken) {
  let dispatched = false;
  try { return await remoteRequest(method, params, fetcher, tokenProvider, () => { dispatched = true; }); }
  catch (error) {
    if (dispatched && isLocalArchiveInstall(method, params)
      && (error?.message === UNAVAILABLE || error instanceof UnusableResponse)) throw new Error(LOCAL_INSTALL_TRANSPORT_LOST);
    if (error instanceof UnusableResponse) throw new Error(error.message);
    throw error;
  }
}
async function remoteRequest(method, params, fetcher, tokenProvider, onDispatch) {
  if (method === 'tools/call' && params.name === 'install_download') {
    throw new Error('Native installation is unsupported by this adapter. Use the inspected native workflow in vortex-mod-lifecycle; do not retry install_download.');
  }
  let response;
  let token;
  try { token = await tokenProvider(); }
  catch { throw new Error('Vortex Agent credential unavailable. Run node "' + fileURLToPath(new URL('./credential.cjs', import.meta.url)) + '" --initialize once as the Windows user running Vortex.'); }
  try {
    const request = { method: 'POST', redirect: 'error',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(300000) };
    // HTTP abort ends this transport only; it never cancels or replays native work.
    onDispatch(); response = await fetcher(ENDPOINT, request);
  }
  catch { throw new Error(UNAVAILABLE); }
  if (!response.ok) {
    cancelBody(response.body);
    // An HTTP server failure does not establish whether the install handler ran.
    if (isLocalArchiveInstall(method, params) && response.status >= 500 && response.status <= 599)
      throw new UnusableResponse();
    throw new Error(response.status === 401 ? 'Vortex MCP authentication failed. Run credential.cjs --initialize once as the same Windows user as Vortex, then verify extension and credential ownership.' : `Vortex MCP HTTP ${response.status}; verify the adapted extension and port ownership.`);
  }
  if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) { cancelBody(response.body); throw new UnusableResponse('MCP response too large'); }
  if (!response.body) throw new UnusableResponse();
  let message;
  const mediaType = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
  if (mediaType === 'text/event-stream') {
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
    const lineBuffer = new ByteAccumulator(MAX_RESPONSE_BYTES), dataBuffer = new ByteAccumulator(MAX_RESPONSE_BYTES);
    const separator = Buffer.from('\n');
    let hasData = false, skipLF = false, firstLine = true, bytes = 0;
    try {
      while (!message) {
        const { value, done } = await reader.read();
        if (done) break;
        let start = 0;
        // Parse line boundaries before decoding so bytes after a complete reply
        // cannot change its result just because they arrived in the same read.
        for (let end = 0; end < value.length; end++) {
          if (++bytes > MAX_RESPONSE_BYTES) throw new UnusableResponse('MCP response too large');
          const byte = value[end];
          if (skipLF) {
            skipLF = false;
            if (byte === 10) { start = end + 1; continue; }
          }
          if (byte !== 13 && byte !== 10) continue;
          const fragment = value.subarray(start, end);
          let line;
          if (lineBuffer.length) {
            lineBuffer.append(fragment);
            line = decoder.decode(lineBuffer.view());
            lineBuffer.reset();
          } else line = decoder.decode(fragment);
          if (firstLine) { line = line.replace(/^\uFEFF/, ''); firstLine = false; }
          start = end + 1; skipLF = byte === 13;
          if (line.startsWith('data:')) {
            if (hasData) dataBuffer.append(separator);
            dataBuffer.append(Buffer.from(line.slice(5).trimStart()));
            hasData = true;
          } else if (!line && hasData) {
            hasData = false;
            if (dataBuffer.length) {
              const candidate = parse(dataBuffer.view());
              dataBuffer.reset();
              if (candidate?.id === 1) {
                message = candidate;
                break;
              }
            }
          }
        }
        if (!message && start < value.length) lineBuffer.append(value.subarray(start));
      }
    } catch (error) {
      throw error instanceof UnusableResponse ? error : new UnusableResponse();
    } finally { releaseReader(reader); }
  } else {
    const reader = response.body.getReader(), body = new ByteAccumulator(MAX_RESPONSE_BYTES);
    try {
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        if (body.length + value.byteLength > MAX_RESPONSE_BYTES) throw new UnusableResponse('MCP response too large');
        body.append(value);
      }
      message = parse(body.view());
    } catch (error) {
      throw error instanceof UnusableResponse ? error : new UnusableResponse();
    } finally { releaseReader(reader); }
  }
  if (!message || typeof message !== 'object' || Array.isArray(message)
    || message.jsonrpc !== '2.0' || message.id !== 1) throw new UnusableResponse();
  if (Object.hasOwn(message, 'result') === Object.hasOwn(message, 'error')) throw new UnusableResponse();
  if (Object.hasOwn(message, 'error') && (!message.error || typeof message.error !== 'object' || Array.isArray(message.error)))
    throw new UnusableResponse();
  const localInstall = isLocalArchiveInstall(method, params);
  if (message.error) {
    // Only protocol-level parsing, routing and input refusals prove the tool was never invoked.
    if (localInstall && (![-32700, -32600, -32601, -32602].includes(message.error.code)
      || typeof message.error.message !== 'string')) throw new UnusableResponse();
    throw new Error('Vortex MCP rejected the request; verify tool arguments and adapted protocol.');
  }
  if (localInstall) {
    if (isInstallInputRefusal(message.result))
      return {isError: true, content: [{type: 'text', text: '{"error":"INVALID_LOCAL_INSTALL_ARGUMENTS"}'}]};
    try {
      if (!await isLocalInstallResult(message.result, params.arguments)) throw new UnusableResponse();
    } catch { throw new UnusableResponse(); }
  }
  if (method === 'tools/list' && Array.isArray(message.result?.tools)) {
    return { ...message.result, tools: message.result.tools.filter(tool => tool.name !== 'install_download').map(maintainedToolMetadata) };
  }
  return message.result;
}
const INSPECT_TOOL = {
  name: 'inspect_session',
  description: 'Read the active Vortex context, mods, downloads, dialogs and external changes in one bounded call. Optional diagnostics add native conflicts and collection observations. Partial results expose errors and limits; this is not deployment or gameplay proof.',
  inputSchema: {type: 'object', properties: {diagnostics: {type: 'boolean', default: false}}, additionalProperties: false},
  annotations: {readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false},
};
const COLLECTION_DOWNLOADS_TOOL = {
  name: 'find_collection_downloads',
  description: 'Match up to 100 Nexus mod/file pairs against tracked downloads for the expected active game in one compact read. Reports finished/active/paused/failed candidates, duplicates, unknown identities and capped/partial observations. Metadata only: does not verify archive bytes or authorize downloading/installing.',
  inputSchema: {type: 'object', required: ['gameId', 'files'], additionalProperties: false, properties: {
    gameId: {type: 'string', pattern: '^[a-z0-9_-]{1,200}$'},
    files: {type: 'array', minItems: 1, maxItems: 100, items: {type: 'object', additionalProperties: false,
      required: ['nexusModId', 'nexusFileId'], properties: {
        nexusModId: {type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER},
        nexusFileId: {type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER},
      }}},
  }},
  annotations: {readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false},
};
const LOCAL_TOOLS = [INSPECT_TOOL, COLLECTION_DOWNLOADS_TOOL, RUN_PLAN_TOOL, INSPECT_PLAN_TOOL];
function localToolResult(result) {
  return {content: [{type: 'text', text: JSON.stringify(result)}], structuredContent: result, ...(['partial', 'stopped'].includes(result.status) ? {isError: true} : {})};
}

// Compose existing guarded operations; their native eligibility/receipt guards remain authoritative.
export async function clientRemote(method, params = {}, transport = remote, {signal, journal} = {}) {
  if (method === 'tools/list') {
    const result = await transport(method, params);
    if (!Array.isArray(result?.tools)) throw new Error('Invalid Vortex tool inventory');
    const tools = result.tools
      .filter(tool => tool.name !== 'install_download' && !LOCAL_TOOLS.some(local => local.name === tool.name))
      .map(maintainedToolMetadata);
    if (params?.cursor === undefined) tools.push(...structuredClone(LOCAL_TOOLS));
    return {...result, tools};
  }
  if (method === 'tools/call' && params.name === 'inspect_session') {
    const args = params.arguments === undefined ? {} : params.arguments;
    if (!args || typeof args !== 'object' || Array.isArray(args)
      || Object.keys(args).some(key => key !== 'diagnostics')
      || args.diagnostics !== undefined && typeof args.diagnostics !== 'boolean')
      return {isError: true, content: [{type: 'text', text: '{"error":"INVALID_INSPECTION_OPTIONS"}'}]};
    // Dynamic import avoids initializing session.mjs through its bridge import.
    const {inspectSession, createToolCaller} = await import('./session.mjs');
    const result = await inspectSession({call: createToolCaller(transport), diagnostics: args.diagnostics ?? false});
    return localToolResult(result);
  }
  if (method === 'tools/call' && params.name === 'find_collection_downloads') {
    const {findCollectionDownloads} = await import('./collection-downloads.mjs');
    const {createToolCaller} = await import('./session.mjs');
    try { return localToolResult(await findCollectionDownloads(params.arguments, {call: createToolCaller(transport)})); }
    catch (error) {
      if (error.message !== 'INVALID_COLLECTION_REQUEST') throw error;
      return {isError: true, content: [{type: 'text', text: '{"error":"INVALID_COLLECTION_REQUEST"}'}]};
    }
  }
  if (method === 'tools/call' && params.name === 'run_mod_plan') {
    const args = params.arguments;
    if (!args || typeof args !== 'object' || Array.isArray(args) || !Object.hasOwn(args, 'plan')
      || Object.keys(args).some(key => !['plan', 'apply'].includes(key))
      || args.apply !== undefined && typeof args.apply !== 'boolean')
      return localToolResult({status: 'stopped', code: 'INVALID_PLAN_REQUEST', diskDeploymentVerified: false});
    const {runPlan, createToolCaller} = await import('./session.mjs');
    try {return localToolResult(await runPlan(args.plan, {apply: args.apply ?? false, call: createToolCaller(transport), signal, journal}));}
    catch (error) {
      const code = /^(?:INVALID_PLAN(?:_CONTEXT|_STEPS|_STEP|_SIGNAL)?|INVALID_DEPLOY_STEP|INVALID_APPLY_FLAG|DUPLICATE_REQUEST_ID|EMPTY_PLAN)$/.test(error.message)
        ? error.message : 'PLAN_VALIDATION_FAILED';
      return localToolResult({status: 'stopped', code, diskDeploymentVerified: false});
    }
  }
  if (method === 'tools/call' && params.name === 'inspect_mod_plan') {
    const args = params.arguments;
    if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).length !== 1
      || !Object.hasOwn(args, 'planId') || typeof args.planId !== 'string' || !/^[a-f0-9]{64}$/.test(args.planId))
      return localToolResult({status: 'stopped', code: 'INVALID_PLAN_ID', diskDeploymentVerified: false});
    const {inspectPlan, createToolCaller} = await import('./session.mjs');
    return localToolResult(await inspectPlan(args.planId, {call: createToolCaller(transport), journal}));
  }
  return transport(method, params);
}

export function handler(call = remote, {journal} = {}) {
  let initialized = false;
  const active = new Map();
  const handle = async (request, retainResponseId) => {
    const hasId = request !== null && typeof request === 'object' && Object.hasOwn(request, 'id');
    const validId = hasId && (typeof request.id === 'string' || Number.isSafeInteger(request.id));
    if (!request || typeof request !== 'object' || Array.isArray(request)
      || request.jsonrpc !== '2.0' || typeof request.method !== 'string' || hasId && !validId)
      return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } };
    if (!hasId) {
      if (request.method === 'notifications/cancelled') active.get(request.params?.requestId)?.controller?.abort();
      return undefined;
    }
    const isPlan = request.method === 'tools/call' && request.params?.name === 'run_mod_plan';
    const existing = active.get(request.id);
    // A collision cannot be attributed to the original pending response.
    if (existing) return {jsonrpc: '2.0', id: null, error: {code: -32600,
      message: isPlan && existing.isPlan ? 'DUPLICATE_ACTIVE_PLAN_REQUEST' : 'DUPLICATE_ACTIVE_REQUEST'}};
    const entry = {isPlan, controller: undefined};
    active.set(request.id, entry);
    const release = () => active.delete(request.id);
    try {
      retainResponseId?.(release);
      let result;
      if (request.method === 'initialize') {
        const versions = ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'];
        // SDK2 stateless upstream has no initialize; terminate the legacy handshake
        // here and speak only tools/list and tools/call to HTTP.
        const health = await call('tools/call', { name: 'health', arguments: {} });
        requireHealth(health);
        initialized = true;
        result = { protocolVersion: versions.includes(request.params?.protocolVersion) ? request.params.protocolVersion : '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'vortex-agent-bridge', version: '1.1.0' } };
      } else if (request.method === 'ping') result = {};
      else if (['tools/list', 'tools/call'].includes(request.method)) {
        if (!initialized) throw new Error('Initialize the bridge first');
        if (isPlan) {
          const controller = new AbortController(); entry.controller = controller;
          try {result = await clientRemote(request.method, request.params, call, {signal: controller.signal, journal});}
          finally {entry.controller = undefined;}
        } else result = await clientRemote(request.method, request.params || {}, call, {journal});
        if (request.method === 'tools/call' && !isToolResult(result)) throw new Error('Invalid Vortex tool result');
      } else return { jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } };
      return { jsonrpc: '2.0', id: request.id, result };
    } catch (error) { return { jsonrpc: '2.0', id: request.id, error: { code: -32000, message: error.message } }; }
    finally { if (!retainResponseId) release(); }
  };
  handle.cancelPendingPlans = () => {for (const entry of active.values()) entry.controller?.abort();};
  return handle;
}
async function readArgumentFile(filename) {
  const message = 'Could not read a stable ordinary arguments file (maximum 1 MiB)';
  const expectedPath = path.resolve(filename);
  const generation = info => [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':');
  const observePath = async () => {
    const info = await fs.lstat(expectedPath, {bigint: true});
    if (!info.isFile() || path.relative(expectedPath, await fs.realpath(expectedPath)) !== '') throw Error(message);
    return info;
  };
  try {
    const before = await observePath();
    if (before.size > BigInt(MAX_REQUEST_BYTES)) throw Error(message);
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0) | (fs.constants.O_NOFOLLOW ?? 0);
    const file = await fs.open(expectedPath, flags);
    try {
      const opened = await file.stat({bigint: true});
      const stamp = generation(opened);
      if (!opened.isFile() || stamp !== generation(before)) throw Error(message);
      const size = Number(opened.size), buffer = Buffer.alloc(size + 1);
      let bytesRead = 0;
      while (bytesRead < buffer.length) {
        const chunk = await file.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
        if (!chunk.bytesRead) break;
        bytesRead += chunk.bytesRead;
      }
      if (bytesRead !== size || generation(await file.stat({bigint: true})) !== stamp
        || generation(await observePath()) !== stamp) throw Error(message);
      return buffer.subarray(0, bytesRead);
    } finally { await file.close(); }
  } catch { throw Error(message); }
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.length) {
    const [mode, name, rawArgs, filename] = argv;
    const fromFile = rawArgs === '--args-file';
    if (!(mode === '--health' && argv.length === 1
      || mode === '--call' && (fromFile ? argv.length === 4 && filename : argv.length <= 3)))
      throw new Error('Usage: bridge.mjs [--health | --call TOOL [JSON_ARGUMENTS | --args-file FILE]]');
    if (mode === '--call' && !name) throw new Error('--call requires a tool name and optional JSON arguments');
    const args = rawArgs === undefined ? {} : parse(fromFile ? await readArgumentFile(filename) : rawArgs, MAX_REQUEST_BYTES);
    if (args === null || typeof args !== 'object' || Array.isArray(args))
      throw new Error('--call arguments must be a JSON object');
    const health = await remote('tools/call', { name: 'health', arguments: {} });
    requireHealth(health);
    const result = mode === '--health' ? health : await clientRemote('tools/call', { name, arguments: args });
    if (!isToolResult(result)) throw new Error('Invalid Vortex tool result');
    process.stdout.write(JSON.stringify(result) + '\n');
    if (result.isError) process.exitCode = 1;
    return;
  }
  await runStdio(process.stdin, process.stdout, handler());
}
export async function runStdio(input, output, handle, maxPending = 100) {
  if (!Number.isSafeInteger(maxPending) || maxPending < 1) throw new Error('Invalid MCP pending limit');
  const writes = new AbortController();
  let writing = Promise.resolve();
  const write = response => {
    const next = writing.then(() => new Promise((resolve, reject) => {
      if (writes.signal.aborted) { reject(writes.signal.reason); return; }
      const aborted = () => finish(writes.signal.reason);
      const finish = error => {
        writes.signal.removeEventListener('abort', aborted);
        if (error) reject(error);
        else resolve();
      };
      writes.signal.addEventListener('abort', aborted, {once: true});
      output.write(JSON.stringify(response) + '\n', finish);
    }));
    writing = next;
    return next;
  };
  // Concurrent requests preserve IDs; long writes must not block dialog reads.
  const pending = new Set();
  let activeDispatches = 0;
  const cancelPlans = () => handle.cancelPendingPlans?.();
  let failure;
  const failBridge = error => {
    if (failure !== undefined) return;
    failure = error instanceof Error ? error : new Error('MCP request failed');
    writes.abort(failure);
    cancelPlans();
    input.destroy?.();
  };
  const onOutputClose = () => failBridge(new Error('MCP output closed'));
  output.on('close', onOutputClose); output.on('error', failBridge);
  try {
    if (output.destroyed) throw new Error('MCP output closed');
    for await (const line of boundedLines(input)) {
      if (failure) throw failure;
      if (output.destroyed) throw new Error('MCP output closed');
      if (line !== null && !line.trim()) continue;
      let request, parseError;
      try { if (line === null) throw new Error(); request = parse(line, MAX_REQUEST_BYTES); }
      catch {
        parseError = { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } };
        if (activeDispatches === 0) {
          await write(parseError);
          continue;
        }
      }
      const notification = request?.jsonrpc === '2.0' && typeof request.method === 'string'
        && !Object.hasOwn(request, 'id');
      // A full active queue must still receive cancellation. Do not grow a
      // second ordinary-request queue: overload closes fail-closed, cancelling
      // later plan steps while finally waits for already invoked settlement.
      if (!notification && pending.size >= maxPending && activeDispatches > 0)
        throw new Error('MCP request capacity exceeded');
      // Parse replies share the bounded output queue. Waiting here for stdout
      // would prevent cancellation from reaching an in-flight plan.
      let dispatch, releaseResponseId;
      if (parseError) dispatch = Promise.resolve(parseError);
      else {
        activeDispatches++;
        // Keep the original ID reserved while its response is backpressured.
        dispatch = Promise.resolve(handle(request, release => { releaseResponseId = release; })).then(
          response => {activeDispatches--; return response;},
          error => {activeDispatches--; throw error;});
      }
      const work = dispatch.then(response => response ? write(response) : undefined).finally(() => releaseResponseId?.());
      pending.add(work);
      work.then(() => pending.delete(work), failBridge);
      if (pending.size >= maxPending) {
        // Let already-resolved handlers leave activeDispatches before deciding
        // whether this is native work or merely stdout backpressure.
        await Promise.resolve();
        if (pending.size >= maxPending && activeDispatches === 0) await Promise.race(pending);
      }
    }
    if (failure) throw failure;
  } catch (error) {
    failBridge(error);
    throw failure;
  } finally {
    cancelPlans();
    await Promise.allSettled(pending);
    output.off('close', onOutputClose); output.off('error', failBridge);
  }
  if (failure !== undefined) throw failure;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
