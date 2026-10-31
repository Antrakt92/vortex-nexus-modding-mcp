'use strict';
const core = require('./paths-core.cjs');

function resolvePaths({ env = process.env, sourceDir = __dirname,
  compiledWorkspace = typeof __NEXUS_WORKSPACE__ === 'undefined' ? undefined : __NEXUS_WORKSPACE__ } = {}) {
  return core.resolvePaths({ env, sourceDir, compiledWorkspace });
}

module.exports = { absolute: core.absolute, resolvePaths, ...resolvePaths() };
