// Network boundary around the unchanged official action. No URLs/response bodies enter errors.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const API_ORIGIN = 'https://api.nexusmods.com';
// Official pinned schema specifies S3 multipart. The live Nexus API also issues
// canonical Cloudflare R2 endpoints (verified 2026-10-04); custom domains stay refused.
const S3_HOST = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)?s3(?:[.-][a-z]{2}(?:-[a-z]+)+-\d+)?\.amazonaws\.com$/;
const R2_HOST = /^(?:[a-z0-9][a-z0-9-]{1,61}[a-z0-9]\.)?[0-9a-f]{32}\.r2\.cloudflarestorage\.com$/;
const NEXUS_ID = /^(?:[1-9][0-9]{0,19}|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/;
const forbiddenHeaders = ['authorization', 'proxy-authorization', 'cookie', 'cookie2', 'host'];

function denied() { throw new Error('Network boundary refused request or upload destination.'); }

function writeBody(value) {
  if (typeof value !== 'string' || Buffer.byteLength(value) > 256_000) denied();
  let parsed;
  try { parsed = JSON.parse(value); } catch { denied(); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || JSON.stringify(parsed) !== value) denied();
  return parsed;
}

function requireBody(body, expected) {
  const actual = writeBody(body);
  const entries = Object.entries(expected);
  if (Object.keys(actual).length !== entries.length ||
    entries.some(([name, value]) => !Object.hasOwn(actual, name) || actual[name] !== value)) denied();
}

function versionFields(archiveName) {
  const input = name => process.env[`INPUT_${name}`]?.trim() || undefined;
  const flag = name => {
    const value = input(name);
    if (value === undefined) return undefined;
    if (value === 'true' || value === 'false') return value === 'true';
    denied();
  };
  // Match the pinned action's filename/category fallbacks and optional JSON
  // fields. Python supplies these same reviewed inputs to the action.
  const metadata = {
    name: input('DISPLAY_NAME') || archiveName,
    description: input('DESCRIPTION'),
    file_category: input('CATEGORY') || 'main',
    archive_existing_file: flag('ARCHIVE_EXISTING_VERSION') ?? false,
    primary_mod_manager_download: flag('PRIMARY_MOD_MANAGER_DOWNLOAD'),
    allow_mod_manager_download: flag('ALLOW_MOD_MANAGER_DOWNLOAD'),
    show_requirements_pop_up: flag('SHOW_REQUIREMENTS_POP_UP'),
    update_mod_version: flag('UPDATE_MOD_VERSION') ?? false,
  };
  return Object.fromEntries(Object.entries(metadata).filter(([, value]) => value !== undefined));
}

function approvedURL(value, key) {
  if (typeof value !== 'string') denied();
  let url;
  try { url = new URL(value); } catch { denied(); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) denied();
  // The Nexus key must never appear in a URL, including an API-issued storage URL.
  let decoded;
  try { decoded = decodeURIComponent(url.href); } catch { denied(); }
  if (key && (value.includes(key) || decoded.includes(key))) denied();
  for (const name of url.searchParams.keys()) {
    if (/^(apikey|api_key|authorization|cookie)$/i.test(name)) denied();
  }
  return url;
}

function storageURL(value, key) {
  const url = approvedURL(value, key);
  if (!S3_HOST.test(url.hostname) && !R2_HOST.test(url.hostname)) denied();
  return url.href;
}

async function boundedText(response, maximum) {
  const reader = response.body?.getReader();
  if (!reader) denied();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) denied();
      chunks.push(value);
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  } catch { denied(); }
  finally {
    // Cancellation itself can stall on a hostile stream. Refusal must not wait
    // for the producer; also release ownership of the reader on every path.
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function completionXML(request, response, parts) {
  if (typeof request !== 'string' || Buffer.byteLength(request) > 3_000_000) denied();
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    ['SYSTEMROOT', 'WINDIR', 'PATH', 'TEMP', 'TMP', 'HOME', 'USERPROFILE'].includes(key.toUpperCase())));
  const result = spawnSync(process.env.NEXUS_PYTHON || 'python',
    ['-B', '-I', fileURLToPath(new URL('./completion-xml.py', import.meta.url))],
    { input: JSON.stringify({ request, response, parts }), env, timeout: 10000, maxBuffer: 1024, windowsHide: true });
  if (result.status !== 0 || result.error || result.stdout?.length || result.stderr?.length) denied();
}

export function installFetchGuard(nativeFetch = globalThis.fetch, apiKey = process.env.INPUT_API_KEY?.trim(),
  { archiveBytes = Number(process.env.NEXUS_ARCHIVE_BYTES), fileId = process.env.INPUT_FILE_ID?.trim(),
    modId = process.env.INPUT_MOD_ID?.trim(), version = process.env.INPUT_VERSION?.trim(),
    changelog = process.env.INPUT_CHANGELOG?.trim(), dispatcher,
    archiveName = path.basename(process.env.INPUT_FILENAME?.trim() || ''),
    versionMetadata = versionFields(archiveName) } = {}) {
  const approvedMetadata = { ...versionMetadata };
  let plan = null;
  let reservationSent = false;
  let failed = false;
  async function guardedFetch(input, init = {}) {
    if (failed) denied();
    if (dispatcher && globalThis[Symbol.for('undici.globalDispatcher.1')] !== dispatcher) denied();
    const url = approvedURL(input instanceof Request ? input.url : String(input), apiKey);
    const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined));
    const method = String(init.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const credentials = init.credentials ?? (input instanceof Request ? input.credentials : undefined);
    if (forbiddenHeaders.some(name => headers.has(name)) || credentials === 'include' || init.dispatcher) denied();
    let finalising = false, creatingVersion = false;
    if (url.origin === API_ORIGIN) {
      if (!apiKey || headers.get('apikey') !== apiKey || !url.pathname.startsWith('/v3/')) denied();
      headers.set('Application-Name', 'Nexus-Agent-Publication');
      headers.set('Application-Version', '1.0');
      if (method !== 'GET') {
        if (method !== 'POST' || url.search || input instanceof Request) denied();
        if (url.pathname === '/v3/uploads/multipart') {
          if (reservationSent || !Number.isSafeInteger(archiveBytes) || archiveBytes <= 0 || !archiveName) denied();
          requireBody(init.body, { filename: archiveName, size_bytes: String(archiveBytes) });
          // Claim before awaiting transport. An unusable response does not rule out a remote write.
          reservationSent = true;
        } else if (/^\/v3\/uploads\/[^/]+\/finalise$/.test(url.pathname)) {
          if (!plan?.completed || plan.finaliseSent || init.body != null ||
            url.pathname !== `/v3/uploads/${plan.id}/finalise`) denied();
          plan.finaliseSent = true;
          finalising = true;
        } else if (/^\/v3\/mod-files\/[^/]+\/versions$/.test(url.pathname)) {
          if (!plan?.finalised || plan.versionSent || !NEXUS_ID.test(fileId) || !version
            || url.pathname !== `/v3/mod-files/${fileId}/versions`) denied();
          requireBody(init.body, { ...approvedMetadata, upload_id: plan.id, version });
          plan.versionSent = true;
          creatingVersion = true;
        } else if (/^\/v3\/mods\/[^/]+\/changelogs$/.test(url.pathname)) {
          if (!plan?.versionCreated || plan.changelogSent || !NEXUS_ID.test(modId)
            || url.pathname !== `/v3/mods/${modId}/changelogs` || !changelog) denied();
          requireBody(init.body, { version, changelog });
          plan.changelogSent = true;
        } else {
          denied();
        }
      }
    } else {
      if (headers.has('apikey') || headers.has('api_key')) denied();
      // Official storage behavior supplies only content headers, never credential/routing headers.
      for (const [name, value] of headers) {
        if (!['content-type', 'content-length'].includes(name) || (apiKey && value.includes(apiKey))) denied();
      }
      storageURL(url.href, apiKey);
      if (!plan) denied();
      const part = plan.parts.find(part => part.url === url.href);
      if (part && method === 'PUT') {
        const bytes = ArrayBuffer.isView(init.body) ? init.body.byteLength : -1;
        if (part.state !== 'pending' || bytes !== part.bytes || headers.get('content-length') !== String(part.bytes)) denied();
        // Reserve synchronously BEFORE awaiting fetch: concurrent duplicate sends are forbidden.
        part.state = 'sending';
      } else if (url.href === plan.complete && method === 'POST') {
        if (plan.completing || plan.completed || plan.parts.some(part => part.state !== 'done')
          || plan.parts.reduce((sum, part) => sum + part.bytes, 0) !== archiveBytes) denied();
        completionXML(init.body, null, plan.parts.map((part, index) => [index + 1, part.etag]));
        plan.completing = true;
      } else denied();
    }
    // The reviewed Node 24.13.0 built-in transport predates the keep-alive queue-poisoning fix.
    // Disable reuse on every upload/read/poll request, independently of dispatcher version.
    headers.set('Connection', 'close');
    // A native fetch redirect can retain custom apikey headers. Disable ALL redirects at transport.
    let response;
    try {
      response = await nativeFetch(input instanceof Request ? input : url.href,
        { ...init, headers, redirect: 'error', credentials: 'omit', ...(dispatcher ? { dispatcher } : {}) });
    } catch { failed = true; denied(); }
    // Also fail closed for injected transports that return a redirect instead of honoring redirect:error.
    if (response.status >= 300 && response.status < 400) denied();
    if (finalising && response.ok) plan.finalised = true;
    if (creatingVersion && response.ok) plan.versionCreated = true;
    if (url.origin === API_ORIGIN && url.pathname === '/v3/uploads/multipart' && method === 'POST' && response.ok) {
      let data, text;
      // A cloned response tees the stream. Cancelling only the inspected branch
      // waits forever if the official action has not read the other branch yet.
      // Inspect the sole stream, then give the action the bounded buffered body.
      try { text = await boundedText(response, 4_000_000); ({ data } = JSON.parse(text)); } catch { failed = true; denied(); }
      if (!Array.isArray(data?.part_presigned_urls) || !data.part_presigned_urls.length) denied();
      if (!Number.isSafeInteger(archiveBytes) || archiveBytes <= 0
        || !Number.isSafeInteger(data.part_size_bytes) || data.part_size_bytes <= 0 || data.part_size_bytes > 64 * 1024 * 1024
        || data.part_presigned_urls.length > 10000
        || data.part_presigned_urls.length !== Math.ceil(archiveBytes / data.part_size_bytes)
        || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(data.id)) denied();
      // Validate the whole plan BEFORE allowing even the first part upload.
      const parts = data.part_presigned_urls.map(value => storageURL(value, apiKey));
      const complete = storageURL(data.complete_presigned_url, apiKey);
      if (new Set(parts).size !== parts.length || parts.includes(complete)) denied();
      const finish = new URL(complete);
      if (finish.searchParams.getAll('uploadId').length !== 1 || !finish.searchParams.get('uploadId') || finish.searchParams.has('partNumber')) denied();
      for (const [index, value] of parts.entries()) {
        const part = new URL(value);
        if (part.origin !== finish.origin || part.pathname !== finish.pathname
          || part.searchParams.getAll('uploadId').length !== 1 || part.searchParams.get('uploadId') !== finish.searchParams.get('uploadId')
          || part.searchParams.getAll('partNumber').length !== 1 || part.searchParams.get('partNumber') !== String(index + 1)) denied();
      }
      plan = { id: data.id, complete, completing: false, completed: false,
        finaliseSent: false, finalised: false, versionSent: false, versionCreated: false, changelogSent: false,
        parts: parts.map((url, index) => ({ url, bytes: Math.min(data.part_size_bytes, archiveBytes - index * data.part_size_bytes), state: 'pending', etag: null })) };
      response = new Response(text, { status: response.status, statusText: response.statusText, headers: response.headers });
    } else if (url.origin !== API_ORIGIN && plan) {
      const part = plan.parts.find(part => part.url === url.href);
      if (!response.ok) { failed = true; denied(); }
      if (part) {
        const etag = response.headers.get('ETag')?.replace(/^"|"$/g, '');
        if (!etag || !/^[A-Za-z0-9._-]{1,200}$/.test(etag)) { failed = true; denied(); }
        part.etag = etag;
        part.state = 'done';
      } else {
        try {
          completionXML(init.body, await boundedText(response, 65536), plan.parts.map((part, index) => [index + 1, part.etag]));
        } catch { failed = true; denied(); }
        plan.completed = true;
      }
    }
    return response;
  }
  globalThis.fetch = guardedFetch;
  return guardedFetch;
}
