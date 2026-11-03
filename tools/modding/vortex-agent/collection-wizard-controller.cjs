'use strict';
const {inspect}=require('./collection-wizard-dom.cjs');
const {observeNative,normalizeSession}=require('./collection-wizard-native.cjs');
const {validateCollectionWizard}=require('./collection-wizard-policy.cjs');
const {createWizardHostAdmission}=require('./collection-wizard-host.cjs');
const controllers=new WeakMap();
const need=(v,code)=>{if(!v)throw Error('COLLECTION_WIZARD_'+code);};
const stable=value=>JSON.stringify(value,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)
 ? Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
const positive=v=>typeof v==='number'&&Number.isSafeInteger(v)&&v>0;
function uniqueReferences(rules){
 need(Array.isArray(rules)&&rules.length<=10000,'RULES_UNAVAILABLE');
 const rows=rules.map(rule=>{
  need(rule.reference&&typeof rule.reference==='object'&&!Array.isArray(rule.reference),'RULE_REFERENCE_UNAVAILABLE');
  const ref=Object.fromEntries(Object.entries(rule.reference).filter(([,v])=>v!==undefined));
  return {ref,idOnly:ref.id!==undefined&&Object.keys(ref).filter(k=>!['archiveId','versionMatch','idHint'].includes(k)).length===1};
 });
 // Stock source643 referenceEqual, after reducer596 omits undefined values.
 const ids=new Map(),keys=new Set();
 for(const {ref} of rows)ids.set(ref.id,(ids.get(ref.id)||0)+1);
 for(const {ref,idOnly} of rows){
  if(idOnly){need(ids.get(ref.id)===1,'DUPLICATE_RULE_REFERENCE');continue;}
  const key=stable(Object.fromEntries(['fileMD5','logicalFileName','fileExpression','versionMatch','repo','tag'].filter(k=>Object.hasOwn(ref,k)).map(k=>[k,ref[k]])));
  need(!keys.has(key),'DUPLICATE_RULE_REFERENCE');keys.add(key);
 }
}
async function bounded(promise,milliseconds,code){
 let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('COLLECTION_WIZARD_'+code)),milliseconds);})]);}
 finally{clearTimeout(timer);}
}
function createCollectionWizardController(api,options){
 const {selectors,util}=options;
 const doc=()=>options.getDocument?options.getDocument():typeof document==='object'?document:null;
 const t=(...args)=>api.translate(...args);
 const admit=options.admit||createWizardHostAdmission(api,util);
 const inspectDOM=options.inspectDOM||inspect;
 let ready=false,invalidated=false,binding=null,epochIds=new Set(),prepared=null,proof=null;
 const state=()=>api.getState();
 const rawOwner=(id)=>state().persistent?.mods?.cyberpunk2077?.[id];
 const native=()=>observeNative({state:state(),selectors,util,t,modId:binding?.modId,sourceAdmitted:proof!==null});
 const dom=n=>inspectDOM(doc(),{t,profileLabel:n?.profileLabel});
 const context=()=>({gameId:selectors.activeGameId(state()),profileId:selectors.activeProfileId(state())});
 function invalidate(){invalidated=true;if(binding)binding.invalidated=true;}
 function event(kind,gameId,archiveId,modId){
  const owner=rawOwner(modId);
  if(gameId!=='cyberpunk2077'||owner?.type!=='collection')return;
  if(!ready||binding||kind!=='new-owner-installed'){invalidate();return;}
  try{
   const c=context();need(c.gameId===gameId&&owner.archiveId===archiveId&&owner.state==='installed','EVENT_IDENTITY_CHANGED');
   need(!epochIds.has(modId),'OWNER_PREEXISTED');
   binding={kind,...c,modId,archiveId,epochReady:true,invalidated:false,ownerAbsentAtEpoch:true};
   // Persist the event-time identity and inputs, not a DOM name-based guess.
   binding.ownerIdentity=stable(native().owner);
   binding.rules=stable(owner.rules??[]);
  }catch(_){invalidate();}
 }
 api.events.on('did-install-mod',(gameId,archiveId,modId)=>event('new-owner-installed',gameId,archiveId,modId));
 // Resume starts immediately in stock Vortex; it is not an Install Now query.
 // Refuse an unrelated resume instead of using it to authorize a different view.
 api.events.on('resume-collection',(gameId,modId)=>event('resume',gameId,rawOwner(modId)?.archiveId,modId));
 const initialized=bounded(Promise.resolve().then(()=>api.awaitUI()),180000,'UI_TIMEOUT').then(()=>{
  const s=state();
  need(s.session?.collections&&s.session.collections.activeSession===undefined,'PREEXISTING_SESSION');
  need(inspectDOM(doc(),{t}).status==='idle','PREEXISTING_WIZARD');
  epochIds=new Set(Object.keys(s.persistent?.mods?.cyberpunk2077??{}));
  ready=true;
 }).catch(()=>{invalidate();});
 function observe(){
  need(ready&&!invalidated&&binding&&!binding.invalidated,'BINDING_UNAVAILABLE');
  const n=native();need(stable(n.owner)===binding.ownerIdentity,'OWNER_CHANGED');
  return {n,d:dom(n)};
 }
 function validate(args){
  need(prepared&&prepared.requestId===args.requestId&&!prepared.consumed,'PREPARATION_REQUIRED');
  admit.revalidate(proof);
  const {n,d}=observe();
  validateCollectionWizard({expected:args,native:n,dom:d,binding});
  need(stable(rawOwner(args.modId).rules??[])===prepared.rules,'RULES_CHANGED');
  need(stable(state().persistent.downloads.files[args.archiveId].modInfo)===prepared.downloadInfo,'DOWNLOAD_METADATA_CHANGED');
  need(d.candidate&&d.candidate.element===prepared.element&&d.candidate.modal===prepared.modal,'DOM_REPLACED');
  return true;
 }
 async function versionPreflight(args){
  const s=state(),download=s.persistent.downloads.files[args.archiveId];
  const info=download.modInfo,ids=info.nexus.ids,slug=ids.collectionSlug;
  need(typeof slug==='string'&&/^[a-zA-Z0-9_-]{1,200}$/.test(slug),'SLUG_UNAVAILABLE');
  need(Number(ids.revisionNumber)===args.revisionNumber,'DOWNLOAD_REVISION_CHANGED');
  need(s.persistent.nexus?.userInfo!=null,'NEXUS_AUTH_REQUIRED');
  // InstallDriver.startInstall prefers this exact embedded revision. A fresh
  // external fetch does not prove what its private InfoCache will consume.
  const revision=info.nexus.revisionInfo;
  need(revision&&Array.isArray(revision.modFiles),'EMBEDDED_REVISION_REQUIRED');
  need(revision&&revision.id===args.revisionId&&revision.revisionNumber===args.revisionNumber
   &&revision.collection?.id===args.collectionId&&revision.collection.slug===slug
   &&revision.collection.game?.domainName==='cyberpunk2077','REVISION_METADATA_CHANGED');
  need(Array.isArray(revision.gameVersions)&&revision.gameVersions.every(v=>typeof v.reference==='string')
   &&Array.isArray(revision.modFiles),'REVISION_METADATA_UNAVAILABLE');
  const game=util.getGame(args.gameId),discovery=selectors.discoveryByGame(state(),args.gameId);
  need(typeof game?.getInstalledVersion==='function'&&discovery,'GAME_VERSION_UNAVAILABLE');
  const version=await bounded(game.getInstalledVersion(discovery),5000,'GAME_VERSION_TIMEOUT');
  need(typeof version==='string'&&version!=='0.0.0'&&version.length>0,'GAME_VERSION_UNAVAILABLE');
  need(!revision.gameVersions.length||revision.gameVersions.some(v=>v.reference===version),'GAME_VERSION_MISMATCH');
  return revision;
 }
 function rulesAfterStart(rules,revision){
  return rules.map(rule=>{
   const repo=rule.reference?.repo;
   const match=repo&&revision.modFiles.find(row=>row.file&&String(row.file.modId)===String(repo.modId)
    &&String(row.file.fileId)===String(repo.fileId));
   return match?{...rule,extra:{...rule.extra,fileName:match.file.uri}}:rule;
  });
 }
 function checkTransition(args){
  need(prepared?.consumed&&prepared.requestId===args.requestId,'CLICK_REQUIRED');
  const {n}=observe();
  need(n.gameId===args.gameId&&n.profileId===args.profileId&&n.nextProfileId===args.profileId,'ACTIVE_CONTEXT_CHANGED');
  need(n.pendingDialogCount===0,'NATIVE_DIALOG_PENDING');
  const rules=stable(rawOwner(args.modId).rules??[]);
  need(rules===prepared.rules||rules===prepared.augmentedRules,'RULES_CHANGED');
  const raw=state().session.collections.activeSession;
  if(args.action==='install_now'){
   if(raw===undefined)return false;
   need(n.session.collectionId===args.modId&&n.session.profileId===args.profileId&&n.session.gameId===args.gameId,'SESSION_IDENTITY_CHANGED');
   need(typeof raw.sessionId==='string'&&raw.sessionId.length>0&&!prepared.oldSessions.has(raw.sessionId),'SESSION_PREEXISTED');
   binding.sessionId=raw.sessionId;
   return true;
  }
  if(raw!==undefined){need(raw.sessionId===prepared.sessionId,'SESSION_IDENTITY_CHANGED');return false;}
  const c=state().session.collections,h=c.sessionHistory?.[prepared.sessionId];
  need(c.lastActiveSessionId===prepared.sessionId&&h&&stable(normalizeSession(h))===prepared.completedSession,'FINISH_HISTORY_UNVERIFIED');
  need(dom(n).status==='idle','FINISH_MODAL_PRESENT');
  return true;
 }
 return {
  initialized,
  async readiness(){
   await initialized;
   const out={schema:'collection-wizard-readiness/1',protocol:'vortex-agent/1',observedAtUTC:new Date().toISOString(),
    status:'held',phase:null,action:null,reason:'COLLECTION_WIZARD_BINDING_UNAVAILABLE',sourceAdmitted:false,
    bindingReady:false,writesAvailable:false,nativeTransitionVerified:false};
   if(!binding){const d=dom();if(ready&&!invalidated&&d.status==='idle'){out.status='idle';out.reason='COLLECTION_WIZARD_IDLE';}return out;}
   try{
    proof=await admit();const {n,d}=observe();
    Object.assign(out,{gameId:n.gameId,profileId:n.profileId,modId:n.owner.id,archiveId:n.owner.archiveId,
     collectionId:n.owner.collectionId,revisionId:n.owner.revisionId,revisionNumber:n.owner.revisionNumber,
     phase:d.phase??null,action:d.phase==='start'?'install_now':d.phase==='finish'?'done':null,sourceAdmitted:true,bindingReady:true});
    validateCollectionWizard({expected:out,native:n,dom:d,binding});
    out.status='ready';out.reason='COLLECTION_WIZARD_PREFLIGHT_REQUIRED';
    // Readiness never substitutes for asynchronous metadata/source preparation.
   }catch(e){out.reason=/^COLLECTION_WIZARD_[A-Z0-9_]+$/.test(e.message)?e.message:'COLLECTION_WIZARD_SOURCE_UNAVAILABLE';}
   return out;
  },
  async prepare(args){
   await initialized;need(!prepared?.consumed||prepared.completed,'ACTION_ALREADY_CONSUMED');
   need(positive(args.collectionId)&&positive(args.revisionId)&&positive(args.revisionNumber),'REMOTE_IDENTITY_INVALID');
   proof=await admit();const {n,d}=observe();validateCollectionWizard({expected:args,native:n,dom:d,binding});
   need(d.candidate,'DOM_ACTION_UNAVAILABLE');
   need(args.action!=='done'||binding.sessionId===state().session.collections.activeSession?.sessionId,'SESSION_NOT_OBSERVED');
   const rules=rawOwner(args.modId).rules??[];
   uniqueReferences(rules);
   const ruleKey=stable(rules);
   need(ruleKey===binding.rules||(args.action==='done'&&ruleKey===binding.augmentedRules),'RULES_CHANGED');
   const downloadInfo=stable(state().persistent.downloads.files[args.archiveId].modInfo);
   const revision=args.action==='install_now'?await versionPreflight(args):null;
   const raw=state().session.collections.activeSession;
   prepared={requestId:args.requestId,consumed:false,completed:false,element:d.candidate.element,modal:d.candidate.modal,
    rules:ruleKey,downloadInfo,augmentedRules:revision?stable(rulesAfterStart(rules,revision)):ruleKey,
    oldSessions:new Set(Object.keys(state().session.collections.sessionHistory??{})),sessionId:raw?.sessionId,
    completedSession:n.session?stable(n.session):null};
   validate(args);
   if(args.action==='install_now')binding.augmentedRules=prepared.augmentedRules;
  },
  validate,
  click(args){validate(args);prepared.consumed=true;prepared.element.click();return true;},
  async waitForTransition(args){
   const deadline=Date.now()+(options.transitionTimeoutMs??15000);
   while(!checkTransition(args)){need(Date.now()<deadline,'TRANSITION_TIMEOUT');await new Promise(r=>setTimeout(r,options.pollMs??100));}
   return Object.fromEntries([...['modId','archiveId','collectionId','revisionId','revisionNumber','action'].map(k=>[k,args[k]]),
    ['transition',args.action==='install_now'?'started':'finished'],['nativeTransitionVerified',true]]);
  },
  verifyTransition(args,result){admit.revalidate(proof);need(checkTransition(args),'TRANSITION_UNVERIFIED');need(result.nativeTransitionVerified===true,'TRANSITION_UNVERIFIED');prepared.completed=true;return true;},
  committed(args){
   // A new epoch starts only AFTER the shared guard published its receipt and
   // released the mutation lock. Never clear an uncertain action in memory.
   if(args.action!=='done')return;
   try{
    need(prepared?.completed&&prepared.requestId===args.requestId,'COMMIT_UNVERIFIED');
    need(state().session.collections.activeSession===undefined&&dom().status==='idle','EPOCH_NOT_IDLE');
    epochIds=new Set(Object.keys(state().persistent?.mods?.cyberpunk2077??{}));binding=null;prepared=null;
   }catch(_){invalidate();}
  },
 };
}
function getCollectionWizardController(api,options){
 if(!controllers.has(api))controllers.set(api,createCollectionWizardController(api,options));
 return controllers.get(api);
}
module.exports={getCollectionWizardController,createCollectionWizardController};
