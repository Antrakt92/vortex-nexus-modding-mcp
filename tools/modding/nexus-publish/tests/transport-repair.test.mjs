import test from 'node:test';
import assert from 'node:assert/strict';
import { installFetchGuard } from '../fetch-guard.mjs';

const key = 'synthetic-fetch-key';
const api = 'https://api.nexusmods.com/v3/uploads/multipart';
const part = 'https://fixture.s3.eu-west-1.amazonaws.com/object?partNumber=1&uploadId=fixture';
const complete = 'https://fixture.s3.eu-west-1.amazonaws.com/object?uploadId=fixture';
const headers = { apikey: key };
const archive = { archiveName: 'fixture.zip', archiveBytes: 4 };
const create = { method: 'POST', headers, body: JSON.stringify({ filename: 'fixture.zip', size_bytes: '4' }) };
const uploadId = '11111111-1111-1111-1111-111111111111';
const finalise = `https://api.nexusmods.com/v3/uploads/${uploadId}/finalise`;
const versions = 'https://api.nexusmods.com/v3/mod-files/123/versions';
const plan = (size = 4, urls = [part]) => ({ data: { id: uploadId,
  part_size_bytes: size, part_presigned_urls: urls, complete_presigned_url: complete } });
const post = { method: 'POST', headers };
const versionRequest = (id = uploadId, version = '1.2.3') => ({ ...post, body: JSON.stringify({
  upload_id: id, version, name: 'fixture.zip', file_category: 'main',
  archive_existing_file: false, update_mod_version: false,
}) });

async function completeFixtureStorage(guard) {
  await guard(api, create);
  await guard(part, { method: 'PUT', headers: { 'content-length': '4' }, body: Buffer.alloc(4) });
  await guard(complete, { method: 'POST',
    body: '<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>fixture-etag</ETag></Part></CompleteMultipartUpload>' });
}

function storageFixture(url) {
  if (url === api) return Response.json(plan());
  if (url === part) return new Response(null, { headers: { ETag: 'fixture-etag' } });
  assert.equal(url, complete);
  return new Response('<CompleteMultipartUploadResult><Bucket>fixture</Bucket><Key>object</Key><ETag>fixture-etag</ETag></CompleteMultipartUploadResult>');
}

test('only one multipart reservation reaches transport even with a pending response', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const guard = installFetchGuard(async () => {
    calls++;
    await gate;
    return Response.json(plan());
  }, key, archive);

  const first = guard(api, create);
  const second = assert.rejects(guard(api, create), /Network boundary/);
  release();
  assert.deepEqual(await (await first).json(), plan());
  await second;
  assert.equal(calls, 1);
});

test('a sent reservation cannot be repeated after an unusable response', async () => {
  for (const response of [Response.json(plan(0)), new Response(null, { status: 503 })]) {
    let calls = 0;
    const guard = installFetchGuard(async () => {
      calls++;
      return calls === 1 ? response : Response.json(plan());
    }, key, archive);
    if (response.ok) await assert.rejects(guard(api, create), /Network boundary/);
    else assert.equal((await guard(api, create)).status, 503);
    await assert.rejects(guard(api, create), /Network boundary/);
    assert.equal(calls, 1);
  }
});

test('finalise is admitted once while a matching request is in flight', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let finaliseCalls = 0;
  const guard = installFetchGuard(async url => {
    if (url !== finalise) return storageFixture(url);
    finaliseCalls++;
    await gate;
    return Response.json({ data: { id: uploadId } });
  }, key, { ...archive, fileId: '123', version: '1.2.3' });

  await completeFixtureStorage(guard);
  const first = guard(finalise, post);
  const duplicate = assert.rejects(guard(finalise, post), /Network boundary/);
  release();
  assert.equal((await first).ok, true);
  await duplicate;
  await assert.rejects(guard(finalise, post), /Network boundary/);
  assert.equal(finaliseCalls, 1);
});

test('version creation is single-use and tied to the finalised upload and approved file', async () => {
  const writes = [];
  const guard = installFetchGuard(async url => {
    if (url === finalise || url.includes('/versions')) {
      writes.push(url);
      return Response.json({ data: {} });
    }
    return storageFixture(url);
  }, key, { ...archive, fileId: '123', version: '1.2.3' });

  await completeFixtureStorage(guard);
  await assert.rejects(guard(versions, versionRequest()), /Network boundary/);
  await guard(finalise, post);
  await assert.rejects(guard(versions, versionRequest('22222222-2222-2222-2222-222222222222')), /Network boundary/);
  await assert.rejects(guard(versions.replace('/123/', '/321/'), versionRequest()), /Network boundary/);
  await assert.rejects(guard(versions + '?force=true', versionRequest()), /Network boundary/);
  await assert.rejects(guard(versions + '/', versionRequest()), /Network boundary/);
  await assert.rejects(guard(versions, { ...post, body: `{"upload_id":"foreign","upload_id":"${uploadId}"}` }), /Network boundary/);
  assert.equal((await guard(versions, versionRequest())).ok, true);
  await assert.rejects(guard(versions, versionRequest()), /Network boundary/);
  assert.deepEqual(writes, [finalise, versions]);
});

test('changelog stays bound to the created version, approved mod and exact text', async () => {
  const changelogUrl = 'https://api.nexusmods.com/v3/mods/456/changelogs';
  const calls = [];
  const accepted = {...post, body: JSON.stringify({version: '1.2.3', changelog: 'Reviewed changes'})};
  const guard = installFetchGuard(async url => {
    if (url === finalise || url === versions || url.endsWith('/changelogs')) {
      calls.push(url);
      return Response.json({data: {}});
    }
    return storageFixture(url);
  }, key, {...archive, fileId: '123', modId: '456', version: '1.2.3', changelog: 'Reviewed changes'});

  await assert.rejects(guard(changelogUrl, accepted), /Network boundary/);
  await completeFixtureStorage(guard);
  await guard(finalise, post);
  await assert.rejects(guard(versions, versionRequest(uploadId, '2.0')), /Network boundary/);
  await guard(versions, versionRequest());
  await assert.rejects(guard(changelogUrl.replace('/456/', '/654/'), accepted), /Network boundary/);
  await assert.rejects(guard(changelogUrl, {...accepted, body: JSON.stringify({version: '1.2.3', changelog: 'Other text'})}), /Network boundary/);
  await guard(changelogUrl, accepted);
  await assert.rejects(guard(changelogUrl, accepted), /Network boundary/);
  assert.deepEqual(calls, [finalise, versions, changelogUrl]);
});

test('write payloads permit only the exact reviewed reservation, finalise and version fields', async () => {
  const writes = [];
  const metadata = {
    name: 'Reviewed name', description: 'Reviewed description', file_category: 'optional',
    archive_existing_file: false, primary_mod_manager_download: true, allow_mod_manager_download: false,
    show_requirements_pop_up: true, update_mod_version: false,
  };
  const guard = installFetchGuard(async (url, init) => {
    if (url === api || url === finalise || url === versions) writes.push([url, init.body]);
    return url === finalise || url === versions ? Response.json({ data: {} }) : storageFixture(url);
  }, key, { ...archive, fileId: '123', version: '1.2.3', versionMetadata: metadata });

  await assert.rejects(guard(api, { ...post, body: JSON.stringify({ filename: 'other.zip', size_bytes: '4' }) }), /Network boundary/);
  await completeFixtureStorage(guard);
  await assert.rejects(guard(finalise, { ...post, body: '{}' }), /Network boundary/);
  await assert.rejects(guard(new Request(finalise, { ...post, body: '{}' })), /Network boundary/);
  await guard(finalise, post);

  const accepted = { upload_id: uploadId, version: '1.2.3', ...metadata };
  for (const [name, expected] of Object.entries(metadata)) {
    const changed = typeof expected === 'boolean' ? !expected : 'unexpected';
    await assert.rejects(guard(versions, { ...post, body: JSON.stringify({ ...accepted, [name]: changed }) }), /Network boundary/, name);
  }
  const { description, ...incomplete } = accepted;
  await assert.rejects(guard(versions, { ...post, body: JSON.stringify(incomplete) }), /Network boundary/);
  await assert.rejects(guard(versions, { ...post, body: JSON.stringify({ ...accepted, extra: false }) }), /Network boundary/);
  await guard(versions, { ...post, body: JSON.stringify(accepted) });
  assert.deepEqual(writes, [[api, create.body], [finalise, undefined], [versions, JSON.stringify(accepted)]]);
});

test('Nexus-issued canonical Cloudflare R2 plan transfers without the Nexus key', async () => {
  const origin = 'https://test-bucket.0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com';
  const r2part = part.replace('https://fixture.s3.eu-west-1.amazonaws.com', origin);
  const r2complete = complete.replace('https://fixture.s3.eu-west-1.amazonaws.com', origin);
  let storage = 0;
  const guard = installFetchGuard(async (url, init) => {
    if (url === api) return Response.json({ data: { ...plan().data,
      part_presigned_urls: [r2part], complete_presigned_url: r2complete } });
    storage++;
    assert.equal(new Headers(init.headers).get('apikey'), null);
    assert.equal(init.redirect, 'error');
    if (url === r2part) return new Response('', { headers: { ETag: '"fixture-etag"' } });
    assert.equal(url, r2complete);
    return new Response('<CompleteMultipartUploadResult><Bucket>fixture</Bucket><Key>object</Key><ETag>fixture-etag</ETag></CompleteMultipartUploadResult>');
  }, key, archive);
  await guard(api, create);
  await guard(r2part, { method: 'PUT', headers: { 'content-length': '4' }, body: Buffer.alloc(4) });
  await guard(r2complete, { method: 'POST', body: '<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>fixture-etag</ETag></Part></CompleteMultipartUpload>' });
  assert.equal(storage, 2);
});

test('R2 suffix tricks, custom domains and noncanonical account IDs stay forbidden', async () => {
  for (const host of ['r2.cloudflarestorage.com', 'bad.r2.cloudflarestorage.com',
    '0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com.attacker.invalid',
    'nested.bucket.0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com',
    '-bucket.0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com',
    '0123456789abcdef0123456789abcdef.r2.dev']) {
    let calls = 0;
    const guard = installFetchGuard(async () => { calls++; return Response.json({ data: {
      ...plan().data, part_presigned_urls: [part.replace('fixture.s3.eu-west-1.amazonaws.com', host)],
      complete_presigned_url: complete.replace('fixture.s3.eu-west-1.amazonaws.com', host),
    } }); }, key, archive);
    await assert.rejects(guard(api, create));
    assert.equal(calls, 1);
  }
});

test('an oversized streaming multipart response is cancelled and refused promptly', async () => {
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(4_000_001)); },
    cancel() { cancelled = true; },
  });
  const guard = installFetchGuard(async () => new Response(body), key, archive);
  let timer;
  try {
    const outcome = await Promise.race([
      guard(api, create).then(() => 'accepted', () => 'refused'),
      new Promise(resolve => { timer = setTimeout(() => resolve('stalled'), 250); }),
    ]);
    assert.equal(outcome, 'refused');
    assert.equal(cancelled, true);
  } finally { clearTimeout(timer); }
});

test('refusal does not wait for an uncooperative cancellation; valid plan remains readable by the action', async () => {
  const guard = installFetchGuard(async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(4_000_001)); },
    cancel() { return new Promise(() => {}); },
  })), key, archive);
  let timer;
  try {
    assert.equal(await Promise.race([
      guard(api, create).then(() => 'accepted', () => 'refused'),
      new Promise(resolve => { timer = setTimeout(() => resolve('stalled'), 250); }),
    ]), 'refused');
  } finally { clearTimeout(timer); }
  const valid = installFetchGuard(async () => Response.json(plan()), key, archive);
  assert.deepEqual(await (await valid(api, create)).json(), plan());
});

test('inconsistent, unbounded and duplicate multipart plans are refused before storage', async () => {
  for (const body of [plan(1), plan(0), plan(-1), plan(1.5), plan('4'), plan(2, [part, part]), plan(2 ** 40)]) {
    let calls = 0;
    const guard = installFetchGuard(async () => { calls++; return Response.json(body); }, key, archive);
    await assert.rejects(guard(api, create));
    assert.equal(calls, 1);
  }
});

test('a short body never reaches storage, and completion requires all uploaded bytes', async () => {
  let storageCalls = 0;
  const guard = installFetchGuard(async url => {
    if (url === api) return Response.json(plan());
    storageCalls++;
    return new Response('');
  }, key, archive);
  await guard(api, create);
  await assert.rejects(guard(part, { method: 'PUT', headers: { 'content-length': '1' }, body: Buffer.alloc(1) }));
  await assert.rejects(guard(complete, { method: 'POST', body: '<CompleteMultipartUpload/>' }));
  assert.equal(storageCalls, 0);
});

test('S3 HTTP-200 Error is refused before Nexus finalise', async () => {
  const guard = installFetchGuard(async url => {
    if (url === api) return Response.json(plan());
    if (url === part) return new Response('', { headers: { ETag: '"fixture-etag"' } });
    return new Response('<Error><Code>InternalError</Code></Error>', { status: 200 });
  }, key, archive);
  await guard(api, create);
  await guard(part, { method: 'PUT', headers: { 'content-length': '4' }, body: Buffer.alloc(4) });
  await assert.rejects(guard(complete, { method: 'POST', body: '<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>fixture-etag</ETag></Part></CompleteMultipartUpload>' }));
});

test('concurrent duplicate part, gap and early completion are denied; full coverage completes once', async () => {
  const second = part.replace('partNumber=1', 'partNumber=2');
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  let storageCalls = 0;
  const guard = installFetchGuard(async url => {
    if (url === api) return Response.json(plan(2, [part, second]));
    storageCalls++;
    if (url === part) await pending;
    if (url === complete) return new Response('<CompleteMultipartUploadResult><Bucket>fixture</Bucket><Key>object</Key><ETag>result</ETag></CompleteMultipartUploadResult>');
    return new Response('', { headers: { ETag: '"fixture-etag"' } });
  }, key, archive);
  await guard(api, create);
  const transfer = { method: 'PUT', headers: { 'content-length': '2' }, body: Buffer.alloc(2) };
  const first = guard(part, transfer);
  await assert.rejects(guard(part, transfer));
  await assert.rejects(guard(complete, { method: 'POST', body: '<CompleteMultipartUpload/>' }));
  assert.equal(storageCalls, 1);
  release();
  await first;
  await guard(second, transfer);
  const request = '<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>fixture-etag</ETag></Part><Part><PartNumber>2</PartNumber><ETag>fixture-etag</ETag></Part></CompleteMultipartUpload>';
  await guard(complete, { method: 'POST', body: request });
  await assert.rejects(guard(complete, { method: 'POST', body: request }));
  assert.equal(storageCalls, 3);
});

test('part-number gaps, reordered plan and mismatched object/upload ID never reach storage', async () => {
  for (const urls of [[part.replace('partNumber=1', 'partNumber=2')],
                     [part.replace('uploadId=fixture', 'uploadId=other')],
                     [part.replace('/object?', '/other?')]]) {
    let calls = 0;
    const guard = installFetchGuard(async () => { calls++; return Response.json(plan(4, urls)); }, key, archive);
    await assert.rejects(guard(api, create));
    assert.equal(calls, 1);
  }
});

test('bounded XML rejects empty, malformed, entity, wrong namespace, oversize and embedded errors', async () => {
  for (const xml of ['', '<broken>', '<!DOCTYPE x [<!ENTITY bomb "value">]><CompleteMultipartUploadResult/>',
    '<CompleteMultipartUploadResult xmlns="https://wrong.invalid"><Bucket>fixture</Bucket><Key>object</Key><ETag>ok</ETag></CompleteMultipartUploadResult>',
    'x'.repeat(65537), '<CompleteMultipartUploadResult><Bucket>fixture</Bucket><Key>object</Key><ETag>ok</ETag><Error/></CompleteMultipartUploadResult>',
    '<CompleteMultipartUploadResult/>']) {
    const guard = installFetchGuard(async url => url === api ? Response.json(plan()) : url === part
      ? new Response('', { headers: { ETag: '"fixture-etag"' } }) : new Response(xml), key, archive);
    await guard(api, create);
    await guard(part, { method: 'PUT', headers: { 'content-length': '4' }, body: Buffer.alloc(4) });
    await assert.rejects(guard(complete, { method: 'POST', body: '<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>fixture-etag</ETag></Part></CompleteMultipartUpload>' }));
    await assert.rejects(guard('https://api.nexusmods.com/v3/uploads/11111111-1111-1111-1111-111111111111/finalise', { method: 'POST', headers }));
  }
});

test('completion request must list exactly all confirmed ETags before storage sees it', async () => {
  let completeCalls = 0;
  const guard = installFetchGuard(async url => {
    if (url === api) return Response.json(plan());
    if (url === part) return new Response('', { headers: { ETag: '"fixture-etag"' } });
    completeCalls++;
    return new Response('');
  }, key, archive);
  await guard(api, create);
  await guard(part, { method: 'PUT', headers: { 'content-length': '4' }, body: Buffer.alloc(4) });
  for (const xml of ['<CompleteMultipartUpload/>', '<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>wrong</ETag></Part></CompleteMultipartUpload>',
    '<!DOCTYPE x><CompleteMultipartUpload/>']) {
    await assert.rejects(guard(complete, { method: 'POST', body: xml }));
  }
  assert.equal(completeCalls, 0);
});
