'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const {createCollectionWizardController,getCollectionWizardController}=require('./collection-wizard-controller.cjs');
function fixture(){
 const gameId='cyberpunk2077',profileId='profile';
 const s={persistent:{profiles:{profile:{gameId,name:'DEV'}},mods:{[gameId]:{}},downloads:{files:{}},nexus:{userInfo:{userId:1}}},
 settings:{profiles:{nextProfileId:profileId}},session:{collections:{sessionHistory:{}},notifications:{dialogs:[]}}};
 const owner={state:'installed',type:'collection',archiveId:'archive',rules:[],attributes:{collectionId:123,revisionId:456,revisionNumber:13,version:'13',customFileName:'Our Collection'}};
 const revision={id:456,revisionNumber:13,collection:{id:123,slug:'ours',game:{domainName:gameId}},gameVersions:[{reference:'2.31'}],modFiles:[]};
 let mode='idle',clicks=0,version='2.31',source=true,changeDuringFetch=()=>{};
 const api={events:new EventEmitter(),getState:()=>s,awaitUI:async()=>{},translate:(key,opts)=>key.replace(/\{\{(\w+)\}\}/g,(_,k)=>opts.replace[k]),
 ext:{nexusGetCollectionRevision:async()=>{changeDuringFetch();return revision;}}};
 const session=()=>({sessionId:'session-new',collectionId:'owner',profileId,gameId,totalRequired:1,totalOptional:0,mods:{r:{type:'requires',status:'installed'}}});
 const element={click(){clicks++;if(mode==='start'){s.session.collections.activeSession=session();mode='working';}
 else if(mode==='finish'){const c=s.session.collections;c.sessionHistory[c.activeSession.sessionId]=c.activeSession;c.lastActiveSessionId=c.activeSession.sessionId;c.activeSession=undefined;mode='idle';}}};
 const modal={};
 const admit=async()=>{assert.equal(source,true);return {sourceAdmitted:true};};admit.revalidate=()=>{assert.equal(source,true);};
 const options={selectors:{activeGameId:()=>gameId,activeProfileId:()=>profileId,discoveryByGame:()=>({path:'game'})},
 util:{renderModName:m=>m.attributes.customFileName,getGame:()=>({getInstalledVersion:async()=>{changeDuringFetch();return version;}})},admit,pollMs:1,transitionTimeoutMs:5,
 inspectDOM:()=>mode==='idle'?{status:'idle',candidate:null}:mode==='working'?{status:'idle',candidate:null}:
 {status:'observed',phase:mode==='start'?'start':'finish',name:'Our Collection',revisionLabel:'Revision 13',selectedProfileLabel:mode==='start'?'DEV (Current)':null,
 buttons:mode==='start'?[{action:'later',enabled:true},{action:'install_now',enabled:true}]:[{action:'done',enabled:true}],candidate:{element,modal}}};
 const args={requestId:'wizard_request_1',gameId,profileId,modId:'owner',archiveId:'archive',collectionId:123,revisionId:456,revisionNumber:13,action:'install_now'};
 const c=createCollectionWizardController(api,options);
 function install(){s.persistent.mods[gameId].owner=owner;s.persistent.downloads.files.archive={state:'finished',modInfo:{nexus:{revisionInfo:revision,ids:{collectionId:123,revisionId:456,revisionNumber:13,collectionSlug:'ours'}}}};mode='start';api.events.emit('did-install-mod',gameId,'archive','owner');}
 return {s,api,options,c,args,owner,revision,element,install,session,get clicks(){return clicks;},set mode(v){mode=v;},set version(v){version=v;},set source(v){source=v;},set changeDuringFetch(v){changeDuringFetch=v;}};
}
test('observed new owner starts and finishes via exact native session, one click each',async()=>{
 const f=fixture();await f.c.initialized;assert.equal((await f.c.readiness()).status,'idle');f.install();
 assert.equal((await f.c.readiness()).status,'ready');await f.c.prepare(f.args);f.c.validate(f.args);f.c.click(f.args);
 const result=await f.c.waitForTransition(f.args);assert.equal(result.transition,'started');f.c.verifyTransition(f.args,result);assert.equal(f.clicks,1);
 const done={...f.args,requestId:'wizard_request_2',action:'done'};f.mode='finish';await f.c.prepare(done);f.c.click(done);
 const finished=await f.c.waitForTransition(done);assert.equal(finished.transition,'finished');f.c.verifyTransition(done,finished);assert.equal(f.clicks,2);
});
for(const [label,change,pattern] of [
 ['version mismatch',f=>{f.version='2.30';},/GAME_VERSION_MISMATCH/],
 ['unknown version',f=>{f.version='0.0.0';},/GAME_VERSION_UNAVAILABLE/],
 ['metadata identity',f=>{f.revision.id=999;},/REVISION_METADATA_CHANGED/],
 ['missing embedded revision',f=>{delete f.s.persistent.downloads.files.archive.modInfo.nexus.revisionInfo;},/EMBEDDED_REVISION_REQUIRED/],
 ['download drift during version read',f=>{f.changeDuringFetch=()=>{f.revision.gameVersions=[];};},/DOWNLOAD_METADATA_CHANGED/],
 ['logout',f=>{f.s.persistent.nexus.userInfo=null;},/NEXUS_AUTH_REQUIRED/],
 ['dialog',f=>{f.s.session.notifications.dialogs.push({});},/NATIVE_DIALOG_PENDING/],
 ['rules before preparation',f=>{f.owner.rules=[{type:'requires',reference:{id:'new'}}];},/RULES_CHANGED/],
 ['context drift during metadata request',f=>{f.changeDuringFetch=()=>{f.s.settings.profiles.nextProfileId='other';};},/ACTIVE_CONTEXT_CHANGED/],
 ['owner drift during metadata request',f=>{f.changeDuringFetch=()=>{f.owner.attributes.collectionId=999;};},/NATIVE_DOWNLOAD_IDENTITY_CONFLICT/],
])test(`refuses ${label} before click`,async()=>{const f=fixture();await f.c.initialized;f.install();change(f);await assert.rejects(f.c.prepare(f.args),pattern);assert.equal(f.clicks,0);});
test('same event twice invalidates rather than rebinding',async()=>{const f=fixture();await f.c.initialized;f.install();f.api.events.emit('did-install-mod','cyberpunk2077','archive','owner');await assert.rejects(f.c.prepare(f.args),/BINDING_UNAVAILABLE/);});
test('resume cannot manufacture query binding',async()=>{const f=fixture();await f.c.initialized;f.install();f.api.events.emit('resume-collection','cyberpunk2077','owner');await assert.rejects(f.c.prepare(f.args),/BINDING_UNAVAILABLE/);});
test('preexisting owner is not a new installation even after same ID event',async()=>{const f=fixture();f.s.persistent.mods.cyberpunk2077.owner=f.owner;await f.c.initialized;f.install();await assert.rejects(f.c.prepare(f.args),/BINDING_UNAVAILABLE/);});
test('consumed click cannot repeat after native callback throws',async()=>{const f=fixture();await f.c.initialized;f.install();await f.c.prepare(f.args);f.element.click=()=>{throw Error('native-failure');};assert.throws(()=>f.c.click(f.args),/native-failure/);assert.throws(()=>f.c.click(f.args),/PREPARATION_REQUIRED/);await assert.rejects(f.c.prepare({...f.args,requestId:'other_request'}),/ACTION_ALREADY_CONSUMED/);});
test('no native transition is not success and cannot be retried',async()=>{const f=fixture();await f.c.initialized;f.install();await f.c.prepare(f.args);f.element.click=()=>{};f.c.click(f.args);await assert.rejects(f.c.waitForTransition(f.args),/TRANSITION_TIMEOUT/);await assert.rejects(f.c.prepare(f.args),/ACTION_ALREADY_CONSUMED/);});
test('another native session is not completion',async()=>{const f=fixture();await f.c.initialized;f.install();await f.c.prepare(f.args);f.c.click(f.args);f.s.session.collections.activeSession.collectionId='other';await assert.rejects(f.c.waitForTransition(f.args),/SESSION_IDENTITY_CHANGED/);});
test('source generation change between prepare and click refuses',async()=>{const f=fixture();await f.c.initialized;f.install();await f.c.prepare(f.args);f.source=false;assert.throws(()=>f.c.click(f.args));assert.equal(f.clicks,0);});
test('controller registration is per API, not per HTTP request',async()=>{const f=fixture();const a=getCollectionWizardController(f.api,f.options),b=getCollectionWizardController(f.api,f.options);assert.equal(a,b);await a.initialized;});
test('Done does not rebase changed rules after started acceptance',async()=>{
 const f=fixture();await f.c.initialized;f.install();await f.c.prepare(f.args);f.c.click(f.args);const r=await f.c.waitForTransition(f.args);f.c.verifyTransition(f.args,r);
 f.owner.rules=[{type:'requires',reference:{id:'foreign'}}];f.mode='finish';
 await assert.rejects(f.c.prepare({...f.args,requestId:'done_request',action:'done'}),/RULES_CHANGED/);assert.equal(f.clicks,1);
});
test('equivalent duplicate references refuse before SDK could replace the wrong rule',async()=>{
 const f=fixture();f.owner.rules=[{type:'requires',reference:{repo:{modId:1,fileId:2}}},{type:'recommends',reference:{repo:{modId:1,fileId:2},idHint:'other'}}];
 await f.c.initialized;f.install();await assert.rejects(f.c.prepare(f.args),/DUPLICATE_RULE_REFERENCE/);assert.equal(f.clicks,0);
});
test('a committed Done arms the next new collection without restarting Vortex',async()=>{
 const f=fixture();await f.c.initialized;f.install();await f.c.prepare(f.args);f.c.click(f.args);let r=await f.c.waitForTransition(f.args);f.c.verifyTransition(f.args,r);
 const done={...f.args,requestId:'done_request',action:'done'};f.mode='finish';await f.c.prepare(done);f.c.click(done);r=await f.c.waitForTransition(done);f.c.verifyTransition(done,r);f.c.committed(done);
 assert.equal((await f.c.readiness()).status,'idle');
 f.s.persistent.mods.cyberpunk2077['next-owner']=structuredClone(f.owner);f.owner.attributes.customFileName='Previous';
 f.mode='start';f.api.events.emit('did-install-mod','cyberpunk2077','archive','next-owner');
 const ready=await f.c.readiness();assert.equal(ready.modId,'next-owner');assert.equal(ready.status,'ready');
});
