'use strict';
const fs = process.versions.electron ? require('original-fs') : require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const SOURCES = Object.freeze({
  ec3a29d58ea65a1ca84e456742c894a19efe96920a6710063d221d451a26d59a: 'official-2.9.1',
  ba2d8017558beabdd804aeaec182c0b949b2ce425b924e38c4807c8c29023060: 'reviewed-custom-2.9.1',
});
const need = (v, c) => { if (!v) throw Error('NATIVE_DIALOG_' + c); };
const stamp = s => `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}:${s.nlink}`;
function hashFile(io, file, expected) {
  const fd = io.openSync(file, 'r'), hash = crypto.createHash('sha256'), bytes = Buffer.alloc(1024 * 1024);
  let failed = false;
  try {
    need(stamp(io.fstatSync(fd,{bigint:true})) === expected, 'SOURCE_CHANGED_DURING_HASH');
    let n; while ((n = io.readSync(fd, bytes, 0, bytes.length, null)) !== 0) hash.update(bytes.subarray(0, n));
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
    need(api.getState()?.app?.appVersion === '2.9.1', 'HOST_VERSION_UNSUPPORTED');
    const exe = getPath.call(api, 'exe');
    need(typeof exe === 'string' && path.isAbsolute(exe) && path.basename(exe).toLowerCase() === 'vortex.exe', 'HOST_EXE_INVALID');
    const executable = io.lstatSync(exe, {bigint:true});
    need(executable.isFile() && !executable.isSymbolicLink(), 'HOST_EXE_INVALID');
    const source = path.join(path.dirname(exe), 'resources', 'app.asar'), hostGeneration = generation();
    const before = observe(io, source), signature = JSON.stringify({hostGeneration,exe,source,...before});
    if (cached) { need(cached.signature === signature, 'SOURCE_CHANGED_IN_HOST'); return cached.proof; }
    const sha256 = hash(source,before.stamp); need(Object.hasOwn(SOURCES,sha256), 'HOST_SOURCE_UNREVIEWED');
    need(generation() === hostGeneration && getPath.call(api,'exe') === exe && JSON.stringify(observe(io,source)) === JSON.stringify(before), 'SOURCE_CHANGED_DURING_HASH');
    const proof = Object.freeze({schema:'native-dialog-host-source/1',hostGeneration,appAsarSHA256:sha256,variant:SOURCES[sha256]});
    cached = {signature,proof}; return proof;
  };
}
module.exports = {createNativeDialogHostAdmission,SOURCES};
