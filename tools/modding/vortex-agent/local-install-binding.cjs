'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createLocalInstallHostAdmission } = require('./local-install-host.cjs');
const manifest = require('./stock-vortex-2.9.1-admission.json');
const admissions = new WeakMap();
const OFFICIAL_HOST = 'ec3a29d58ea65a1ca84e456742c894a19efe96920a6710063d221d451a26d59a';
function localInstallAdmission(api, util, bindingOverride) {
  return async () => {
    if (!admissions.has(api)) {
      // Shipped maintainer-reviewed sources, never hashes supplied by an agent's
      // tool request. Unreviewed host/extension updates refuse installation.
      let binding = bindingOverride;
      if (!binding) {
        const packagePath = path.join(path.dirname(process.execPath), 'resources/app.asar');
        const bundled = path.join(path.dirname(packagePath), 'app.asar.unpacked/bundledPlugins');
        const user = path.join(util.getVortexPath('userData'), 'plugins');
        const dynamic = [];
        for (const extension of api.getLoadedExtensions()) {
          if (!extension.dynamic) continue;
          const root = path.resolve(extension.path), norm = p => path.resolve(p).toLowerCase();
          if (norm(root) === norm(__dirname)) {
            const provenance = JSON.parse(fs.readFileSync(path.join(__dirname, 'provenance.json'), 'utf8'));
            if (!/^[a-f0-9]{64}$/.test(provenance.pluginSha256 || '')) throw Error('LOCAL_INSTALL_HOST_BINDING_INVALID');
            dynamic.push({ path: root, files: [{ path: 'index.js', sha256: provenance.pluginSha256 }] });
            continue;
          }
          const kind = norm(path.dirname(root)) === norm(bundled) ? 'bundled'
            : norm(path.dirname(root)) === norm(user) ? 'user' : null;
          const known = manifest.extensions.find(e => e.kind === kind && e.folder === path.basename(root));
          if (!known) throw Error('LOCAL_INSTALL_HOST_UNKNOWN_EXTENSION');
          dynamic.push({ path: root, files: known.files });
        }
        binding = { packagePath, expected: { appAsarSha256: manifest.appAsarSha256, dynamic } };
      }
      if (binding?.expected?.appAsarSha256 !== OFFICIAL_HOST) throw Error('LOCAL_INSTALL_HOST_UNREVIEWED_VERSION');
      const actual = path.join(path.dirname(process.execPath), 'resources/app.asar');
      if (path.resolve(binding.packagePath).toLowerCase() !== path.resolve(actual).toLowerCase())
        throw Error('LOCAL_INSTALL_HOST_RUNTIME_PATH_MISMATCH');
      // Electron's patched node:fs presents app.asar as a directory. Hash the
      // actual package file through Electron's original filesystem implementation.
      admissions.set(api, createLocalInstallHostAdmission({ ...binding, api, fsImpl: require('original-fs').promises }));
    }
    return admissions.get(api)();
  };
}
module.exports = { localInstallAdmission };
