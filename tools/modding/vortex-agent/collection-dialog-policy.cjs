'use strict';
const {isProxy} = require('node:util/types');

// Installed 2.9.1 renderer map source575 InstallManager.ts:4921-4942.
const QUESTION_TEXT = 'An older version of this mod is already installed. '
  + 'You can replace the existing one - which will update all profiles - '
  + 'or install this one alongside it. In the latter case both versions '
  + 'will be available and only the active profile will be updated. ';
const ACTIONS = Object.freeze(['Cancel', 'Update all profiles', 'Update current profile']);
class Refusal extends Error { constructor(code) { super('COLLECTION_DIALOG_' + code); } }
const need = (value, code) => {if (!value) throw new Refusal(code);};
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\x00-\x1f\x7f]/.test(value);
const positive = value => Number.isSafeInteger(value) && value > 0;
const tuple = ['gameId','profileId','modId','archiveId','collectionId','revisionId','revisionNumber'];
function closed(value, keys) {
  need(value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === [...keys].sort().join(','), 'SHAPE_INVALID');
}
function snapshot(input) {
  let nodes = 0; const ancestors = new Set();
  function copy(value, depth) {
    need(++nodes <= 100000 && depth <= 20, 'INPUT_LIMIT');
    if (value === null || value === undefined || typeof value === 'boolean') return value;
    if (typeof value === 'string') {need(value.length <= 8192, 'INPUT_LIMIT'); return value;}
    if (typeof value === 'number') {need(Number.isFinite(value), 'INPUT_INVALID'); return value;}
    need(typeof value === 'object' && !isProxy(value) && !ancestors.has(value), 'INPUT_INVALID');
    const array = Array.isArray(value), proto = Object.getPrototypeOf(value);
    need(array ? proto === Array.prototype : proto === Object.prototype || proto === null, 'INPUT_INVALID');
    const keys = Reflect.ownKeys(value); need(keys.every(key => typeof key === 'string'), 'INPUT_INVALID');
    if (array) need(value.length <= 10000 && keys.length === value.length + 1
      && keys.every(key => key === 'length' || /^(0|[1-9][0-9]*)$/.test(key) && Number(key) < value.length), 'INPUT_INVALID');
    ancestors.add(value); const out = array ? [] : Object.create(null);
    for (const key of keys) {
      if (array && key === 'length') continue;
      const d = Object.getOwnPropertyDescriptor(value,key);
      need(d && Object.hasOwn(d,'value') && d.enumerable, 'INPUT_INVALID');
      Object.defineProperty(out,key,{value:copy(d.value,depth+1),enumerable:true,writable:true,configurable:true});
    }
    ancestors.delete(value); return out;
  }
  return copy(input,0);
}
function validate(input) {
  const v = snapshot(input); closed(v,['expected','binding','native','pendingDialogs']);
  const {expected:e,binding:b,native:n,pendingDialogs:dialogs} = v;
  closed(e,[...tuple,'dialogId','action']); closed(b,[...tuple,'sessionId','epochReady','invalidated']);
  need(e.gameId === 'cyberpunk2077' && e.action === 'update_current_profile', 'ACTION_UNSUPPORTED');
  need(['profileId','modId','archiveId','dialogId'].every(key => id(e[key]))
    && ['collectionId','revisionId','revisionNumber'].every(key => positive(e[key])), 'IDENTITY_INVALID');
  need(tuple.every(key => e[key] === b[key]) && id(b.sessionId) && b.epochReady === true && b.invalidated === false, 'BINDING_CHANGED');
  closed(n,['sourceAdmitted','gameId','profileId','nextProfileId','owner','session','members','downloads','mods']);
  need(n.sourceAdmitted === true, 'SOURCE_NOT_ADMITTED');
  need(n.gameId === e.gameId && n.profileId === e.profileId && n.nextProfileId === e.profileId, 'CONTEXT_CHANGED');
  closed(n.owner,['id','archiveId','state','type','collectionId','revisionId','revisionNumber']);
  need(n.owner.id === e.modId && n.owner.archiveId === e.archiveId && n.owner.state === 'installed' && n.owner.type === 'collection'
    && ['collectionId','revisionId','revisionNumber'].every(key => n.owner[key] === e[key]), 'OWNER_CHANGED');
  closed(n.session,['sessionId','collectionId','gameId','profileId','stalled']);
  need(n.session.sessionId === b.sessionId && n.session.collectionId === e.modId && n.session.gameId === e.gameId
    && n.session.profileId === e.profileId && n.session.stalled === false, 'SESSION_CHANGED');
  need(Array.isArray(dialogs) && dialogs.length > 0 && dialogs.length <= 128, 'DIALOGS_INVALID');
  const seen = new Set();
  for (const d of dialogs) {
    closed(d,['id','type','title','content','defaultAction','actions']);
    need(id(d.id) && !seen.has(d.id), 'DIALOG_ID_AMBIGUOUS'); seen.add(d.id);
  }
  // Stock Dialog.tsx renders ONLY queue[0]. All its action buttons share id=close.
  const d = dialogs[0]; need(d.id === e.dialogId, 'DIALOG_NOT_CURRENT');
  need(d.type === 'question' && id(d.title) && d.defaultAction === undefined, 'DIALOG_CHANGED');
  need(Array.isArray(d.actions) && d.actions.length === 3 && ACTIONS.every((action,i) => d.actions[i] === action), 'ACTIONS_CHANGED');
  closed(d.content,['text','options','checkboxes']); closed(d.content.options,['wrap']);
  need(d.content.text === QUESTION_TEXT && d.content.options.wrap === true, 'QUESTION_CHANGED');
  need(Array.isArray(d.content.checkboxes) && d.content.checkboxes.length === 1, 'INPUTS_CHANGED');
  const remember = d.content.checkboxes[0]; closed(remember,['id','value','text']);
  need(remember.id === 'remember' && remember.value === false && remember.text === 'Remember my choice', 'REMEMBER_REFUSED');
  need(Array.isArray(n.members) && n.members.length <= 10000 && Array.isArray(n.downloads) && n.downloads.length <= 10000
    && Array.isArray(n.mods) && n.mods.length <= 10000, 'TARGETS_INVALID');
  const memberKeys = new Set(), downloadIds = new Set(), modIds = new Set();
  for (const member of n.members) {
    closed(member,['memberKey','status','type','repo']); closed(member.repo,['gameId','modId','fileId']);
    need(id(member.memberKey) && !memberKeys.has(member.memberKey), 'MEMBER_AMBIGUOUS'); memberKeys.add(member.memberKey);
    need(['requires','recommends'].includes(member.type) && member.status === 'installing' && member.repo.gameId === e.gameId
      && positive(member.repo.modId) && positive(member.repo.fileId), 'MEMBER_INVALID');
  }
  for (const download of n.downloads) {
    closed(download,['id','state','gameId','nexusModId','nexusFileId']);
    need(id(download.id) && !downloadIds.has(download.id), 'DOWNLOAD_AMBIGUOUS'); downloadIds.add(download.id);
    need(id(download.gameId) && positive(download.nexusModId) && positive(download.nexusFileId), 'DOWNLOAD_INVALID');
  }
  for (const mod of n.mods) {
    closed(mod,['id','state','type','gameId','nexusModId','name']);
    need(id(mod.id) && !modIds.has(mod.id) && id(mod.name) && id(mod.gameId), 'MOD_INVALID'); modIds.add(mod.id);
    need(mod.nexusModId === null || positive(mod.nexusModId), 'MOD_INVALID');
  }
  const old = n.mods.filter(mod => mod.gameId === e.gameId && mod.state === 'installed' && mod.name === d.title);
  // Stock can give different installed versions the same rendered title. The
  // fixed current-profile/alongside answer is admitted only within ONE Nexus
  // mod group. Public dialog data cannot attest which old callback record was
  // chosen; return every candidate honestly for subsequent flag reconciliation.
  need(old.length > 0 && old.length <= 100 && positive(old[0].nexusModId)
    && old.every(mod => mod.type !== 'collection' && mod.nexusModId === old[0].nexusModId), 'OLD_MOD_AMBIGUOUS');
  const members = n.members.filter(member => member.repo.modId === old[0].nexusModId);
  need(members.length === 1, 'TARGET_AMBIGUOUS'); const member = members[0];
  const matches = n.downloads.filter(download => download.gameId === member.repo.gameId && download.nexusModId === member.repo.modId
    && download.nexusFileId === member.repo.fileId);
  need(matches.length === 1 && matches[0].state === 'finished', 'DOWNLOAD_AMBIGUOUS');
  return Object.freeze({action:e.action,dialogId:d.id,sessionId:b.sessionId,modId:e.modId,archiveId:e.archiveId,
    collectionId:e.collectionId,revisionId:e.revisionId,revisionNumber:e.revisionNumber,profileId:e.profileId,
    memberKey:member.memberKey,downloadId:matches[0].id,oldModIds:Object.freeze(old.map(mod=>mod.id).sort())});
}
function validateCollectionDialog(input) {
  try {return validate(input);} catch (error) {throw new Error(error instanceof Refusal ? error.message : 'COLLECTION_DIALOG_INPUT_INVALID');}
}
module.exports = {validateCollectionDialog, QUESTION_TEXT, ACTIONS};
