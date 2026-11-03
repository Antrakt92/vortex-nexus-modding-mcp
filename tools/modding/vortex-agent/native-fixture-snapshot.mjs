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
