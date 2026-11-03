'use strict';

// Pure metadata projection. Stock renderer sources: 240/244 (display),
// 968 (session SSOT, SHA b5022c3fd048e3e25a66b25d78f1e0b696cead191f568d1514a05a37a9980e1d),
// 1041:77 (session.notifications.dialogs). No API calls or effects.
const fail = code => { throw new Error('COLLECTION_WIZARD_NATIVE_' + code); };
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function get(object, key) {
  if (!record(object)) return undefined;
  const d = Object.getOwnPropertyDescriptor(object, key);
  if (!d) return undefined;
  if (!Object.hasOwn(d, 'value')) fail('ACCESSOR_REFUSED');
  return d.value;
}
function string(value) { if (typeof value !== 'string' || !value.length) fail('STRING_ID_UNAVAILABLE'); return value; }
function positive(value) {
  if (typeof value === 'string' && /^[1-9][0-9]*$/.test(value)) value = Number(value);
  if (!Number.isSafeInteger(value) || value <= 0) fail('REMOTE_ID_INVALID');
  return value;
}
function count(value) { if (!Number.isSafeInteger(value) || value < 0) fail('SESSION_COUNT_INVALID'); return value; }
function entries(value) {
  if (!record(value)) fail('RECORD_UNAVAILABLE');
  return Object.keys(value).map(key => [key, get(value, key)]);
}
function label(value) { if (typeof value !== 'string' || !value.trim()) fail('DISPLAY_UNAVAILABLE'); return value.replace(/\s+/g, ' ').trim(); }

function normalizeSession(raw) {
  if (!record(raw)) fail('SESSION_UNAVAILABLE');
  const statuses = { installed: 0, failed: 0, ignored: 0, pending: 0 };
  const members = entries(get(raw, 'mods'));
  const nonterminal = ['pending', 'downloading', 'downloaded', 'installing', 'optional'];
  let required = 0, optional = 0;
  for (const [, member] of members) {
    const status = get(member, 'status'), type = get(member, 'type');
    if (type === 'requires') required++; else if (type === 'recommends') optional++; else fail('SESSION_MEMBER_TYPE_UNKNOWN');
    if (['installed', 'failed', 'ignored'].includes(status)) statuses[status]++;
    else if (nonterminal.includes(status)) statuses.pending++;
    else fail('SESSION_STATUS_UNKNOWN');
  }
  if (count(get(raw, 'totalRequired')) !== required || count(get(raw, 'totalOptional')) !== optional) fail('SESSION_TOTAL_MISMATCH');
  const stalled = get(raw, 'stalled');
  // Source968:52 defines an absent optional stalled field as false.
  if (stalled !== undefined && typeof stalled !== 'boolean') fail('SESSION_STALLED_UNKNOWN');
  return { collectionId: string(get(raw, 'collectionId')), profileId: string(get(raw, 'profileId')),
    gameId: string(get(raw, 'gameId')), statuses, totalMembers: members.length, stalled: stalled === true };
}
function display(mod, util, t) {
  const attrs = get(mod, 'attributes');
  const version = get(attrs, 'version');
  if (version !== undefined && typeof version !== 'string' && typeof version !== 'number') fail('VERSION_INVALID');
  return { name: label(util.renderModName(mod, { version: false })),
    revisionLabel: label(t('Revision {{number}}{{forceRevision}}', { replace: { number: version ?? '0', forceRevision: '' } })) };
}
function observeNative({ state, selectors, util, t, modId, sourceAdmitted }) {
  if (typeof selectors?.activeGameId !== 'function' || typeof selectors?.activeProfileId !== 'function'
    || typeof util?.renderModName !== 'function' || typeof t !== 'function') fail('SDK_UNAVAILABLE');
  const gameId = string(selectors.activeGameId(state)), profileId = string(selectors.activeProfileId(state));
  const persistent = get(state, 'persistent'), settings = get(state, 'settings'), sessionState = get(state, 'session');
  const profiles = get(persistent, 'profiles'), profile = get(profiles, profileId);
  if (get(profile, 'gameId') !== gameId) fail('PROFILE_GAME_CONFLICT');
  const mods = get(get(persistent, 'mods'), gameId), mod = get(mods, string(modId)), attrs = get(mod, 'attributes');
  if (!record(mod) || !record(attrs)) fail('OWNER_UNAVAILABLE');
  const collectionId = positive(get(attrs, 'collectionId')), revisionId = positive(get(attrs, 'revisionId'));
  const revisionNumber = get(attrs, 'revisionNumber'), version = get(attrs, 'version');
  const numericVersion = version === undefined ? undefined : positive(version);
  const number = revisionNumber === undefined ? numericVersion : positive(revisionNumber);
  if (number === undefined || (numericVersion !== undefined && number !== numericVersion)) fail('REVISION_NUMBER_CONFLICT');
  const archiveId = string(get(mod, 'archiveId'));
  const download = get(get(get(persistent, 'downloads'), 'files'), archiveId), info = get(download, 'modInfo');
  const ids = get(get(info, 'nexus'), 'ids');
  if (positive(get(ids, 'collectionId')) !== collectionId || positive(get(ids, 'revisionId')) !== revisionId) fail('DOWNLOAD_IDENTITY_CONFLICT');
  const alternative = get(info, 'ids');
  if (alternative !== undefined) {
    if (!record(alternative)) fail('ALTERNATIVE_IDS_INVALID');
    for (const [key, expected] of [['collectionId', collectionId], ['revisionId', revisionId]]) {
      const value = get(alternative, key);
      if (value !== undefined && positive(value) !== expected) fail('ALTERNATIVE_IDS_CONFLICT');
    }
  }
  const rendered = display(mod, util, t);
  let ownerDisplayMatches = 0;
  for (const [, candidate] of entries(mods)) {
    if (get(candidate, 'state') !== 'installed' || get(candidate, 'type') !== 'collection') continue;
    const card = display(candidate, util, t);
    if (card.name === rendered.name && card.revisionLabel === rendered.revisionLabel) ownerDisplayMatches++;
  }
  const profileLabel = label(t('{{name}} (Current)', { replace: { name: string(get(profile, 'name')) } }));
  let profileLabelMatches = 0;
  for (const [id, candidate] of entries(profiles)) {
    if (get(candidate, 'gameId') !== gameId) continue;
    const option = id === profileId ? profileLabel : label(get(candidate, 'name'));
    if (option === profileLabel) profileLabelMatches++;
  }
  const collections = get(sessionState, 'collections');
  if (!record(collections)) fail('SESSION_STATE_UNAVAILABLE');
  const rawSession = get(collections, 'activeSession');
  const dialogs = get(get(sessionState, 'notifications'), 'dialogs');
  return { sourceAdmitted: sourceAdmitted === true, gameId, profileId,
    nextProfileId: get(get(settings, 'profiles'), 'nextProfileId') ?? null,
    owner: { id: modId, state: get(mod, 'state') ?? null, type: get(mod, 'type') ?? null,
      archiveId, collectionId, revisionId, revisionNumber: number, ...rendered },
    download: { state: get(download, 'state') ?? null, collectionId: positive(get(ids, 'collectionId')), revisionId: positive(get(ids, 'revisionId')) },
    ownerDisplayMatches, profileLabel, profileLabelMatches,
    session: rawSession === undefined ? null : normalizeSession(rawSession),
    pendingDialogCount: Array.isArray(dialogs) ? dialogs.length : null };
}

module.exports = { observeNative, normalizeSession };
