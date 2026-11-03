'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const {validateCollectionDialog:validate,QUESTION_TEXT,ACTIONS} = require('./collection-dialog-policy.cjs');
function fixture() {
  const identity = {gameId:'cyberpunk2077',profileId:'profile',modId:'collection-owner',archiveId:'collection-download',
    collectionId:523875,revisionId:830058,revisionNumber:13};
  return {expected:{...identity,dialogId:'dialog-one',action:'update_current_profile'},
    binding:{...identity,sessionId:'session-one',epochReady:true,invalidated:false},
    native:{sourceAdmitted:true,gameId:identity.gameId,profileId:'profile',nextProfileId:'profile',
      owner:{id:identity.modId,archiveId:identity.archiveId,state:'installed',type:'collection',collectionId:523875,revisionId:830058,revisionNumber:13},
      session:{sessionId:'session-one',collectionId:identity.modId,gameId:identity.gameId,profileId:'profile',stalled:false},
      members:[{memberKey:'requires:exact-rule',status:'installing',type:'requires',repo:{gameId:identity.gameId,modId:1234,fileId:5678}}],
      downloads:[{id:'member-download',state:'finished',gameId:identity.gameId,nexusModId:1234,nexusFileId:5678}],
      mods:[{id:'old-mod',state:'installed',type:'',gameId:identity.gameId,nexusModId:1234,name:'Own synthetic mod'}]},
    pendingDialogs:[{id:'dialog-one',type:'question',title:'Own synthetic mod',defaultAction:undefined,
      content:{text:QUESTION_TEXT,options:{wrap:true},checkboxes:[{id:'remember',value:false,text:'Remember my choice'}]},actions:[...ACTIONS]}]};
}

test('joins real-style member repo, finished download and old Nexus mod; returns only fixed action identity',()=>{
  const f=fixture(),out=validate(f);
  assert.deepEqual(out,{action:'update_current_profile',dialogId:'dialog-one',sessionId:'session-one',modId:'collection-owner',archiveId:'collection-download',
    collectionId:523875,revisionId:830058,revisionNumber:13,profileId:'profile',memberKey:'requires:exact-rule',downloadId:'member-download',oldModIds:['old-mod']});
  assert.equal(Object.isFrozen(out),true);assert.equal(Object.isFrozen(out.oldModIds),true);
  assert.equal(Object.hasOwn(out,'oldModId'),false);f.native.mods[0].id='changed';assert.deepEqual(out.oldModIds,['old-mod']);
  assert.equal(Object.hasOwn(out,'effectsAllowed'),false);
});

const cases = [
  ['unapproved action',f=>f.expected.action='update_all_profiles'],
  ['wrong game',f=>f.expected.gameId='other'],
  ['unadmitted source',f=>f.native.sourceAdmitted=false],
  ['binding profile',f=>f.binding.profileId='other'],
  ['binding invalidated',f=>f.binding.invalidated=true],
  ['binding not ready',f=>f.binding.epochReady=false],
  ['active profile',f=>f.native.profileId='other'],
  ['queued profile switch',f=>f.native.nextProfileId='other'],
  ['collection archive',f=>f.native.owner.archiveId='other'],
  ['remote revision',f=>f.native.owner.revisionId=1],
  ['collection not installed',f=>f.native.owner.state='installing'],
  ['wrong session ID',f=>f.native.session.sessionId='other'],
  ['wrong session owner',f=>f.native.session.collectionId='other'],
  ['wrong session profile',f=>f.native.session.profileId='other'],
  ['stalled session',f=>f.native.session.stalled=true],
  ['missing dialogs',f=>f.pendingDialogs=[]],
  ['queued dialog not current',f=>f.pendingDialogs.unshift({...f.pendingDialogs[0],id:'other'})],
  ['duplicate dialog ID',f=>f.pendingDialogs.push(structuredClone(f.pendingDialogs[0]))],
  ['wrong dialog ID',f=>f.pendingDialogs[0].id='other'],
  ['presentation type mistaken for semantic question',f=>f.pendingDialogs[0].type='regular'],
  ['wrong question text',f=>f.pendingDialogs[0].content.text='Replace this mod?'],
  ['html input',f=>f.pendingDialogs[0].content.htmlText='unexpected'],
  ['arbitrary input',f=>f.pendingDialogs[0].content.input=[]],
  ['default action changed',f=>f.pendingDialogs[0].defaultAction='Update all profiles'],
  ['footer reorder',f=>f.pendingDialogs[0].actions.reverse()],
  ['extra action',f=>f.pendingDialogs[0].actions.push('Add Variant')],
  ['missing cancel',f=>f.pendingDialogs[0].actions.shift()],
  ['remember checked',f=>f.pendingDialogs[0].content.checkboxes[0].value=true],
  ['other checkbox',f=>f.pendingDialogs[0].content.checkboxes.push({id:'extra',value:false,text:'extra'})],
  ['missing unchecked remember',f=>f.pendingDialogs[0].content.checkboxes=[]],
  ['no matching member',f=>f.native.members=[]],
  ['member pending',f=>f.native.members[0].status='pending'],
  ['member repo game',f=>f.native.members[0].repo.gameId='other'],
  ['member repo mod',f=>f.native.members[0].repo.modId=999],
  ['member repo file',f=>f.native.members[0].repo.fileId=999],
  ['ambiguous installing member',f=>f.native.members.push({...f.native.members[0],memberKey:'another'})],
  ['download unfinished',f=>f.native.downloads[0].state='started'],
  ['download wrong game',f=>f.native.downloads[0].gameId='other'],
  ['download ambiguous',f=>f.native.downloads.push({...f.native.downloads[0],id:'duplicate-candidate'})],
  ['old mod wrong Nexus ID despite matching title',f=>f.native.mods[0].nexusModId=111],
  ['old mod wrong game',f=>f.native.mods[0].gameId='other'],
  ['old mod collection',f=>f.native.mods[0].type='collection'],
  ['old mod absent',f=>f.native.mods=[]],
  ['old mod title ambiguous',f=>f.native.mods.push({...f.native.mods[0],id:'other-old-mod',nexusModId:999})],
  ['new expected field',f=>f.expected.genericPermission=true],
  ['new native authority field',f=>f.native.effectsAllowed=true],
  ['new member field pretending direct download ID',f=>f.native.members[0].downloadId='invented'],
  ['new dialog field',f=>f.pendingDialogs[0].arbitrary=true],
];
for(const [label,change] of cases)test('refuses '+label,()=>{const f=fixture();change(f);assert.throws(()=>validate(f),/^Error: COLLECTION_DIALOG_[A-Z_]+$/);});

test('parallel valid members and queued dialogs do not authorize a later dialog or replace action',()=>{
  const f=fixture();f.native.members.push({memberKey:'second',status:'installing',type:'recommends',repo:{gameId:'cyberpunk2077',modId:2000,fileId:3000}});
  f.native.downloads.push({id:'second-dl',state:'finished',gameId:'cyberpunk2077',nexusModId:2000,nexusFileId:3000});
  f.native.mods.push({id:'second-old',state:'installed',type:'',gameId:'cyberpunk2077',nexusModId:2000,name:'Second synthetic mod'});
  f.pendingDialogs.push({...structuredClone(f.pendingDialogs[0]),id:'second-dialog',title:'Second synthetic mod'});
  assert.deepEqual(validate(f).oldModIds,['old-mod']);f.expected.dialogId='second-dialog';assert.throws(()=>validate(f),/DIALOG_NOT_CURRENT/);
});
test('no profile enabled assumption: pure policy joins source version identity without invented enable flag',()=>{
  const f=fixture();assert.deepEqual(validate(f).oldModIds,['old-mod']);
  f.native.mods[0].enabled=true;assert.throws(()=>validate(f),/SHAPE_INVALID/);
});
test('ArchiveXL same displayed version admits exactly one Nexus group and reports both old record IDs',()=>{
  const f=fixture();f.pendingDialogs[0].title='ArchiveXL 1.28.1';
  f.native.mods=[{id:'ArchiveXL-1.28.4',state:'installed',type:'',gameId:'cyberpunk2077',nexusModId:4198,name:'ArchiveXL 1.28.1'},
    {id:'ArchiveXL-1.28.1',state:'installed',type:'',gameId:'cyberpunk2077',nexusModId:4198,name:'ArchiveXL 1.28.1'}];
  f.native.members[0].repo.modId=4198;f.native.downloads[0].nexusModId=4198;
  const result=validate(f);assert.deepEqual(result.oldModIds,['ArchiveXL-1.28.1','ArchiveXL-1.28.4']);
  assert.equal(Object.hasOwn(result,'oldModId'),false);assert.equal(Object.isFrozen(result.oldModIds),true);
  // Display coincidence across Nexus pages must never borrow the group decision.
  f.native.mods[1].nexusModId=999;assert.throws(()=>validate(f),/OLD_MOD_AMBIGUOUS/);
});
test('old-version candidates are bounded before forming a public response',()=>{
 const f=fixture(),old=f.native.mods[0];f.native.mods=Array.from({length:101},(_,i)=>({...old,id:'old-'+i}));
 assert.throws(()=>validate(f),/OLD_MOD_AMBIGUOUS/);
 f.native.mods.pop();assert.equal(validate(f).oldModIds.length,100);
});
test('getters and proxies are refused without calls and arbitrary error strings are not leaked',()=>{
  let calls=0;const f=fixture();Object.defineProperty(f.native.mods[0],'name',{enumerable:true,get(){calls++;throw Error('private');}});
  assert.throws(()=>validate(f),/COLLECTION_DIALOG_INPUT_INVALID/);assert.equal(calls,0);
  const p=new Proxy(fixture(),{ownKeys(){calls++;throw Error('private');}});
  assert.throws(()=>validate(p),/COLLECTION_DIALOG_INPUT_INVALID/);assert.equal(calls,0);
});
test('symbol, inherited record, sparse array and oversized data are refused',()=>{
  for(const change of [f=>f[Symbol('hidden')]=true,f=>Object.setPrototypeOf(f.native,{hidden:true}),f=>f.native.members=new Array(2),f=>f.pendingDialogs[0].title='x'.repeat(8193)]){
    const f=fixture();change(f);assert.throws(()=>validate(f),/^Error: COLLECTION_DIALOG_[A-Z_]+$/);
  }
});
