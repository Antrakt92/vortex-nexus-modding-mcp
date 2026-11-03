'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path');
const { EventEmitter } = require('node:events');
const { createOperations, identity } = require('./guard.cjs');
const receipts = require('./receipts.cjs');
const { createCollectionWizardController } = require('./collection-wizard-controller.cjs');

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wizard-guard-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const gameId = 'cyberpunk2077', profileId = 'profile';
  const state = { settings: { profiles: { nextProfileId: profileId }, gameMode: { discovered: { [gameId]: { path: dir } } } },
    persistent: { profiles: { profile: { gameId, name: 'DEV', modState: {} } }, mods: { [gameId]: {
      other: { id: 'other', state: 'installed', installationPath: 'other', archiveId: 'other-archive' } } },
      downloads: { files: {} }, nexus: { userInfo: { userId: 1 } } },
    session: { collections: { sessionHistory: {} }, notifications: { dialogs: [] } } };
  let mode = 'idle', clicks = 0, writes = 0, versionRead = async () => '2.31', clickBehavior;
  const selectors = { activeGameId: () => gameId, activeProfileId: () => profileId,
    discoveryByGame: () => ({ path: dir }), installPathForGame: () => dir, downloadPathForGame: () => dir };
  const api = { events: new EventEmitter(), getState: () => state, awaitUI: async () => {},
    translate: (key, opts) => key.replace(/\{\{(\w+)\}\}/g, (_, name) => opts.replace[name]) };
  const element = { click() { clicks++; clickBehavior(); } }, modal = {};
  const session = () => ({ sessionId: 'owner_profile', collectionId: 'owner', profileId, gameId,
    totalRequired: 1, totalOptional: 0, mods: { member: { type: 'requires', status: 'installed' } } });
  clickBehavior = () => {
    if (mode === 'start') { state.session.collections.activeSession = session(); mode = 'working'; }
    else if (mode === 'finish') {
      const c = state.session.collections; c.lastActiveSessionId = c.activeSession.sessionId;
      c.sessionHistory[c.activeSession.sessionId] = c.activeSession; c.activeSession = undefined; mode = 'idle';
    }
  };
  const admit = async () => ({}); admit.revalidate = () => true;
  const controller = createCollectionWizardController(api, { selectors, admit, admitRead:admit,
    util: { renderModName: mod => mod.attributes.customFileName,
      getGame: () => ({ getInstalledVersion: () => versionRead() }) },
    pollMs: 1, transitionTimeoutMs: 10,
    inspectDOM: () => ['idle', 'working'].includes(mode) ? { status: 'idle', candidate: null }
      : { status: 'observed', phase: mode, name: 'Our Collection', revisionLabel: 'Revision 13',
        selectedProfileLabel: mode === 'start' ? 'DEV (Current)' : null,
        buttons: mode === 'start' ? [{ action: 'later', enabled: true }, { action: 'install_now', enabled: true }]
          : [{ action: 'done', enabled: true }], candidate: { element, modal } } });
  await controller.initialized;
  const revision = { id: 456, revisionNumber: 13, collection: { id: 123, slug: 'ours', game: { domainName: gameId } },
    gameVersions: [{ reference: '2.31' }], modFiles: [] };
  state.persistent.mods[gameId].owner = { state: 'installed', type: 'collection', archiveId: 'archive', rules: [],
    attributes: { collectionId: 123, revisionId: 456, revisionNumber: 13, version: '13', customFileName: 'Our Collection' } };
  state.persistent.downloads.files.archive = { state: 'finished', modInfo: { nexus: { revisionInfo: revision,
    ids: { collectionId: 123, revisionId: 456, revisionNumber: 13, collectionSlug: 'ours' } } } };
  mode = 'start'; api.events.emit('did-install-mod', gameId, 'archive', 'owner');
  const wizard = Object.fromEntries(['prepare', 'validate', 'click', 'waitForTransition', 'verifyTransition']
    .map(key => [key, (...args) => controller[key](...args)]));
  const ops = createOperations(api, { setModsEnabled: async () => {
    writes++; state.persistent.profiles.profile.modState.other = { enabled: true };
  } }, selectors, { wizard, receipts: path.join(dir, 'receipts'), stopped: () => {} });
  const common = { gameId, profileId, gamePath: dir, stagingPath: dir, downloadPath: dir,
    filesystemIds: { gamePath: identity(dir), stagingPath: identity(dir), downloadPath: identity(dir) } };
  const args = { ...common, requestId: 'wizard_request_start', modId: 'owner', archiveId: 'archive',
    collectionId: 123, revisionId: 456, revisionNumber: 13, action: 'install_now' };
  return { dir, state, controller, wizard, ops, args, common, api, selectors,
    read: async name => JSON.parse(await fs.readFile(path.join(dir, 'receipts', name), 'utf8')),
    get clicks() { return clicks; }, get writes() { return writes; },
    set mode(value) { mode = value; }, set versionRead(value) { versionRead = value; },
    set clickBehavior(value) { clickBehavior = value; } };
}

test('real guard/controller start and finish each produce exact verified receipts and one click', async t => {
  const f = await fixture(t);
  for (const action of ['install_now', 'done']) {
    const args = { ...f.args, action, requestId: 'wizard_request_' + action };
    if (action === 'done') f.mode = 'finish';
    const result = await f.ops.advance_collection_wizard(args);
    const attempt = await f.read(args.requestId + '.attempt.json');
    const completion = await f.read(args.requestId + '.completion.json');
    assert.equal(receipts.validAttempt(attempt), true); assert.equal(receipts.validCompletion(completion, attempt), true);
    for (const key of ['modId', 'archiveId', 'collectionId', 'revisionId', 'revisionNumber', 'action']) assert.equal(completion[key], args[key]);
    assert.equal(result.transition, action === 'done' ? 'finished' : 'started');
    assert.equal(result.nativeTransitionVerified, true); assert.equal(result.diskDeploymentVerified, false);
    assert.equal(f.clicks, action === 'done' ? 2 : 1);
    await assert.rejects(fs.access(path.join(f.dir, 'receipts/unresolved.json')));
  }
});

test('wizard holds the shared mutation lock across asynchronous preparation', async t => {
  const f = await fixture(t); let release, entered;
  const inVersionRead = new Promise(resolve => { entered = resolve; });
  f.versionRead = () => { entered(); return new Promise(resolve => { release = () => resolve('2.31'); }); };
  const first = f.ops.advance_collection_wizard(f.args);
  await inVersionRead; await fs.access(path.join(f.dir, 'receipts/mutation.lock'));
  let settled = false;
  const second = f.ops.set_mods_enabled({ ...f.common, requestId: 'other_write_request', modIds: ['other'], enabled: true })
    .finally(() => { settled = true; });
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(f.writes, 0); assert.equal(settled, false); assert.equal(f.clicks, 0);
  release(); await first; await second; assert.equal(f.clicks, 1); assert.equal(f.writes, 1);
});

test('uncertain click records effects, retains global interlock and cannot be replayed or reconciled as success', async t => {
  const f = await fixture(t); f.clickBehavior = () => { throw Error('SYNTHETIC_CLICK_FAILURE'); };
  await assert.rejects(f.ops.advance_collection_wizard(f.args), /SYNTHETIC_CLICK_FAILURE/);
  const attempt = await f.read(f.args.requestId + '.attempt.json'), failure = await f.read(f.args.requestId + '.failed.json');
  assert.equal(receipts.validFailure(failure, attempt), true); assert.equal(failure.effectsMayHaveOccurred, true);
  assert.equal(failure.inspectBeforeRetry, true); assert.equal(f.clicks, 1);
  for (const requestId of [f.args.requestId, 'different_wizard_request']) {
    await assert.rejects(f.ops.advance_collection_wizard({ ...f.args, requestId }), /UNRESOLVED_OPERATION_INTERLOCK/);
  }
  await assert.rejects(f.ops.set_mods_enabled({ ...f.common, requestId: 'other_write_request', modIds: ['other'], enabled: true }), /UNRESOLVED_OPERATION_INTERLOCK/);
  const reconciled = await f.ops.reconcile_operation({ requestId: f.args.requestId });
  assert.equal(reconciled.terminalOperationVerified, false); assert.equal(f.clicks, 1); assert.equal(f.writes, 0);
  await fs.access(path.join(f.dir, 'receipts/unresolved.json'));
});

test('late pre-click validation failure records no effects and releases the armed interlock', async t => {
  const f = await fixture(t), original = f.wizard.validate;
  f.wizard.validate = args => { f.state.session.notifications.dialogs.push({}); return original(args); };
  await assert.rejects(f.ops.advance_collection_wizard(f.args), /NATIVE_DIALOG_PENDING/);
  const attempt = await f.read(f.args.requestId + '.attempt.json'), failure = await f.read(f.args.requestId + '.failed.json');
  assert.equal(receipts.validFailure(failure, attempt), true); assert.equal(failure.effectsMayHaveOccurred, false);
  assert.equal(failure.inspectBeforeRetry, false); assert.equal(f.clicks, 0);
  await assert.rejects(fs.access(path.join(f.dir, 'receipts/unresolved.json')));
  await assert.rejects(fs.access(path.join(f.dir, 'receipts/mutation.lock')));
});

test('click without native transition never writes a successful completion', async t => {
  const f = await fixture(t); f.clickBehavior = () => {};
  await assert.rejects(f.ops.advance_collection_wizard(f.args), /TRANSITION_TIMEOUT/);
  assert.equal(f.clicks, 1); assert.equal((await f.read(f.args.requestId + '.failed.json')).effectsMayHaveOccurred, true);
  await assert.rejects(fs.access(path.join(f.dir, 'receipts', f.args.requestId + '.completion.json')));
  assert.equal((await f.ops.reconcile_operation({ requestId: f.args.requestId })).terminalOperationVerified, false);
});


test('dialog guard shares durable intent, synchronous response boundary and two completion rechecks',async t=>{
 const f=await fixture(t);let responses=0,checks=0;const args={...f.args,requestId:'dialog_response_01',dialogId:'dialog-a',action:'update_current_profile'};
 const result={modId:args.modId,archiveId:args.archiveId,collectionId:args.collectionId,revisionId:args.revisionId,revisionNumber:args.revisionNumber,profileId:args.profileId,dialogId:args.dialogId,action:args.action,sessionId:'session-a',memberKey:'member-a',downloadId:'member-archive',oldModIds:['other'],nativeDialogDismissalVerified:true,installationCompleted:false};
 const dialog={async prepare(){await fs.access(path.join(f.dir,'receipts/mutation.lock'));},validate(){return true;},respond(){assert.ok(require('node:fs').existsSync(path.join(f.dir,'receipts/unresolved.json')));responses++;},async waitForTransition(){return result;},verifyTransition(a,r){assert.equal(a,args);assert.equal(r,result);checks++;return true;}};
 const ops=createOperations(f.api,{},f.selectors,{dialog,receipts:path.join(f.dir,'receipts'),stopped:()=>{}});const status=await ops.respond_collection_dialog(args);
 assert.equal(responses,1);assert.equal(checks,2);assert.equal(status.nativeDialogDismissalVerified,true);assert.equal(status.installationCompleted,false);const a=await f.read(args.requestId+'.attempt.json'),c=await f.read(args.requestId+'.completion.json');assert.equal(receipts.validCompletion(c,a),true);await assert.rejects(fs.access(path.join(f.dir,'receipts/unresolved.json')));
});
test('dialog response uncertainty retains global interlock and blocks different operation IDs',async t=>{
 const f=await fixture(t);let responses=0;const dialog={async prepare(){},validate(){},respond(){responses++;},async waitForTransition(){throw Error('COLLECTION_DIALOG_TRANSITION_TIMEOUT');},verifyTransition(){}};
 const ops=createOperations(f.api,{},f.selectors,{dialog,receipts:path.join(f.dir,'receipts'),stopped:()=>{}});const args={...f.args,requestId:'dialog_response_02',dialogId:'dialog-a',action:'update_current_profile'};
 await assert.rejects(ops.respond_collection_dialog(args),/TRANSITION_TIMEOUT/);assert.equal(responses,1);await fs.access(path.join(f.dir,'receipts/unresolved.json'));await assert.rejects(f.ops.set_mods_enabled({...f.common,requestId:'different_write_02',modIds:['other'],enabled:true}),/UNRESOLVED_OPERATION_INTERLOCK/);assert.equal(responses,1);
});

test('real dialog controller and guard commit exact response with repeated completion verification',async t=>{
 const f=await fixture(t),{createCollectionDialogController}=require('./collection-dialog-controller.cjs'),{QUESTION_TEXT,ACTIONS}=require('./collection-dialog-policy.cjs');
 const args={...f.args,requestId:'real_dialog_response',dialogId:'dialog-a',action:'update_current_profile'},b={gameId:args.gameId,profileId:args.profileId,modId:args.modId,archiveId:args.archiveId,collectionId:123,revisionId:456,revisionNumber:13,sessionId:'session-a',epochReady:true,invalidated:false};
 f.state.session.collections.activeSession={sessionId:b.sessionId,collectionId:b.modId,gameId:b.gameId,profileId:b.profileId,mods:{member:{status:'installing',type:'requires',rule:{type:'requires',reference:{repo:{gameId:b.gameId,modId:12,fileId:34}}}}}};
 f.state.persistent.mods[b.gameId].other.attributes={modId:12};f.state.persistent.downloads.files.incoming={state:'finished',game:[b.gameId],modInfo:{nexus:{ids:{gameId:b.gameId,modId:12,fileId:34}}}};
 f.state.session.notifications.dialogs=[{id:args.dialogId,type:'question',title:'Old mod',defaultAction:undefined,actions:[...ACTIONS],content:{text:QUESTION_TEXT,options:{wrap:true},checkboxes:[{id:'remember',value:false,text:'Remember my choice'}]}}];
 const handlers=new Map();f.api.onAsync=(name,fn)=>handlers.set(name,fn);let answers=0;f.api.closeDialog=(id,action,input)=>{assert.equal(id,args.dialogId);assert.equal(action,'Update current profile');assert.deepEqual(input,{remember:false});answers++;f.state.session.notifications.dialogs.shift();};
 const admit=async()=>({});admit.revalidate=()=>true;const dialog=createCollectionDialogController(f.api,{selectors:f.selectors,util:{renderModName:mod=>mod.type==='collection'?'Collection':'Old mod'},getBinding:()=>b,admit,admitRead:admit,pollMs:1,transitionTimeoutMs:20});
 await handlers.get('will-install-mod')(b.gameId,'incoming','provisional');
 const ops=createOperations(f.api,{},f.selectors,{dialog,receipts:path.join(f.dir,'receipts'),stopped:()=>{}}),r=await ops.respond_collection_dialog(args);
 assert.equal(answers,1);assert.equal(r.nativeDialogDismissalVerified,true);const a=await f.read(args.requestId+'.attempt.json'),c=await f.read(args.requestId+'.completion.json');assert.equal(receipts.validCompletion(c,a),true);assert.equal(c.installationCompleted,false);await assert.rejects(fs.access(path.join(f.dir,'receipts/unresolved.json')));
});

test('update prompt named guard commits dismissal through shared durable intent with two checks',async t=>{const f=await fixture(t);const args={...f.common,requestId:'update_prompt_01',oldModId:'old-owner',collectionId:123,collectionSlug:'some-slug',revisionNumber:13,action:'download_update'};let clicks=0,checks=0,commits=0;const result={oldModId:args.oldModId,collectionId:123,collectionSlug:args.collectionSlug,revisionNumber:13,action:args.action,nativePromptDismissalVerified:true,installationCompleted:false};const updatePrompt={async prepare(){await fs.access(path.join(f.dir,'receipts/mutation.lock'));},validate(){},click(){assert.ok(require('fs').existsSync(path.join(f.dir,'receipts/unresolved.json')));clicks++;},async waitForTransition(){return result;},verifyTransition(a,r){assert.equal(a,args);assert.equal(r,result);checks++;},committed(){commits++;}};const ops=createOperations(f.api,{},f.selectors,{updatePrompt,receipts:path.join(f.dir,'receipts'),stopped:()=>{}});const status=await ops.advance_collection_update_prompt(args);assert.equal(clicks,1);assert.equal(checks,2);assert.equal(commits,1);assert.equal(status.installationCompleted,false);const a=await f.read(args.requestId+'.attempt.json'),c=await f.read(args.requestId+'.completion.json');assert.equal(receipts.validCompletion(c,a),true);await assert.rejects(fs.access(path.join(f.dir,'receipts/unresolved.json')));});
test('update prompt uncertainty does not call committed and blocks other shared writes',async t=>{const f=await fixture(t);let commits=0;const updatePrompt={async prepare(){},validate(){},click(){},async waitForTransition(){throw Error('COLLECTION_UPDATE_PROMPT_TRANSITION_TIMEOUT');},verifyTransition(){},committed(){commits++;}};const ops=createOperations(f.api,{},f.selectors,{updatePrompt,receipts:path.join(f.dir,'receipts'),stopped:()=>{}});await assert.rejects(ops.advance_collection_update_prompt({...f.common,requestId:'update_prompt_02',oldModId:'old-owner',collectionId:123,collectionSlug:'some-slug',revisionNumber:13,action:'download_update'}),/TRANSITION_TIMEOUT/);assert.equal(commits,0);await assert.rejects(f.ops.set_mods_enabled({...f.common,requestId:'update_prompt_other',modIds:['other'],enabled:true}),/UNRESOLVED_OPERATION_INTERLOCK/);});
