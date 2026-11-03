'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const {validateCollectionWizard: validate} = require('./collection-wizard-policy.cjs');
function fixture(action = 'install_now') {
  const expected = {gameId:'cyberpunk2077',profileId:'profile-a',modId:'owner-a',archiveId:'archive-a',collectionId:123,revisionId:456,revisionNumber:7,action};
  return {expected,native:{gameId:expected.gameId,profileId:'profile-a',nextProfileId:'profile-a',
    owner:{id:'owner-a',state:'installed',type:'collection',archiveId:'archive-a',collectionId:123,revisionId:456,revisionNumber:7,name:'Example collection',revisionLabel:'Revision 7'},
    download:{state:'finished',collectionId:123,revisionId:456},ownerDisplayMatches:1,profileLabel:'Profile A (Current)',profileLabelMatches:1,
    session:action==='done'?{collectionId:'owner-a',profileId:'profile-a',gameId:'cyberpunk2077',statuses:{installed:3,failed:0,ignored:0,pending:0},totalMembers:3,stalled:false}:null,
    pendingDialogCount:0,sourceAdmitted:true},
    dom:{status:'observed',phase:action==='done'?'finish':'start',name:'Example collection',revisionLabel:'Revision 7',selectedProfileLabel:action==='done'?null:'Profile A (Current)',
      buttons:action==='done'?[{action:'done',enabled:true}]:[{action:'later',enabled:true},{action:'install_now',enabled:true}]},
    binding:{kind:'new-owner-installed',modId:'owner-a',archiveId:'archive-a',gameId:'cyberpunk2077',profileId:'profile-a',ownerAbsentAtEpoch:true,invalidated:false,epochReady:true}};
}
for (const action of ['install_now','done']) test(action+' returns only exact bound action identity',()=>{
  const f=fixture(action);assert.deepEqual(validate(f),{action,modId:'owner-a',archiveId:'archive-a',collectionId:123,revisionId:456,revisionNumber:7,profileId:'profile-a'});
});
const mutations = [
  ['unsupported game',f=>f.expected.gameId='another-game'],
  ['unsupported action',f=>f.expected.action='skip'],
  ['string revision',f=>f.expected.revisionId='456'],
  ['zero collection',f=>f.expected.collectionId=0],
  ['source missing',f=>delete f.native.sourceAdmitted],
  ['source false',f=>f.native.sourceAdmitted=false],
  ['queued profile switch',f=>f.native.nextProfileId='profile-b'],
  ['native profile switch',f=>f.native.profileId='profile-b'],
  ['binding profile switch',f=>f.binding.profileId='profile-b'],
  ['binding archive drift',f=>f.binding.archiveId='archive-b'],
  ['binding invalidated',f=>f.binding.invalidated=true],
  ['epoch not ready',f=>f.binding.epochReady=false],
  ['new owner not absent',f=>f.binding.ownerAbsentAtEpoch=false],
  ['existing owner resume cannot install',f=>{f.binding.kind='resume';f.binding.ownerAbsentAtEpoch=false;}],
  ['owner installing',f=>f.native.owner.state='installing'],
  ['owner type wrong',f=>f.native.owner.type=''],
  ['same display different remote revision',f=>f.native.owner.revisionId=789],
  ['download revision differs',f=>f.native.download.revisionId=789],
  ['download collection differs',f=>f.native.download.collectionId=999],
  ['unfinished download',f=>f.native.download.state='downloading'],
  ['duplicate owner display',f=>f.native.ownerDisplayMatches=2],
  ['duplicate profile label',f=>f.native.profileLabelMatches=2],
  ['wrong selected profile',f=>f.dom.selectedProfileLabel='Profile B (Current)'],
  ['pending native dialog',f=>f.native.pendingDialogCount=1],
  ['unknown native dialog count',f=>delete f.native.pendingDialogCount],
  ['ambiguous DOM',f=>f.dom.status='ambiguous'],
  ['idle DOM',f=>f.dom.status='idle'],
  ['wrong DOM phase',f=>f.dom.phase='finish'],
  ['same title wrong DOM revision',f=>f.dom.revisionLabel='Revision 8'],
  ['disabled action',f=>f.dom.buttons[1].enabled=false],
  ['unknown footer',f=>f.dom.buttons.push({action:'install_optionals',enabled:true})],
  ['duplicate target',f=>f.dom.buttons.push({action:'install_now',enabled:true})],
  ['missing session read',f=>delete f.native.session],
  ['preexisting session',f=>f.native.session={}]
];
for(const [name,mutate]of mutations)test('install refuses '+name,()=>{const f=fixture();mutate(f);assert.throws(()=>validate(f),/^Error: COLLECTION_WIZARD_[A-Z_]+$/);});
const doneMutations = [
  ['no session',f=>f.native.session=null],['wrong owner session',f=>f.native.session.collectionId='other-owner'],
  ['wrong profile session',f=>f.native.session.profileId='profile-b'],['wrong game session',f=>f.native.session.gameId='another-game'],
  ['stalled',f=>f.native.session.stalled=true],['unknown stalled',f=>delete f.native.session.stalled],
  ['failed member',f=>{f.native.session.statuses.installed=2;f.native.session.statuses.failed=1;}],
  ['ignored member',f=>{f.native.session.statuses.installed=2;f.native.session.statuses.ignored=1;}],
  ['pending member',f=>{f.native.session.statuses.installed=2;f.native.session.statuses.pending=1;}],
  ['empty session',f=>{f.native.session.totalMembers=0;f.native.session.statuses.installed=0;}],
  ['counter mismatch',f=>f.native.session.totalMembers=4],['unknown status',f=>f.native.session.statuses.optional=0],
  ['failed footer',f=>f.dom.buttons.unshift({action:'view_failed',enabled:true})],
  ['optional footer',f=>f.dom.buttons.push({action:'view_optionals',enabled:true})],
  ['finish selected profile unexpectedly present',f=>f.dom.selectedProfileLabel='Profile A (Current)']
];
for(const [name,mutate]of doneMutations)test('done refuses '+name,()=>{const f=fixture('done');mutate(f);assert.throws(()=>validate(f),/^Error: COLLECTION_WIZARD_[A-Z_]+$/);});
test('done supports an exact separately observed resume binding',()=>{const f=fixture('done');f.binding.kind='resume';f.binding.ownerAbsentAtEpoch=false;assert.equal(validate(f).action,'done');});
test('DOM candidate is ignored without reading an accessor',()=>{const f=fixture();Object.defineProperty(f.dom,'candidate',{get(){throw Error('MUST_NOT_READ');}});assert.equal(validate(f).action,'install_now');});
test('required field accessors refuse without invoking them',()=>{const f=fixture();let reads=0;Object.defineProperty(f.native,'sourceAdmitted',{get(){reads++;return true;}});assert.throws(()=>validate(f),/COLLECTION_WIZARD_FIELD_UNAVAILABLE/);assert.equal(reads,0);});
test('input proxy failures become stable codes without exposing details',()=>{assert.throws(()=>validate(new Proxy({},{getOwnPropertyDescriptor(){throw Error('SENSITIVE');}})),/^Error: COLLECTION_WIZARD_INPUT_INVALID$/);});
test('revalidation rejects a start-to-finish or finish-to-start transition',()=>{const f=fixture();validate(f);f.dom=fixture('done').dom;assert.throws(()=>validate(f),/COLLECTION_WIZARD_DOM_PHASE_CHANGED/);const d=fixture('done');validate(d);d.dom=fixture().dom;assert.throws(()=>validate(d),/COLLECTION_WIZARD_DOM_PHASE_CHANGED/);});
test('native remote IDs remain mandatory even when all labels match',()=>{const f=fixture('done');delete f.native.owner.revisionId;assert.throws(()=>validate(f),/COLLECTION_WIZARD_FIELD_UNAVAILABLE/);});
