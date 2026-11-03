'use strict';

// Pure admission only. Native observations and epoch bindings are supplied by
// the source-admitted SDK layer, never accepted as caller authorization flags.
class Refusal extends Error { constructor(code) { super(code); this.code = code; } }
const need = (value, code) => { if (!value) throw new Refusal('COLLECTION_WIZARD_' + code); };
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function field(value, key) {
  need(record(value), 'INPUT_INVALID');
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  need(descriptor && Object.hasOwn(descriptor, 'value'), 'FIELD_UNAVAILABLE');
  return descriptor.value;
}
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 512;
const positive = value => Number.isSafeInteger(value) && value > 0;
const count = value => Number.isSafeInteger(value) && value >= 0;

function validate(input) {
  const expected = field(input, 'expected'), native = field(input, 'native');
  const dom = field(input, 'dom'), binding = field(input, 'binding');
  const action = field(expected, 'action');
  need(action === 'install_now' || action === 'done', 'ACTION_UNSUPPORTED');
  const gameId = field(expected, 'gameId'), profileId = field(expected, 'profileId');
  const modId = field(expected, 'modId'), archiveId = field(expected, 'archiveId');
  need(gameId === 'cyberpunk2077', 'GAME_UNSUPPORTED');
  need([profileId, modId, archiveId].every(text), 'EXPECTED_IDENTITY_INVALID');
  const ids = Object.fromEntries(['collectionId', 'revisionId', 'revisionNumber'].map(key => [key, field(expected, key)]));
  need(Object.values(ids).every(positive), 'REMOTE_IDENTITY_INVALID');
  need(field(native, 'sourceAdmitted') === true, 'SOURCE_NOT_ADMITTED');
  need(field(native, 'gameId') === gameId && field(native, 'profileId') === profileId
    && field(native, 'nextProfileId') === profileId, 'ACTIVE_CONTEXT_CHANGED');
  need(field(binding, 'epochReady') === true && field(binding, 'invalidated') === false, 'BINDING_INVALIDATED');
  need(field(binding, 'gameId') === gameId && field(binding, 'profileId') === profileId
    && field(binding, 'modId') === modId && field(binding, 'archiveId') === archiveId, 'BINDING_IDENTITY_CHANGED');
  const kind = field(binding, 'kind'), absent = field(binding, 'ownerAbsentAtEpoch');
  need(typeof absent === 'boolean' && (kind === 'new-owner-installed' || kind === 'resume'), 'BINDING_KIND_INVALID');
  need(kind !== 'new-owner-installed' || absent === true, 'NEW_OWNER_PROVENANCE_REQUIRED');
  const owner = field(native, 'owner'), download = field(native, 'download');
  need(field(owner, 'id') === modId && field(owner, 'archiveId') === archiveId
    && field(owner, 'state') === 'installed' && field(owner, 'type') === 'collection', 'OWNER_IDENTITY_CHANGED');
  for (const key of Object.keys(ids)) need(field(owner, key) === ids[key], 'OWNER_REMOTE_IDENTITY_CHANGED');
  need(field(download, 'state') === 'finished', 'DOWNLOAD_NOT_FINISHED');
  need(field(download, 'collectionId') === ids.collectionId && field(download, 'revisionId') === ids.revisionId,
    'DOWNLOAD_REMOTE_IDENTITY_CHANGED');
  const name = field(owner, 'name'), revisionLabel = field(owner, 'revisionLabel');
  need(text(name) && text(revisionLabel), 'OWNER_DISPLAY_UNAVAILABLE');
  need(field(native, 'ownerDisplayMatches') === 1, 'OWNER_DISPLAY_AMBIGUOUS');
  need(field(native, 'pendingDialogCount') === 0, 'NATIVE_DIALOG_PENDING');
  need(field(dom, 'status') === 'observed', 'DOM_NOT_OBSERVED');
  need(field(dom, 'name') === name && field(dom, 'revisionLabel') === revisionLabel, 'DOM_OWNER_DISPLAY_CHANGED');
  need(field(dom, 'phase') === (action === 'install_now' ? 'start' : 'finish'), 'DOM_PHASE_CHANGED');
  const buttons = field(dom, 'buttons');
  need(Array.isArray(buttons), 'DOM_BUTTONS_UNAVAILABLE');
  const footer = buttons.map(button => ({ action: field(button, 'action'), enabled: field(button, 'enabled') }));
  need(footer.every(button => typeof button.enabled === 'boolean'), 'DOM_BUTTON_STATE_UNAVAILABLE');
  const actions = footer.map(button => button.action).sort();
  need(JSON.stringify(actions) === JSON.stringify(action === 'install_now' ? ['install_now', 'later'] : ['done']),
    'DOM_FOOTER_UNREVIEWED');
  need(footer.find(button => button.action === action)?.enabled === true, 'DOM_ACTION_DISABLED');
  const session = field(native, 'session');
  if (action === 'install_now') {
    need(kind === 'new-owner-installed' && absent === true, 'NEW_OWNER_PROVENANCE_REQUIRED');
    need(session === null, 'PREEXISTING_SESSION');
    const label = field(native, 'profileLabel');
    need(text(label) && field(native, 'profileLabelMatches') === 1, 'PROFILE_LABEL_AMBIGUOUS');
    need(field(dom, 'selectedProfileLabel') === label, 'SELECTED_PROFILE_CHANGED');
  } else {
    // The stock finish view has no profile select. Bind profile through the
    // exact active native session rather than inventing a missing DOM label.
    need(field(dom, 'selectedProfileLabel') === null, 'FINISH_PROFILE_SHAPE_CHANGED');
    need(record(session), 'ACTIVE_SESSION_REQUIRED');
    need(field(session, 'collectionId') === modId && field(session, 'profileId') === profileId
      && field(session, 'gameId') === gameId, 'SESSION_IDENTITY_CHANGED');
    need(field(session, 'stalled') === false, 'SESSION_STALLED_OR_UNKNOWN');
    const statuses = field(session, 'statuses'), total = field(session, 'totalMembers');
    need(record(statuses) && Object.keys(statuses).sort().join(',') === 'failed,ignored,installed,pending', 'SESSION_STATUS_SHAPE_CHANGED');
    const values = Object.fromEntries(['installed', 'failed', 'ignored', 'pending'].map(key => [key, field(statuses, key)]));
    need(positive(total) && Object.values(values).every(count), 'SESSION_COUNTS_UNAVAILABLE');
    need(values.installed === total && values.failed === 0 && values.ignored === 0 && values.pending === 0,
      'SESSION_INCOMPLETE');
  }
  // DOM candidates/element handles never supply identity and are not read here.
  return { action, modId, archiveId, ...ids, profileId };
}

function validateCollectionWizard(input) {
  try { return validate(input); }
  catch (error) { throw new Error(error instanceof Refusal ? error.code : 'COLLECTION_WIZARD_INPUT_INVALID'); }
}

module.exports = { validateCollectionWizard };
