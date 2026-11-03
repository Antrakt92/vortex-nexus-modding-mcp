'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const need = (value, code) => { if (!value) throw Error(code); };
const key = value => path.resolve(value).replace(/\\/g, '/').toLowerCase();
const generation = stat => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
const isHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

// Bindings are maintainer-reviewed inputs, never values accepted from an MCP request.
// Each dynamic extension's files must cover its reviewed executable import closure.
function createLocalInstallHostAdmission({ packagePath, expected, api, fsImpl = fs }) {
  need(typeof packagePath === 'string' && path.isAbsolute(packagePath)
    && isHash(expected?.appAsarSha256) && Array.isArray(expected.dynamic)
    && expected.dynamic.length <= 256 && typeof api?.getLoadedExtensions === 'function',
  'LOCAL_INSTALL_HOST_BINDING_INVALID');
  const app = { path: path.resolve(packagePath), sha256: expected.appAsarSha256 };
  const dynamic = new Map();
  for (const entry of expected.dynamic) {
    need(typeof entry?.path === 'string' && path.isAbsolute(entry.path)
      && !dynamic.has(key(entry.path)) && Array.isArray(entry.files)
      && entry.files.length > 0 && entry.files.length <= 128, 'LOCAL_INSTALL_HOST_BINDING_INVALID');
    const root = path.resolve(entry.path), names = new Set();
    const files = entry.files.map(file => {
      need(typeof file?.path === 'string' && file.path.length > 0
        && !/[\\:\x00-\x1f]/.test(file.path)
        && file.path.split('/').every(part => part && part !== '.' && part !== '..')
        && isHash(file.sha256), 'LOCAL_INSTALL_HOST_BINDING_INVALID');
      const target = path.resolve(root, file.path);
      need(!names.has(key(target)), 'LOCAL_INSTALL_HOST_BINDING_INVALID');
      names.add(key(target));
      return { path: target, sha256: file.sha256 };
    });
    need(names.has(key(path.join(root, 'index.js'))) || names.has(key(path.join(root, 'index.cjs'))),
      'LOCAL_INSTALL_HOST_BINDING_INVALID');
    dynamic.set(key(root), { root, files });
  }
  const cache = new Map();
  async function inspect(target) {
    for (let current = target; ; current = path.dirname(current)) {
      const stat = await fsImpl.lstat(current, { bigint: true });
      need(!stat.isSymbolicLink(), 'LOCAL_INSTALL_HOST_REPARSE_PATH');
      if (current === target) need(stat.isFile(), 'LOCAL_INSTALL_HOST_SOURCE_NOT_FILE');
      if (current === path.dirname(current)) break;
    }
    return fsImpl.lstat(target, { bigint: true });
  }
  async function prove(file) {
    const before = await inspect(file.path), stamp = generation(before);
    const cached = cache.get(file.path);
    if (cached?.generation === stamp) {
      need(cached.sha256 === file.sha256, 'LOCAL_INSTALL_HOST_SOURCE_HASH_MISMATCH');
      return { path: file.path, generation: stamp, sha256: cached.sha256 };
    }
    const handle = await fsImpl.open(file.path, 'r');
    let hash;
    try {
      need(generation(await handle.stat({ bigint: true })) === stamp,
        'LOCAL_INSTALL_HOST_SOURCE_CHANGED');
      hash = crypto.createHash('sha256');
      const buffer = Buffer.alloc(256 * 1024);
      for (;;) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
        if (!bytesRead) break;
        hash.update(buffer.subarray(0, bytesRead));
      }
      need(generation(await handle.stat({ bigint: true })) === stamp,
        'LOCAL_INSTALL_HOST_SOURCE_CHANGED');
    } finally { await handle.close(); }
    need(generation(await inspect(file.path)) === stamp, 'LOCAL_INSTALL_HOST_SOURCE_CHANGED');
    const sha256 = hash.digest('hex');
    need(sha256 === file.sha256, 'LOCAL_INSTALL_HOST_SOURCE_HASH_MISMATCH');
    cache.set(file.path, { generation: stamp, sha256 });
    return { path: file.path, generation: stamp, sha256 };
  }
  function loaded() {
    const extensions = api.getLoadedExtensions();
    need(Array.isArray(extensions), 'LOCAL_INSTALL_HOST_EXTENSIONS_UNAVAILABLE');
    const roots = [];
    for (const extension of extensions) {
      need(extension && typeof extension === 'object' && typeof extension.dynamic === 'boolean',
        'LOCAL_INSTALL_HOST_EXTENSIONS_UNAVAILABLE');
      if (!extension.dynamic) continue;
      need(typeof extension.path === 'string' && path.isAbsolute(extension.path)
        && dynamic.has(key(extension.path)), 'LOCAL_INSTALL_HOST_UNKNOWN_EXTENSION');
      const root = key(extension.path);
      need(!roots.includes(root), 'LOCAL_INSTALL_HOST_EXTENSIONS_UNAVAILABLE');
      roots.push(root);
    }
    return roots.sort();
  }
  return async function assertHost() {
    const roots = loaded();
    const sources = [app, ...roots.flatMap(root => dynamic.get(root).files)];
    const proofs = [];
    for (const source of sources) proofs.push(await prove(source));
    need(JSON.stringify(loaded()) === JSON.stringify(roots), 'LOCAL_INSTALL_HOST_EXTENSIONS_CHANGED');
    for (const proof of proofs)
      need(generation(await inspect(proof.path)) === proof.generation, 'LOCAL_INSTALL_HOST_SOURCE_CHANGED');
    return { appAsarSha256: app.sha256, dynamicExtensions: roots.length, sources: proofs };
  };
}

module.exports = { createLocalInstallHostAdmission };
