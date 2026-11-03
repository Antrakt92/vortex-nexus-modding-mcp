'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const {createCollectionDialogController}=require('./collection-dialog-controller.cjs');
const {QUESTION_TEXT,ACTIONS}=require('./collection-dialog-policy.cjs');

// Whole maintained controller and policy. Only host source admission, SDK
// selectors/display, genuine-wizard binding and stock event callbacks are modeled.
// No filesystem, Electron, install engine, UIA, dispatch or live API is executed.
function fixture(){
  const identity={gameId:'cyberpunk2077',profileId:'p',modId:'collection',archiveId:'collection-dl',collectionId:10,revisionId:20,revisionNumber:13};
  let b={...identity,sessionId:'session',epochReady:true,invalidated:false},writeProof,readProof,source=true;
  const state={settings:{profiles:{nextProfileId:'p'}},persistent:{mods:{cyberpunk2077:{
    collection:{state:'installed',type:'collection',archiveId:'collection-dl',attributes:{collectionId:10,revisionId:20,revisionNumber:13,name:'Collection'}},
    old:{state:'installed',type:'',archiveId:'old-dl',attributes:{modId:123,name:'Synthetic mod',version:'1.0'}},
  }},downloads:{files:{dl:{state:'finished',game:['cyberpunk2077'],modInfo:{nexus:{ids:{gameId:'cyberpunk2077',modId:'123',fileId:'456'}}}}}}},
    session:{collections:{activeSession:{sessionId:'session',collectionId:'collection',gameId:'cyberpunk2077',profileId:'p',mods:{rule:{
      status:'installing',type:'requires',rule:{type:'requires',reference:{repo:{gameId:'cyberpunk2077',modId:'123',fileId:'456'}}},
    }}}},notifications:{dialogs:[dialog('d1','Synthetic mod 1.0')]}}};
  const asyncEvents=new Map(),calls=[];let onRead=()=>{},close=()=>{state.session.notifications.dialogs.shift();};
  const api={getState(){onRead();return state;},closeDialog(...args){calls.push(args);return close(...args);},
    events:new EventEmitter(),onAsync(name,fn){assert.equal(asyncEvents.has(name),false);asyncEvents.set(name,fn);}};
  const admit=async()=>{assert.equal(source,true);writeProof={};return writeProof;};admit.revalidate=p=>{assert.equal(source,true);assert.equal(p,writeProof);};
  const admitRead=async()=>{assert.equal(source,true);readProof={};return readProof;};admitRead.revalidate=p=>{assert.equal(source,true);assert.equal(p,readProof);};
  const options={selectors:{activeGameId:()=>identity.gameId,activeProfileId:()=>identity.profileId},
    util:{renderModName:mod=>mod.attributes.name+(mod.attributes.version?' '+mod.attributes.version:'')},
    getBinding:()=>b,admit,admitRead,pollMs:1,transitionTimeoutMs:5};
  const c=createCollectionDialogController(api,options),args={...identity,dialogId:'d1',action:'update_current_profile',requestId:'dialog_request_1'};
  async function observe(archive='dl',mod='new',game='cyberpunk2077'){await asyncEvents.get('will-install-mod')(game,archive,mod,{download:state.persistent.downloads.files[archive]});}
  return {c,args,api,state,options,calls,observe,get binding(){return b;},set binding(v){b=v;},set source(v){source=v;},
    set close(v){close=v;},set onRead(v){onRead=v;}};
}
function dialog(id,title){return {id,type:'question',title,defaultAction:undefined,content:{text:QUESTION_TEXT,options:{wrap:true},
  checkboxes:[{id:'remember',value:false,text:'Remember my choice'}]},actions:[...ACTIONS]};}

test('constructor only registers real stock lifecycle observers; missed preprompt cannot be inferred from title',async()=>{
  const f=fixture();assert.equal(f.calls.length,0);const r=await f.c.readiness();assert.equal(r.status,'held');assert.equal(r.reason,'COLLECTION_DIALOG_INSTALL_NOT_OBSERVED');
});
test('observed collection member joins source records and answers only exact current dialog once',async()=>{
  const f=fixture();await f.observe();const ready=await f.c.readiness();assert.equal(ready.status,'ready');assert.equal(ready.downloadId,'dl');
  assert.equal(ready.callbackOriginVerified,false);assert.equal(ready.targetArchiveIdentityVerified,false);
  await f.c.prepare(f.args);f.c.validate(f.args);f.c.respond(f.args);
  assert.deepEqual(f.calls,[['d1','Update current profile',{remember:false}]]);
  const result=await f.c.waitForTransition(f.args);assert.equal(result.nativeDialogDismissalVerified,true);assert.equal(result.installationCompleted,false);
  assert.equal(f.c.verifyTransition(f.args,result),true);
});
test('successful completed response permits the next exact queued member, with no automatic answer',async()=>{
  const f=fixture();const s=f.state;
  s.persistent.mods.cyberpunk2077.old2={state:'installed',type:'',attributes:{modId:789,name:'Second'}};
  s.persistent.downloads.files.dl2={state:'finished',game:['cyberpunk2077'],modInfo:{nexus:{ids:{gameId:'cyberpunk2077',modId:789,fileId:990}}}};
  s.session.collections.activeSession.mods.r2={status:'installing',type:'recommends',rule:{type:'recommends',reference:{repo:{gameId:'cyberpunk2077',modId:789,fileId:990}}}};
  s.session.notifications.dialogs.push(dialog('d2','Second'));await f.observe();await f.observe('dl2','new2');
  await f.c.prepare(f.args);f.c.respond(f.args);const result=await f.c.waitForTransition(f.args);f.c.verifyTransition(f.args,result);
  const next={...f.args,requestId:'dialog_request_2',dialogId:'d2'};await f.c.prepare(next);assert.equal(f.calls.length,1);
  f.c.respond(next);assert.equal(f.calls[1][0],'d2');
});
test('transition accepts appended new questions and ordinary member completion without freezing install records',async()=>{
  const f=fixture();await f.observe();f.state.session.notifications.dialogs.push(dialog('already-queued','Other queued question'));
  await f.c.prepare(f.args);f.close=()=>{
    f.state.session.notifications.dialogs.shift();
    f.state.session.notifications.dialogs.push(dialog('newly-queued','New legitimate question'));
    f.state.session.collections.activeSession.mods.rule.status='installed';
    f.state.persistent.mods.cyberpunk2077.old.attributes.newestFileId=456;
    f.state.persistent.downloads.files.dl.installed={gameId:'cyberpunk2077',modId:'new'};
    f.state.persistent.mods.cyberpunk2077.new={state:'installed',type:'',archiveId:'dl',attributes:{modId:123,name:'Synthetic new mod'}};
    f.api.events.emit('did-install-mod','cyberpunk2077','dl','new');
  };f.c.respond(f.args);const result=await f.c.waitForTransition(f.args);assert.equal(f.c.verifyTransition(f.args,result),true);
  assert.deepEqual(f.state.session.notifications.dialogs.map(d=>d.id),['already-queued','newly-queued']);
  assert.equal(f.calls.length,1);assert.equal(result.installationCompleted,false);
});
for(const [name,change]of[
  ['queue fingerprint drift',f=>f.state.session.notifications.dialogs.push(dialog('new','Unrelated'))],
  ['download metadata drift',f=>f.state.persistent.downloads.files.dl.localPath='changed.7z'],
  ['rule record drift',f=>f.state.session.collections.activeSession.mods.rule.rule.extra={changed:true}],
  ['old mod record drift',f=>f.state.persistent.mods.cyberpunk2077.old.attributes.version='2.0'],
  ['remember checkbox drift',f=>f.state.session.notifications.dialogs[0].content.checkboxes[0].value=true],
  ['source drift',f=>{f.source=false;}],
  ['binding invalidation',f=>{f.binding.invalidated=true;}],
  ['source close function drift',f=>{f.api.closeDialog=()=>assert.fail('changed native method called');}],
])test(name+' before respond refuses without native call and stays held',async()=>{
  const f=fixture();await f.observe();await f.c.prepare(f.args);change(f);assert.throws(()=>f.c.respond(f.args));assert.equal(f.calls.length,0);
  await assert.rejects(f.c.prepare({...f.args,requestId:'other_request'}),/ACTION_ALREADY_PENDING/);
});
test('duplicate respond never closes the next dialog',async()=>{
  const f=fixture();await f.observe();await f.c.prepare(f.args);f.c.respond(f.args);assert.throws(()=>f.c.respond(f.args));assert.equal(f.calls.length,1);
});
test('close throws null: preserve exact primary; never return transition metadata',async()=>{
  const f=fixture();await f.observe();await f.c.prepare(f.args);f.close=()=>{throw null;};
  let seen=false;try{f.c.respond(f.args);}catch(e){seen=true;assert.equal(e,null);}assert.equal(seen,true);
  await assert.rejects(f.c.waitForTransition(f.args),/TRANSITION_UNAVAILABLE/);assert.equal(f.calls.length,1);
});
test('source reads while prepared use a separate issuer and cannot revoke writer proof',async()=>{
  const f=fixture();await f.observe();await f.c.prepare(f.args);await Promise.all([f.c.readiness(),f.c.readiness()]);
  f.c.respond(f.args);assert.equal(f.calls.length,1);
});
test('no-effect response that leaves original dialog cannot claim completed installation or retry',async()=>{
  const f=fixture();await f.observe();await f.c.prepare(f.args);f.close=()=>{};f.c.respond(f.args);
  await assert.rejects(f.c.waitForTransition(f.args),/TRANSITION_TIMEOUT/);assert.equal(f.calls.length,1);
  await assert.rejects(f.c.prepare(f.args),/ACTION_ALREADY_PENDING/);
});
for(const [name,change]of[
  ['session changed',f=>{f.state.session.collections.activeSession.sessionId='other';}],
  ['collection owner removed',f=>{delete f.state.persistent.mods.cyberpunk2077.collection;}],
  ['queued profile switch',f=>{f.state.settings.profiles.nextProfileId='other';}],
  ['other queued dialog answered',f=>{f.state.session.notifications.dialogs=[];}],
])test(name+' after response cannot verify the native dialog transition',async()=>{
  const f=fixture();await f.observe();f.state.session.notifications.dialogs.push(dialog('d2','Unrelated next dialog'));
  await f.c.prepare(f.args);f.c.respond(f.args);change(f);await assert.rejects(f.c.waitForTransition(f.args));assert.equal(f.calls.length,1);
});
test('unrelated will-install attempt is observed and refused, not attached to the active collection',async()=>{
  const f=fixture();await f.observe();await f.observe('foreign-download','foreign-mod');
  assert.equal((await f.c.readiness()).reason,'COLLECTION_DIALOG_UNRELATED_INSTALL');assert.equal(f.calls.length,0);
});
test('an attempt observed without the retained epoch is refused even if current state later matches',async()=>{
  const f=fixture(),b=f.binding;f.binding=null;await f.observe();f.binding=b;
  assert.equal((await f.c.readiness()).reason,'COLLECTION_DIALOG_UNRELATED_INSTALL');
});
test('actual matching did-install success retires observer record; mismatched success is sticky held',async()=>{
  const a=fixture();await a.observe();a.state.persistent.mods.cyberpunk2077.new={state:'installed',archiveId:'dl',attributes:{name:'New'}};
  a.api.events.emit('did-install-mod','cyberpunk2077','dl','new');assert.equal((await a.c.readiness()).reason,'COLLECTION_DIALOG_INSTALL_NOT_OBSERVED');
  const b=fixture();await b.observe();b.api.events.emit('did-install-mod','cyberpunk2077','dl','other');assert.equal((await b.c.readiness()).reason,'COLLECTION_DIALOG_LIFECYCLE_HELD');
});
test('pre-epoch collection ID derives after will event; actual final owner success permits first member question',async()=>{
  const f=fixture(),b=f.binding;f.binding=null;
  await f.observe('collection-dl','archive-base-name');
  // Actual installed collection row is already keyed by the final derived ID.
  assert.equal(f.state.persistent.mods.cyberpunk2077.collection.archiveId,'collection-dl');
  f.api.events.emit('did-install-mod','cyberpunk2077','collection-dl','collection');
  f.binding=b;await f.observe('dl','member-archive-base');
  assert.equal((await f.c.readiness()).status,'ready');await f.c.prepare(f.args);f.c.respond(f.args);assert.equal(f.calls.length,1);
});
test('active-epoch renamed member success uses actual final game/archive record and does not poison next target',async()=>{
  const f=fixture();await f.observe('dl','provisional-member');await f.c.prepare(f.args);f.c.respond(f.args);
  f.state.persistent.mods.cyberpunk2077['member-variant-final']={state:'installed',archiveId:'dl',attributes:{name:'Final',modId:123}};
  f.api.events.emit('did-install-mod','cyberpunk2077','dl','member-variant-final');
  const result=await f.c.waitForTransition(f.args);assert.equal(f.c.verifyTransition(f.args,result),true);
});
test('same-archive success without an actual installed final record cannot retire an attempt',async()=>{
  const f=fixture();await f.observe('dl','provisional');
  f.state.persistent.mods.cyberpunk2077.final={state:'installed',archiveId:'other-archive',attributes:{name:'Wrong'}};
  f.api.events.emit('did-install-mod','cyberpunk2077','dl','final');assert.equal((await f.c.readiness()).reason,'COLLECTION_DIALOG_LIFECYCLE_HELD');
});
test('shared guard calls same opaque verifier twice around completion commit; appended queue and native completion remain valid',async()=>{
  const f=fixture();await f.observe();await f.c.prepare(f.args);f.c.respond(f.args);
  const result=await f.c.waitForTransition(f.args);
  // Actual guard: first verifier before serialization, then commitCompletion's
  // retained verifier immediately before publication. No second native answer.
  const beforeCompletion=()=>f.c.verifyTransition(f.args,result);
  assert.equal(beforeCompletion(),true);
  f.state.session.notifications.dialogs.push(dialog('new-dialog','New native question'));
  f.state.session.collections.activeSession.mods.rule.status='installed';
  assert.equal(beforeCompletion(),true);assert.equal(f.calls.length,1);
  assert.throws(()=>f.c.respond(f.args));assert.equal(f.calls.length,1);
  assert.throws(()=>f.c.verifyTransition(f.args,{...result}),/TRANSITION_UNAVAILABLE/);
});
test('duplicate lifecycle and same-title pending dialogs refuse ambiguity',async()=>{
  const a=fixture();await a.observe();await a.observe();assert.equal((await a.c.readiness()).reason,'COLLECTION_DIALOG_LIFECYCLE_HELD');
  const b=fixture();await b.observe();b.state.session.notifications.dialogs.push(dialog('d2','Synthetic mod 1.0'));
  assert.equal((await b.c.readiness()).reason,'COLLECTION_DIALOG_DIALOG_ORIGIN_AMBIGUOUS');
});
test('actual raw member has no downloadId: duplicate matching archives cannot be guessed',async()=>{
  const f=fixture();await f.observe();assert.equal(Object.hasOwn(f.state.session.collections.activeSession.mods.rule,'downloadId'),false);
  f.state.persistent.downloads.files.duplicate=structuredClone(f.state.persistent.downloads.files.dl);
  assert.equal((await f.c.readiness()).reason,'COLLECTION_DIALOG_DOWNLOAD_AMBIGUOUS');
});
function archiveXL(f){
  const mods=f.state.persistent.mods.cyberpunk2077;delete mods.old;
  mods['ArchiveXL-1.28.1']={state:'installed',type:'',archiveId:'archive-xl-old-1',attributes:{modId:4198,name:'ArchiveXL',version:'1.28.1',fileId:1}};
  mods['ArchiveXL-1.28.4']={state:'installed',type:'',archiveId:'archive-xl-old-4',attributes:{modId:4198,name:'ArchiveXL',version:'1.28.1',fileId:4}};
  f.state.session.notifications.dialogs[0].title='ArchiveXL 1.28.1';
  f.state.session.collections.activeSession.mods.rule.rule.reference.repo.modId=4198;
  f.state.persistent.downloads.files.dl.modInfo.nexus.ids.modId=4198;
}
test('ArchiveXL duplicate rendered titles answer within the same Nexus group without claiming which old callback record',async()=>{
  const f=fixture();archiveXL(f);await f.observe();const readiness=await f.c.readiness();assert.equal(readiness.status,'ready');
  assert.deepEqual(readiness.oldModIds,['ArchiveXL-1.28.1','ArchiveXL-1.28.4']);assert.equal(Object.hasOwn(readiness,'oldModId'),false);
  await f.c.prepare(f.args);f.c.respond(f.args);const result=await f.c.waitForTransition(f.args);
  assert.deepEqual(result.oldModIds,['ArchiveXL-1.28.1','ArchiveXL-1.28.4']);assert.equal(f.c.verifyTransition(f.args,result),true);
  assert.deepEqual(f.calls,[['d1','Update current profile',{remember:false}]]);
});
test('every candidate ArchiveXL old record is pinned; drift in either refuses before response',async()=>{
  for(const id of ['ArchiveXL-1.28.1','ArchiveXL-1.28.4']){
    const f=fixture();archiveXL(f);await f.observe();await f.c.prepare(f.args);
    f.state.persistent.mods.cyberpunk2077[id].attributes.fileId=999;
    assert.throws(()=>f.c.respond(f.args),/PREPARATION_CHANGED/);assert.equal(f.calls.length,0);
  }
});
test('same rendered title from a different Nexus page still refuses in the actual controller',async()=>{
  const f=fixture();archiveXL(f);await f.observe();f.state.persistent.mods.cyberpunk2077['ArchiveXL-1.28.4'].attributes.modId=999;
  assert.equal((await f.c.readiness()).reason,'COLLECTION_DIALOG_OLD_MOD_AMBIGUOUS');assert.equal(f.calls.length,0);
});
test('synchronous getState reentry during final validation holds instead of answering',async()=>{
  const f=fixture();await f.observe();await f.c.prepare(f.args);let entered=false;
  f.onRead=()=>{if(!entered){entered=true;assert.throws(()=>f.c.validate(f.args));}};
  assert.throws(()=>f.c.respond(f.args));assert.equal(f.calls.length,0);
});
test('raw record getter is never invoked; source API errors stay private in readiness',async()=>{
  const f=fixture();await f.observe();let calls=0;Object.defineProperty(f.state.persistent.mods.cyberpunk2077.old,'attributes',{enumerable:true,get(){calls++;throw Error('private');}});
  const r=await f.c.readiness();assert.equal(r.status,'held');assert.equal(calls,0);assert.doesNotMatch(JSON.stringify(r),/private/);
});
test('refuses an unsupported wait budget rather than creating an unbounded observer',()=>{
  const f=fixture();assert.throws(()=>createCollectionDialogController(f.api,{...f.options,transitionTimeoutMs:Infinity}),/WAIT_BOUND_INVALID/);
});
