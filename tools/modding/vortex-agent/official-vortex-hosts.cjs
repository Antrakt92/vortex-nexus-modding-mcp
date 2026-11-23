'use strict';

const hosts = new Map([
  ['2.9.1', require('./stock-vortex-2.9.1-admission.json')],
  ['2.10.1', require('./stock-vortex-2.10.1-admission.json')],
]);

function officialVortexHost(version) {
  return hosts.get(version);
}

function officialLocalInstallHost(version) {
  if (version === '2.11.0') return require('./stock-vortex-2.11.0-admission.json');
  return officialVortexHost(version);
}

module.exports = { officialVortexHost, officialLocalInstallHost };
