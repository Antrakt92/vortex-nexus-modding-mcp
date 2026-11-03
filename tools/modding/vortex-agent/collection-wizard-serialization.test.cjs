'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { safe } = require('./serialization.cjs');
const api = (secret = 'private-credential', userInfo = {}) => ({ getState: () => ({ confidential: { apiKey: secret }, persistent: { nexus: { userInfo } } }) });
const identity = () => ({ gameId: 'cyberpunk2077', profileId: 'profile', modId: 'collection-owner', archiveId: 'collection-archive', collectionId: 123, revisionId: 456, revisionNumber: 13, action: 'install_now' });
const completion = () => ({ protocol: 'vortex-agent/1', operation: 'advance_collection_wizard', requestId: 'wizard_request_01',
  at: '2026-11-03T19:00:00.000Z', ...identity(), transition: 'started', nativeTransitionVerified: true });
const readiness = () => ({ protocol: 'vortex-agent/1', schema: 'collection-wizard-readiness/1',
  observedAtUTC: '2026-11-03T19:00:00.000Z', status: 'ready', ...identity(), phase: 'start', reason: null,
  sourceAdmitted: true, bindingReady: true, writesAvailable: true, nativeTransitionVerified: false });
test('wizard operation, parameters and completion retain exact operational fields across account collisions', () => {
  const value = completion(); value.parameters = { ...identity(), requestId: value.requestId };
  const account = { name: 'collection', label: 'install_now', id: 'started', profile: 'profile', type: 'advance_collection_wizard' };
  assert.deepEqual(safe(value, api(undefined, account), 'receipt'), value);
  assert.deepEqual(safe(completion(), api(undefined, account), 'advance_collection_wizard'), completion());
  assert.deepEqual(safe({ completion: completion() }, api(undefined, account), 'reconcile_operation'), { completion: completion() });
});
test('flat readiness retains finite schema, phase, reason and identities', () => {
  const value = readiness(); const account = { name: 'collection', label: 'ready', phase: 'start', id: 'collection-wizard-readiness/1' };
  assert.deepEqual(safe(value, api(undefined, account), 'read_collection_wizard'), value);
  for (const status of ['held', 'idle', 'ambiguous']) {
    const held = { ...value, status, phase: null, action: null, collectionId: null, revisionId: null,
      revisionNumber: null, reason: 'COLLECTION_WIZARD_DOM_NOT_OBSERVED', writesAvailable: false };
    assert.deepEqual(safe(held, api(), 'read_collection_wizard'), held);
  }
});
test('operational secrets reject rather than silently corrupting wizard identities', () => {
  for (const secret of ['collection-owner', 'collection-archive', 'install_now', 'started', 'advance_collection_wizard', '123']) {
    assert.throws(() => safe(completion(), api(secret), 'receipt'), /OPERATIONAL_SECRET_OVERLAP/);
  }
  for (const secret of ['collection-wizard-readiness/1', 'ready', 'start', '456']) {
    assert.throws(() => safe(readiness(), api(secret), 'read_collection_wizard'), /OPERATIONAL_SECRET_OVERLAP/);
  }
});
test('wizard positive remote IDs reject strings, arrays, objects and invalid numbers', () => {
  for (const kind of ['receipt', 'advance_collection_wizard', 'operation_status']) {
    for (const bad of ['123', [123], { valueOf() { throw Error('must not invoke'); } }, 0, -1, 1.5, NaN, Infinity]) {
      assert.throws(() => safe({ ...completion(), collectionId: bad }, api(), kind), /OPERATIONAL_VALUE_NOT_CURATED/);
      assert.throws(() => safe({ parameters: { ...identity(), revisionNumber: bad } }, api(), kind), /OPERATIONAL_VALUE_NOT_CURATED/);
    }
  }
});
test('unknown actions, transitions and completion verification are refused', () => {
  for (const [key, value] of [['action', 'continue'], ['transition', 'clicked'], ['nativeTransitionVerified', false], ['nativeTransitionVerified', 'true']]) {
    assert.throws(() => safe({ ...completion(), [key]: value }, api(), 'receipt'), /OPERATIONAL_VALUE_NOT_CURATED/);
  }
});
test('readiness is never a verified native transition and boolean fields remain typed', () => {
  for (const [key, value] of [['nativeTransitionVerified', true], ['writesAvailable', 'true'], ['sourceAdmitted', 1],
    ['bindingReady', null], ['schema', 'other'], ['status', 'permitted'], ['phase', 'continue'], ['reason', 'https://private.invalid']]) {
    assert.throws(() => safe({ ...readiness(), [key]: value }, api(), 'read_collection_wizard'), /OPERATIONAL_VALUE_NOT_CURATED/);
  }
});
test('credential and URI redaction is preserved outside exact operational positions', () => {
  const value = { ...readiness(), debug: { action: 'private-credential https://private.invalid', token: 'private-credential',
    nested: { schema: 'account-name' } } };
  const result = safe(value, api(undefined, { name: 'account-name' }), 'read_collection_wizard');
  assert.equal(result.debug.action, '[redacted] [redacted-uri]'); assert.equal(result.debug.token, '[redacted]');
  assert.equal(result.debug.nested.schema, '[redacted]');
});

const dialogResult=()=>({...completion(),operation:'respond_collection_dialog',action:'update_current_profile',dialogId:'dialog-a',sessionId:'session-a',memberKey:'member-a',downloadId:'download-a',oldModIds:['old-a'],nativeDialogDismissalVerified:true,installationCompleted:false});
test('dialog operational metadata survives account collisions across receipt/status/reconcile',()=>{const c=dialogResult();delete c.transition;delete c.nativeTransitionVerified;const account={name:'update_current_profile',label:'dialog-a',id:'session-a'};for(const kind of ['receipt','operation_status','respond_collection_dialog'])assert.deepEqual(safe(c,api(undefined,account),kind),c);assert.deepEqual(safe({completion:c},api(undefined,account),'reconcile_operation'),{completion:c});});
test('read dialog finite policy preserves identity and honest unverified origin flags',()=>{const c={schema:'collection-dialog-readiness/1',status:'ready',reason:'COLLECTION_DIALOG_PREFLIGHT_REQUIRED',sourceAdmitted:true,callbackOriginVerified:false,targetArchiveIdentityVerified:false,nativeTransitionVerified:false,...identity(),action:'update_current_profile',dialogId:'dialog-a',sessionId:'session-a',memberKey:'member-a',downloadId:'download-a',oldModIds:['old-a']};assert.deepEqual(safe(c,api(undefined,{name:'ready'}),'read_collection_dialog'),c);for(const [key,value]of [['callbackOriginVerified',true],['targetArchiveIdentityVerified',true],['nativeTransitionVerified',true],['action','update_all_profiles'],['status','clicked'],['reason','https://private.invalid']])assert.throws(()=>safe({...c,[key]:value},api(),'read_collection_dialog'),/OPERATIONAL_VALUE_NOT_CURATED/);});
test('dialog completion booleans and real secret overlap refuse',()=>{const c=dialogResult();delete c.transition;delete c.nativeTransitionVerified;for(const [key,value]of [['nativeDialogDismissalVerified',false],['installationCompleted',true]])assert.throws(()=>safe({...c,[key]:value},api(),'receipt'),/OPERATIONAL_VALUE_NOT_CURATED/);for(const secret of ['update_current_profile','dialog-a','session-a'])assert.throws(()=>safe(c,api(secret),'receipt'),/OPERATIONAL_SECRET_OVERLAP/);});

test('dialog oldModIds are bounded identity arrays, not display text or inferred target',()=>{for(const bad of [[],['same','same'],['a',null],['https://private.invalid'],'old-a'])for(const kind of ['receipt','read_collection_dialog'])assert.throws(()=>safe({oldModIds:bad},api(),kind),/OPERATIONAL_VALUE_NOT_CURATED/);assert.throws(()=>safe({oldModIds:['old-a']},api('old-a'),'read_collection_dialog'),/OPERATIONAL_SECRET_OVERLAP/);});

test('dialog source metadata preserves512length identities and refuses controls',()=>{const c={oldModIds:['x'.repeat(512)],sessionId:'s'.repeat(512)};assert.deepEqual(safe(c,api(),'receipt'),c);for(const oldModIds of [['x'.repeat(513)],['bad\nvalue']])assert.throws(()=>safe({oldModIds},api(),'receipt'),/OPERATIONAL_VALUE_NOT_CURATED/);});

test('update prompt finite readiness/receipt identities preserve account collisions without download claims',()=>{const x={schema:'collection-update-prompt-readiness/1',status:'ready',action:'download_update',sourceAdmitted:true,writesAvailable:false,nativePromptDismissalVerified:false,installationCompleted:false,reason:'COLLECTION_UPDATE_PROMPT_PREFLIGHT_REQUIRED',gameId:'cyberpunk2077',profileId:'profile',oldModId:'old-owner',collectionId:123,collectionSlug:'some-slug',revisionNumber:13};assert.deepEqual(safe(x,api(undefined,{name:'some-slug',label:'download_update'}),'read_collection_update_prompt'),x);for(const [key,v]of [['nativePromptDismissalVerified',true],['installationCompleted',true],['writesAvailable',true],['action','done'],['status','downloading']])assert.throws(()=>safe({...x,[key]:v},api(),'read_collection_update_prompt'),/OPERATIONAL_VALUE_NOT_CURATED/);const c={operation:'advance_collection_update_prompt',oldModId:x.oldModId,collectionId:123,collectionSlug:x.collectionSlug,revisionNumber:13,action:'download_update',nativePromptDismissalVerified:true,installationCompleted:false};assert.deepEqual(safe(c,api(undefined,{name:'some-slug'}),'receipt'),c);assert.throws(()=>safe(c,api('some-slug'),'receipt'),/OPERATIONAL_SECRET_OVERLAP/);});
