'use strict';
const crypto = require('node:crypto');
const { inflateRawSync, crc32 } = require('node:zlib');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const need = (ok, code) => { if (!ok) throw Error(code); };

const LIMITS = Object.freeze({ archiveBytes: 64 * 1024 * 1024, entryBytes: 64 * 1024 * 1024,
  totalBytes: 256 * 1024 * 1024, entries: 4096, evidenceBytes: 8 * 1024 * 1024 });

function relative(value, directory = false) {
  need(typeof value === 'string' && value.length > 0 && value.length <= 512
    && /^[A-Za-z0-9_./ -]+$/.test(value), 'OWN_BINDER_UNSAFE_PAYLOAD_PATH');
  const clean = directory && value.endsWith('/') ? value.slice(0, -1) : value;
  need(clean.split('/').every(part => part && part.length <= 255 && part !== '.' && part !== '..' && !/[. ]$/.test(part)
    && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)), 'OWN_BINDER_UNSAFE_PAYLOAD_PATH');
  need(!clean.split('/').some(p => p.toLowerCase() === 'fomod')
    && !/(?:^|\/)vortex_override_instructions\.json$/i.test(clean), 'OWN_BINDER_UNSUPPORTED_INSTALLER');
  return clean;
}

function extraFields(bytes) {
  // Naming/link/Unix extra fields can change extractor interpretation. The
  // first supported own-package recipe emits no extras, including timestamps.
  need(bytes.length === 0, 'OWN_BINDER_UNSUPPORTED_ZIP');
}

// ZIP proof reads bounded buffers only. It neither extracts files nor runs installers.
function inspectOwnZip(bytes) {
  need(Buffer.isBuffer(bytes) && bytes.length >= 22 && bytes.length <= LIMITS.archiveBytes, 'OWN_BINDER_ARCHIVE_LIMIT');
  let end = -1;
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 65557); at--) {
    if (bytes.readUInt32LE(at) === 0x06054b50 && at + 22 + bytes.readUInt16LE(at + 20) === bytes.length) { end = at; break; }
  }
  need(end >= 0, 'OWN_BINDER_UNSUPPORTED_ZIP');
  const count = bytes.readUInt16LE(end + 10), centralBytes = bytes.readUInt32LE(end + 12), central = bytes.readUInt32LE(end + 16);
  need(bytes.readUInt16LE(end + 4) === 0 && bytes.readUInt16LE(end + 6) === 0
    && bytes.readUInt16LE(end + 8) === count && count > 0 && count <= LIMITS.entries
    && central + centralBytes === end, 'OWN_BINDER_UNSUPPORTED_ZIP');
  let cursor = central, total = 0; const output = Object.create(null), names = new Map(), prefixes = new Map(), ranges = [];
  for (let n = 0; n < count; n++) {
    need(cursor + 46 <= end && bytes.readUInt32LE(cursor) === 0x02014b50, 'OWN_BINDER_UNSUPPORTED_ZIP');
    const flags = bytes.readUInt16LE(cursor + 8), method = bytes.readUInt16LE(cursor + 10), crc = bytes.readUInt32LE(cursor + 16);
    const packed = bytes.readUInt32LE(cursor + 20), unpacked = bytes.readUInt32LE(cursor + 24);
    const nameBytes = bytes.readUInt16LE(cursor + 28), extra = bytes.readUInt16LE(cursor + 30), comment = bytes.readUInt16LE(cursor + 32);
    const attributes = bytes.readUInt32LE(cursor + 38), local = bytes.readUInt32LE(cursor + 42), next = cursor + 46 + nameBytes + extra + comment;
    need(next <= end && bytes.readUInt16LE(cursor + 6) <= 20 && [0, 8].includes(method) && (flags & ~0x0806) === 0
      && bytes.readUInt16LE(cursor + 34) === 0 && unpacked <= LIMITS.entryBytes, 'OWN_BINDER_UNSUPPORTED_ZIP');
    const rawName = bytes.subarray(cursor + 46, cursor + 46 + nameBytes);
    need([...rawName].every(b => b < 128), 'OWN_BINDER_UNSAFE_PAYLOAD_PATH');
    const name = rawName.toString('ascii'), directory = name.endsWith('/'), clean = relative(name, directory);
    const mode = (attributes >>> 16) & 0xf000;
    need((mode === 0 || mode === (directory ? 0x4000 : 0x8000)) && (!(attributes & 0x10) || directory)
      && !(attributes & (0x08 | 0x40 | 0x400)), 'OWN_BINDER_UNSUPPORTED_ZIP');
    need(!names.has(clean.toLowerCase()), 'OWN_BINDER_DUPLICATE_ZIP_PATH'); names.set(clean.toLowerCase(), directory);
    const segments = clean.split('/');
    for (let n = 1; n <= segments.length; n++) {
      const prefix = segments.slice(0, n).join('/'), folded = prefix.toLowerCase();
      need(!prefixes.has(folded) || prefixes.get(folded) === prefix, 'OWN_BINDER_CASE_COLLISION'); prefixes.set(folded, prefix);
    }
    extraFields(bytes.subarray(cursor + 46 + nameBytes, cursor + 46 + nameBytes + extra));
    need(local + 30 <= central && bytes.readUInt32LE(local) === 0x04034b50, 'OWN_BINDER_UNSUPPORTED_ZIP');
    const localName = bytes.readUInt16LE(local + 26), localExtra = bytes.readUInt16LE(local + 28), data = local + 30 + localName + localExtra;
    need(data + packed <= central && bytes.readUInt16LE(local + 4) === bytes.readUInt16LE(cursor + 6)
      && bytes.readUInt16LE(local + 6) === flags && bytes.readUInt16LE(local + 8) === method
      && bytes.readUInt32LE(local + 14) === crc && bytes.readUInt32LE(local + 18) === packed
      && bytes.readUInt32LE(local + 22) === unpacked && localName === nameBytes
      && bytes.subarray(local + 30, local + 30 + localName).equals(rawName), 'OWN_BINDER_UNSUPPORTED_ZIP');
    extraFields(bytes.subarray(local + 30 + localName, data)); ranges.push([local, data + packed]);
    total += unpacked; need(total <= LIMITS.totalBytes, 'OWN_BINDER_ARCHIVE_LIMIT');
    let content;
    try {
      if (method === 0) content = bytes.subarray(data, data + packed);
      else {
        const result = inflateRawSync(bytes.subarray(data, data + packed), { maxOutputLength: Math.max(1, unpacked), info: true });
        need(result.engine.bytesWritten === packed, 'OWN_BINDER_ZIP_CONTENT_INVALID'); content = result.buffer;
      }
    }
    catch { throw Error('OWN_BINDER_ZIP_CONTENT_INVALID'); }
    need(content.length === unpacked && crc32(content) === crc, 'OWN_BINDER_ZIP_CONTENT_INVALID');
    if (directory) need(unpacked === 0 && packed === 0, 'OWN_BINDER_UNSUPPORTED_ZIP');
    else output[clean] = sha(content);
    cursor = next;
  }
  need(cursor === end && Object.keys(output).length > 0, 'OWN_BINDER_UNSUPPORTED_ZIP');
  ranges.sort((a, b) => a[0] - b[0]);
  need(ranges[0][0] === 0 && ranges.at(-1)[1] === central
    && ranges.every((range, n) => n === 0 || range[0] === ranges[n - 1][1]), 'OWN_BINDER_OVERLAPPING_ZIP');
  for (const name of names.keys()) {
    const parts = name.split('/');
    for (let n = 1; n < parts.length; n++) need(names.get(parts.slice(0, n).join('/')) !== false, 'OWN_BINDER_DUPLICATE_ZIP_PATH');
  }
  return { bytes: bytes.length, sha256: sha(bytes), md5: crypto.createHash('md5').update(bytes).digest('hex'),
    expectedUncompressedBytes: total, payload: output, crcVerified: true, payloadFiles: Object.keys(output).length };
}


module.exports = { LIMITS, inspectOwnZip, relativePayloadPath: relative };
