'use strict';
const fs = process.versions.electron ? require('original-fs') : require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const SOURCES = Object.freeze({
  ec3a29d58ea65a1ca84e456742c894a19efe96920a6710063d221d451a26d59a: 'official-2.9.1',
  ba2d8017558beabdd804aeaec182c0b949b2ce425b924e38c4807c8c29023060: 'reviewed-custom-2.9.1',
  '0e308d6589719c5d68236c0930efda803e19ff41a3bbe8bd09330311c004fb95': 'official-2.10.1',
  '5b9e9d725775e1c7f507680fc89840cbad7e8a4c83e410b7be22ef66009c7e4d': 'official-2.11.0',
});
const need = (v, c) => { if (!v) throw Error('NATIVE_DIALOG_' + c); };
const stamp = s => `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}:${s.nlink}`;
function hashFile(io, file, expected) {
  const fd = io.openSync(file, 'r'), hash = crypto.createHash('sha256'), bytes = Buffer.alloc(1024 * 1024);
  let failed = false;
  try {
    const before = io.fstatSync(fd,{bigint:true});
    need(stamp(before) === expected, 'SOURCE_CHANGED_DURING_HASH');
    for (let remaining = before.size; remaining > 0n;) {
      const length = remaining < BigInt(bytes.length) ? Number(remaining) : bytes.length;
      const count = io.readSync(fd, bytes, 0, length, null);
      need(count > 0 && count <= length, 'SOURCE_CHANGED_DURING_HASH');
      hash.update(bytes.subarray(0, count));
      remaining -= BigInt(count);
    }
    need(stamp(io.fstatSync(fd,{bigint:true})) === expected, 'SOURCE_CHANGED_DURING_HASH');
    return hash.digest('hex');
  }
  catch (error) { failed = true; throw error; }
  finally { try { io.closeSync(fd); } catch (error) { if (!failed) throw error; } }
}
function observe(io, file) {
  const parents = []; let dir = path.dirname(file);
  for (;;) {
    const s = io.lstatSync(dir, {bigint:true});
    need(s.isDirectory() && !s.isSymbolicLink(), 'SOURCE_PATH_NOT_PLAIN');
    parents.push([dir, `${s.dev}:${s.ino}`]);
    const next = path.dirname(dir); if (next === dir) break; dir = next;
  }
  const s = io.lstatSync(file, {bigint:true});
  need(s.isFile() && !s.isSymbolicLink() && s.nlink === 1n, 'SOURCE_NOT_PLAIN_FILE');
  return {parents, stamp:stamp(s)};
}
// Seams are module-internal test dependencies, never accepted from an MCP request.
function createNativeDialogHostAdmission(api, {io=fs, processInfo=process, hash=(file,expected)=>hashFile(io,file,expected)}={}) {
  const getPath = api.getPath; let cached;
  function generation() {
    need(Number.isSafeInteger(processInfo.pid) && processInfo.pid > 0 && typeof processInfo.getCreationTime === 'function', 'HOST_GENERATION_UNAVAILABLE');
    const created = processInfo.getCreationTime();
    need(Number.isFinite(created) && created > 0, 'HOST_GENERATION_UNAVAILABLE');
    return `${processInfo.pid}:${created}`;
  }
  return function assertHost() {
    need(typeof getPath === 'function' && api.getPath === getPath, 'HOST_API_CHANGED');
    const version = api.getState()?.app?.appVersion;
    need(version === '2.9.1' || version === '2.10.1' || version === '2.11.0', 'HOST_VERSION_UNSUPPORTED');
    const exe = getPath.call(api, 'exe');
    need(typeof exe === 'string' && path.isAbsolute(exe) && path.basename(exe).toLowerCase() === 'vortex.exe', 'HOST_EXE_INVALID');
    const executable = io.lstatSync(exe, {bigint:true});
    need(executable.isFile() && !executable.isSymbolicLink(), 'HOST_EXE_INVALID');
    const source = path.join(path.dirname(exe), 'resources', 'app.asar'), hostGeneration = generation();
    const before = observe(io, source), signature = JSON.stringify({hostGeneration,version,exe,source,...before});
    if (cached) { need(cached.signature === signature, 'SOURCE_CHANGED_IN_HOST'); return cached.proof; }
    const sha256 = hash(source,before.stamp);
    const variant = Object.hasOwn(SOURCES,sha256) ? SOURCES[sha256] : null;
    need(variant?.endsWith('-' + version), 'HOST_SOURCE_UNREVIEWED');
    need(generation() === hostGeneration && getPath.call(api,'exe') === exe
      && api.getState()?.app?.appVersion === version && JSON.stringify(observe(io,source)) === JSON.stringify(before), 'SOURCE_CHANGED_DURING_HASH');
    const proof = Object.freeze({schema:'native-dialog-host-source/1',hostGeneration,appAsarSHA256:sha256,variant});
    cached = {signature,proof}; return proof;
  };
}
module.exports = {createNativeDialogHostAdmission,SOURCES};
