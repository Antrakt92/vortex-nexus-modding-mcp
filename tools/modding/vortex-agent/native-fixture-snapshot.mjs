import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// The curated mod list has no total count or pagination token. At the limit,
// equality of before/after slices cannot prove preservation of the inventory.
export const ORDINARY_MOD_LIMIT = 500;

export function ordinaryProcessesPreserved(before, after) {
  const valid = rows => Array.isArray(rows) && rows.length > 0 && rows.length <= 65536
    && new Set(rows.map(row => row?.pid)).size === rows.length
    && rows.every(row => Number.isSafeInteger(row?.pid) && row.pid > 0
      && typeof row.generation === 'string' && /^[1-9][0-9]{14,18}$/.test(row.generation));
  if (!valid(before) || !valid(after)) return false;
  const observed = new Map(after.map(row => [row.pid, row]));
  return before.every(row => ['pid', 'parent', 'exe', 'type', 'generation']
    .every(key => row[key] === observed.get(row.pid)?.[key]));
}

export function assertOrdinaryModSnapshot(mods) {
  if (!Array.isArray(mods) || mods.some(mod => !mod || typeof mod !== 'object'
      || Array.isArray(mod) || typeof mod.id !== 'string' || !mod.id)
      || new Set(mods.map(mod => mod.id)).size !== mods.length)
    throw Error('ORDINARY_MOD_INVENTORY_INVALID');
  if (mods.length >= ORDINARY_MOD_LIMIT)
    throw Error('ORDINARY_MOD_INVENTORY_INCOMPLETE');
}


// The empty inventory is admitted explicitly by the complete native process reader.
export function stoppedOrdinaryCohort(rows, fixturePid) {
  if (!Array.isArray(rows)) return false;
  if (!rows.length) return fixturePid === undefined;
  return Number.isSafeInteger(fixturePid) && fixturePid > 0
    && rows.filter(row => row.type === '').length === 1
    && rows.some(row => row.type === '' && row.pid === fixturePid);
}

const requirePin = (condition, code) => { if (!condition) throw Error(code); };

function realOrdinaryPath(file, info) {
  requirePin(!info.isSymbolicLink() && fs.realpathSync.native(file).toLowerCase() === file.toLowerCase(),
    'STOPPED_ORDINARY_FILE_ALIAS');
}
function ordinaryParentPins(file) {
  const parents = [];
  for (let parent = path.dirname(file); ; parent = path.dirname(parent)) {
    parents.unshift(parent);
    if (parent === path.dirname(parent)) break;
  }
  return parents.map(parent => {
    const info = fs.lstatSync(parent, { bigint: true });
    realOrdinaryPath(parent, info);
    requirePin(info.isDirectory(), 'STOPPED_ORDINARY_PARENT_REFUSED');
    return `${info.dev}:${info.ino}`;
  });
}

function fileGeneration(info) {
  return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs, info.nlink].join(':');
}

export function pinOrdinaryFile(file, limit) {
  ordinaryParentPins(file);
  const expected = fs.lstatSync(file, { bigint: true });
  realOrdinaryPath(file, expected);
  requirePin(expected.isFile() && expected.size > 0n && expected.size <= BigInt(limit) && expected.nlink === 1n,
    'STOPPED_ORDINARY_FILE_REFUSED');
  const fd = fs.openSync(file, 'r');
  try {
    const generation = fileGeneration(expected);
    requirePin(generation === fileGeneration(fs.fstatSync(fd, { bigint: true })), 'STOPPED_ORDINARY_FILE_CHANGED');
    const digest = crypto.createHash('sha256'), buffer = Buffer.alloc(256 * 1024);
    for (let remaining = Number(expected.size); remaining > 0;) {
      const count = fs.readSync(fd, buffer, 0, Math.min(buffer.length, remaining), null);
      requirePin(count > 0, 'STOPPED_ORDINARY_FILE_CHANGED');
      digest.update(buffer.subarray(0, count));
      remaining -= count;
    }
    requirePin(generation === fileGeneration(fs.fstatSync(fd, { bigint: true }))
      && generation === fileGeneration(fs.lstatSync(file, { bigint: true })), 'STOPPED_ORDINARY_FILE_CHANGED');
    return { file, generation, sha256: digest.digest('hex') };
  } finally { fs.closeSync(fd); }
}

export function observeOrdinaryHold(file) {
  const parentPins = ordinaryParentPins(file);
  if (fs.lstatSync(file, { throwIfNoEntry: false })) return pinOrdinaryFile(file, 1024 * 1024);
  const currentParents = ordinaryParentPins(file);
  requirePin(parentPins.every((pin, index) => pin === currentParents[index])
    && !fs.lstatSync(file, { throwIfNoEntry: false }), 'STOPPED_ORDINARY_HOLD_CHANGED');
  return { file, present: false, parentPins };
}
