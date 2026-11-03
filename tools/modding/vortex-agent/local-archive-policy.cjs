'use strict';

function validateLocalArchiveName(archiveName) {
  if (typeof archiveName !== 'string' || archiveName.length > 120 || !archiveName.endsWith('.zip')
    || !/^[A-Za-z0-9][A-Za-z0-9_.-]*\.zip$/.test(archiveName))
    throw Error('LOCAL_ARCHIVE_NAME_INVALID');
  const expectedId = archiveName.slice(0, -4);
  // Windows trims a final dot and reserves device names, even with extensions.
  if (expectedId.endsWith('.') || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(expectedId))
    throw Error('LOCAL_ARCHIVE_NAME_INVALID');
  return expectedId;
}

function alias(value) {
  if (typeof value !== 'string' || !value) throw Error('LOCAL_ARCHIVE_INVENTORY_INVALID');
  const name = value.replace(/\\/g, '/').split('/').at(-1).replace(/[. ]+$/, '').toLowerCase();
  if (!name) throw Error('LOCAL_ARCHIVE_INVENTORY_INVALID');
  return name;
}

function assertLocalArchiveAdmission({ archiveName, mods, existingDirectories, metadata,
  autoEnable, autoDeploy } = {}) {
  const expectedId = validateLocalArchiveName(archiveName);
  if (autoEnable !== false || autoDeploy !== false) throw Error('LOCAL_ARCHIVE_AUTOMATION_UNSAFE');
  if (!Array.isArray(metadata) || metadata.length !== 0) throw Error('LOCAL_ARCHIVE_METADATA_UNSAFE');
  if (!mods || typeof mods !== 'object' || Array.isArray(mods)
    || !Array.isArray(existingDirectories)) throw Error('LOCAL_ARCHIVE_INVENTORY_INVALID');
  const candidate = expectedId.toLowerCase();
  for (const [key, mod] of Object.entries(mods)) {
    if (!mod || typeof mod !== 'object' || Array.isArray(mod)) throw Error('LOCAL_ARCHIVE_INVENTORY_INVALID');
    for (const value of [key, mod.id, mod.installationPath]) {
      if (value === undefined) continue;
      if (alias(value) === candidate) throw Error('LOCAL_ARCHIVE_MOD_COLLISION');
    }
  }
  for (const value of existingDirectories) {
    const name = alias(value);
    if (name === candidate || name === candidate + '.installing')
      throw Error('LOCAL_ARCHIVE_DIRECTORY_COLLISION');
  }
  return { expectedId };
}

module.exports = { validateLocalArchiveName, assertLocalArchiveAdmission };
