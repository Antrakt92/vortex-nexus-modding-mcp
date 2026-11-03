'use strict';
const {isProxy} = require('node:util/types');
const {validateCollectionDialog} = require('./collection-dialog-policy.cjs');
const {createWizardHostAdmission} = require('./collection-wizard-host.cjs');
const IDENTITY = ['gameId','profileId','modId','archiveId','collectionId','revisionId','revisionNumber'];
const fail = code => {throw Error('COLLECTION_DIALOG_'+code);};
const need = (value,code) => {if(!value)fail(code);};
function field(object,key) {
  if(object === undefined || object === null)return undefined;
  need(typeof object==='object'&&!isProxy(object),'RECORD_INVALID');
  const d=Object.getOwnPropertyDescriptor(object,key);
  if(!d)return undefined;
  need(Object.hasOwn(d,'value'),'ACCESSOR_REFUSED');return d.value;
}
function entries(object) {
  need(object&&typeof object==='object'&&!Array.isArray(object)&&!isProxy(object),'RECORD_INVALID');
  const keys=Reflect.ownKeys(object);need(keys.length<=10000&&keys.every(k=>typeof k==='string'),'RECORD_LIMIT');
  return keys.map(key=>[key,field(object,key)]);
}
function copy(input) {
  let nodes=0;const chain=new Set();
  function walk(v,depth) {
    need(++nodes<=100000&&depth<=24,'SNAPSHOT_LIMIT');
    if(v===undefined||v===null||typeof v==='boolean')return v;
    if(typeof v==='string'){need(v.length<=1048576,'SNAPSHOT_LIMIT');return v;}
    if(typeof v==='number'){need(Number.isFinite(v),'SNAPSHOT_INVALID');return v;}
    need(typeof v==='object'&&!isProxy(v)&&!chain.has(v),'SNAPSHOT_INVALID');
    const array=Array.isArray(v),proto=Object.getPrototypeOf(v);
    need(array?proto===Array.prototype:proto===null||proto===Object.prototype,'SNAPSHOT_INVALID');
    const keys=Reflect.ownKeys(v);need(keys.length<=10001&&keys.every(k=>typeof k==='string'),'SNAPSHOT_INVALID');
    if(array)need(keys.length===v.length+1&&keys.every(k=>k==='length'||/^(0|[1-9][0-9]*)$/.test(k)&&Number(k)<v.length),'SNAPSHOT_INVALID');
    chain.add(v);const out=array?[]:Object.create(null);
    for(const key of keys){if(array&&key==='length')continue;const d=Object.getOwnPropertyDescriptor(v,key);
      need(d&&d.enumerable&&Object.hasOwn(d,'value'),'SNAPSHOT_INVALID');
      Object.defineProperty(out,key,{value:walk(d.value,depth+1),enumerable:true,writable:true,configurable:true});}
    chain.delete(v);return out;
  }
  return walk(input,0);
}
function fingerprint(input) {
  function encode(v){if(v===null)return ['null'];if(v===undefined)return ['undefined'];
    if(Array.isArray(v))return ['array',...v.map(encode)];
    if(typeof v==='object')return ['object',...Object.keys(v).sort().map(k=>[k,encode(v[k])])];
    return [typeof v,Object.is(v,-0)?'-0':v];}
  return JSON.stringify(encode(copy(input)));
}
function positive(value){if(typeof value==='string'&&/^[1-9][0-9]*$/.test(value))value=Number(value);
  return Number.isSafeInteger(value)&&value>0?value:null;}
const pick=(value,keys)=>Object.fromEntries(keys.map(key=>[key,field(value,key)]));
const sameIdentity=(a,b)=>IDENTITY.every(key=>a[key]===b[key]);

// Internal controller only. getBinding is captured from the genuine wizard
// controller, not an MCP request/provider. Sources and all live records remain
// source-owned. Stock dialog has NO incoming archive/callback-origin field;
// observed will-install-mod + metadata joins establish only the bounded epoch
// family, never cryptographic/private-callback archive attribution.
function createCollectionDialogController(api,{selectors,util,getBinding,admit,admitRead,transitionTimeoutMs=15000,pollMs=100}={}) {
  need(Number.isSafeInteger(transitionTimeoutMs)&&transitionTimeoutMs>0&&transitionTimeoutMs<=15000
    &&Number.isSafeInteger(pollMs)&&pollMs>0&&pollMs<=1000,'WAIT_BOUND_INVALID');
  need(typeof getBinding==='function'&&typeof api?.getState==='function'&&typeof api?.closeDialog==='function'
    &&typeof api?.onAsync==='function'&&typeof api?.events?.on==='function','API_UNAVAILABLE');
  need(typeof selectors?.activeGameId==='function'&&typeof selectors?.activeProfileId==='function'
    &&typeof util?.renderModName==='function','API_UNAVAILABLE');
  const getState=api.getState,closeDialog=api.closeDialog,render=util.renderModName;
  const writeAdmission=admit||createWizardHostAdmission(api,util),readAdmission=admitRead||createWizardHostAdmission(api,util);
  need(typeof writeAdmission==='function'&&typeof writeAdmission.revalidate==='function'
    &&typeof readAdmission==='function'&&typeof readAdmission.revalidate==='function','ADMISSION_UNAVAILABLE');
  let prepared=null,reading=Promise.resolve(),lifecycleHeld=false;
  const attempts=new Map(),noEffectRequests=new Set();
  function methods(){need(api.getState===getState&&api.closeDialog===closeDialog&&util.renderModName===render,'API_CHANGED');}
  function binding(){const b=copy(getBinding());need(b&&b.epochReady===true&&b.invalidated===false&&typeof b.sessionId==='string','BINDING_UNAVAILABLE');return b;}
  // Installed stock InstallManager awaits this event BEFORE previous-version
  // detection and userVersionChoice; it supplies actual game/archive/mod IDs.
  api.onAsync('will-install-mod',async(gameId,archiveId,modId)=>{
    try{methods();need(typeof archiveId==='string'&&archiveId.length>0&&typeof modId==='string'&&modId.length>0,'LIFECYCLE_INVALID');
      need(!attempts.has(archiveId)&&attempts.size<4096,'LIFECYCLE_AMBIGUOUS');
      let b=null;try{b=binding();}catch(_){/* Pre-epoch work can only be retired by its real success event. */}
      attempts.set(archiveId,{gameId,archiveId,modId,binding:b});
    }catch(_){lifecycleHeld=true;}
  });
  api.events.on('did-install-mod',(gameId,archiveId,modId)=>{
    const a=attempts.get(archiveId);if(!a)return;
    try{
      methods();need(a.gameId===gameId&&typeof modId==='string'&&modId.length>0,'LIFECYCLE_CHANGED');
      // Stock derives/renames the provisional ID AFTER will-install-mod. The
      // successful final ID is authoritative only with its actual installed
      // Redux record and the SAME observed game/archive, including pre-epoch
      // collection-owner installation. Never manufacture closure from an ID.
      const s=getState.call(api),mod=field(field(field(field(s,'persistent'),'mods'),gameId),modId);
      need(field(mod,'state')==='installed'&&field(mod,'archiveId')===archiveId,'LIFECYCLE_CHANGED');
      attempts.delete(archiveId);
    }catch(_){lifecycleHeld=true;}
  });
  function project(expected) {
    methods();need(!lifecycleHeld,'LIFECYCLE_HELD');const b=binding(),s=getState.call(api);
    const persistent=field(s,'persistent'),sessionRoot=field(field(s,'session'),'collections');
    const rawSession=field(sessionRoot,'activeSession'),rawMembers=field(rawSession,'mods');
    const game=selectors.activeGameId(s),profile=selectors.activeProfileId(s);
    const rawMods=field(field(persistent,'mods'),game),rawDownloads=field(field(persistent,'downloads'),'files');
    const rawOwner=field(rawMods,b.modId),attrs=field(rawOwner,'attributes');
    const owner={id:b.modId,archiveId:field(rawOwner,'archiveId'),state:field(rawOwner,'state'),type:field(rawOwner,'type'),
      collectionId:positive(field(attrs,'collectionId')),revisionId:positive(field(attrs,'revisionId')),
      revisionNumber:positive(field(attrs,'revisionNumber')??field(attrs,'version'))};
    const members=[];
    for(const [memberKey,row]of entries(rawMembers))if(field(row,'status')==='installing'){
      const rule=field(row,'rule'),repo=field(field(rule,'reference'),'repo'),type=field(row,'type');
      need(field(rule,'type')===type,'RULE_CHANGED');
      members.push({memberKey,status:'installing',type,repo:{gameId:field(repo,'gameId'),modId:positive(field(repo,'modId')),fileId:positive(field(repo,'fileId'))}});
    }
    const downloads=[];
    for(const [id,row]of entries(rawDownloads)){
      const ids=field(field(field(row,'modInfo'),'nexus'),'ids'),modId=positive(field(ids,'modId')),fileId=positive(field(ids,'fileId'));
      if(!members.some(m=>m.repo.modId===modId&&m.repo.fileId===fileId))continue;
      const games=field(row,'game'),declared=field(ids,'gameId');
      need(Array.isArray(games)&&games.includes(game)&&(declared===undefined||declared===game),'DOWNLOAD_GAME_AMBIGUOUS');
      downloads.push({id,state:field(row,'state'),gameId:game,nexusModId:modId,nexusFileId:fileId});
    }
    const mods=[];
    for(const [id,row]of entries(rawMods)){
      if(field(row,'state')==='installing')need(attempts.has(field(row,'archiveId')),'UNOBSERVED_INSTALL');
      if(field(row,'state')!=='installed')continue;
      mods.push({id,state:'installed',type:field(row,'type')??'',gameId:game,nexusModId:positive(field(field(row,'attributes'),'modId')),name:render.call(util,row)});
    }
    const pendingDialogs=copy(field(field(field(s,'session'),'notifications'),'dialogs'));
    need(Array.isArray(pendingDialogs),'DIALOGS_UNAVAILABLE');
    const native={sourceAdmitted:true,gameId:game,profileId:profile,nextProfileId:field(field(field(s,'settings'),'profiles'),'nextProfileId')??null,
      owner,session:{sessionId:field(rawSession,'sessionId'),collectionId:field(rawSession,'collectionId'),gameId:field(rawSession,'gameId'),
        profileId:field(rawSession,'profileId'),stalled:field(rawSession,'stalled')===true},members,downloads,mods};
    const input={expected,binding:b,native,pendingDialogs},target=validateCollectionDialog(input);
    // No guessing missed/pre-existing native attempts. Every observed outstanding
    // install must be a uniquely joined member of this same retained epoch.
    for(const a of attempts.values()){
      need(a.binding&&sameIdentity(a.binding,b)&&a.binding.sessionId===b.sessionId&&a.gameId===game,'UNRELATED_INSTALL');
      const matches=downloads.filter(d=>d.id===a.archiveId);need(matches.length===1,'UNRELATED_INSTALL');
    }
    const attempt=attempts.get(target.downloadId);need(attempt&&attempt.binding,'INSTALL_NOT_OBSERVED');
    need(pendingDialogs.filter(d=>d.title===pendingDialogs[0].title).length===1,'DIALOG_ORIGIN_AMBIGUOUS');
    const pins={owner:rawOwner,member:field(rawMembers,target.memberKey),download:field(rawDownloads,target.downloadId),
      oldMods:target.oldModIds.map(id=>({id,record:field(rawMods,id)}))};
    const stamp=fingerprint(pins);methods();need(fingerprint(binding())===fingerprint(b),'BINDING_CHANGED');
    return {input,target,stamp,queue:pendingDialogs,binding:b,attempt};
  }
  function expectedFrom(args){return copy({...pick(args,IDENTITY),dialogId:field(args,'dialogId'),action:field(args,'action')});}
  function hold(record,error){
    if(record&&prepared===record&&record.phase!=='completed'){
      // No answer has been attempted in these phases. Retire ONLY this failed
      // preparation, retaining a bounded local ID tombstone as well as the shared
      // guard's failed receipt. Consumed/uncertain and lifecycle holds never reset.
      if(['checking','prepared'].includes(record.phase)&&!record.reentered&&!lifecycleHeld&&noEffectRequests.size<4096){
        noEffectRequests.add(record.requestId);record.phase='rejected';prepared=null;
      }else record.phase='held';
    }
    throw error;
  }
  function validate(args){const r=prepared;
    if(r?.checking){r.reentered=true;r.phase='held';fail('REENTRY');}
    try{need(r&&r.phase==='prepared'&&!r.checking,'PREPARATION_REQUIRED');r.checking=true;
      need(r.requestId===field(args,'requestId')&&fingerprint(expectedFrom(args))===r.expectedKey,'REQUEST_CHANGED');
      writeAdmission.revalidate(r.proof);const now=project(r.expected);
      need(now.stamp===r.stamp&&now.attempt===r.attempt,'PREPARATION_CHANGED');
      need(now.queue.length>=r.queue.length&&fingerprint(now.queue.slice(0,r.queue.length))===fingerprint(r.queue),'PREPARATION_CHANGED');
      writeAdmission.revalidate(r.proof);
      methods();need(prepared===r&&r.phase==='prepared','PREPARATION_CHANGED');r.latestQueue=now.queue;r.checking=false;return true;
    }catch(error){if(r)r.checking=false;return hold(r,error);}
  }
  function checkTransition(r){
    need(prepared===r&&['waiting','completed'].includes(r.phase),'TRANSITION_UNAVAILABLE');methods();writeAdmission.revalidate(r.proof);
    const b=binding();need(sameIdentity(b,r.binding)&&b.sessionId===r.binding.sessionId,'BINDING_CHANGED');
    const s=getState.call(api),session=field(field(field(s,'session'),'collections'),'activeSession');
    need(selectors.activeGameId(s)===b.gameId&&selectors.activeProfileId(s)===b.profileId
      &&field(field(field(s,'settings'),'profiles'),'nextProfileId')===b.profileId,'CONTEXT_CHANGED');
    need(field(session,'sessionId')===b.sessionId&&field(session,'collectionId')===b.modId&&field(session,'profileId')===b.profileId
      &&field(session,'gameId')===b.gameId&&field(session,'stalled')!==true,'SESSION_CHANGED');
    const owner=field(field(field(field(s,'persistent'),'mods'),b.gameId),b.modId),attrs=field(owner,'attributes');
    need(field(owner,'state')==='installed'&&field(owner,'type')==='collection'&&field(owner,'archiveId')===b.archiveId
      &&positive(field(attrs,'collectionId'))===b.collectionId&&positive(field(attrs,'revisionId'))===b.revisionId
      &&positive(field(attrs,'revisionNumber')??field(attrs,'version'))===b.revisionNumber,'OWNER_CHANGED');
    const dialogs=copy(field(field(field(s,'session'),'notifications'),'dialogs'));
    need(Array.isArray(dialogs),'DIALOGS_UNAVAILABLE');if(dialogs.some(d=>d.id===r.target.dialogId))return false;
    const remaining=r.queue.slice(1);need(dialogs.length>=remaining.length&&fingerprint(dialogs.slice(0,remaining.length))===fingerprint(remaining),'OTHER_DIALOG_ANSWERED');
    writeAdmission.revalidate(r.proof);methods();need(prepared===r&&['waiting','completed'].includes(r.phase),'TRANSITION_UNAVAILABLE');return true;
  }
  return Object.freeze({
    readiness(){const work=reading.then(async()=>{
      const out={schema:'collection-dialog-readiness/1',status:'held',reason:'COLLECTION_DIALOG_UNAVAILABLE',sourceAdmitted:false,
        callbackOriginVerified:false,targetArchiveIdentityVerified:false,nativeTransitionVerified:false};
      try{const proof=await readAdmission();readAdmission.revalidate(proof);out.sourceAdmitted=true;
        need(!prepared||prepared.phase==='completed','ACTION_ALREADY_PENDING');
        const b=binding(),s=getState.call(api),dialogs=field(field(field(s,'session'),'notifications'),'dialogs');
        need(Array.isArray(dialogs)&&dialogs.length>0,'DIALOGS_UNAVAILABLE');
        const expected={...pick(b,IDENTITY),dialogId:field(dialogs[0],'id'),action:'update_current_profile'};
        const p=project(expected);readAdmission.revalidate(proof);
        Object.assign(out,expected,{status:'ready',reason:'COLLECTION_DIALOG_PREFLIGHT_REQUIRED',sessionId:b.sessionId,
          memberKey:p.target.memberKey,downloadId:p.target.downloadId,oldModIds:p.target.oldModIds});
      }catch(e){out.reason=/^COLLECTION_(?:DIALOG|WIZARD)_[A-Z0-9_]+$/.test(e?.message)?e.message:'COLLECTION_DIALOG_UNAVAILABLE';}return out;
    });reading=work.catch(()=>{});return work;},
    async prepare(args){need(!prepared||prepared.phase==='completed','ACTION_ALREADY_PENDING');
      const expected=expectedFrom(args),requestId=field(args,'requestId');need(typeof requestId==='string'&&/^[a-zA-Z0-9_-]{8,80}$/.test(requestId),'REQUEST_INVALID');
      need(!noEffectRequests.has(requestId),'REQUEST_ALREADY_USED');
      const r={phase:'checking',requestId,expected,expectedKey:fingerprint(expected)};prepared=r;
      try{r.proof=await writeAdmission();need(prepared===r&&r.phase==='checking','REENTRY');
        const p=project(expected);Object.assign(r,p,{phase:'prepared',checking:false});validate(args);
      }catch(e){hold(r,e);}
    },
    validate,
    respond(args){validate(args);const r=prepared;r.queue=r.latestQueue;r.phase='waiting';
      try{closeDialog.call(api,r.target.dialogId,'Update current profile',{remember:false});}
      catch(e){hold(r,e);}
    },
    async waitForTransition(args){const r=prepared;need(r&&r.requestId===field(args,'requestId'),'PREPARATION_REQUIRED');
      need(r.phase==='waiting','TRANSITION_UNAVAILABLE');
      const deadline=Date.now()+transitionTimeoutMs;
      try{while(!checkTransition(r)){need(Date.now()<deadline,'TRANSITION_TIMEOUT');await new Promise(resolve=>setTimeout(resolve,pollMs));}
        r.result=Object.freeze({...r.target,nativeDialogDismissalVerified:true,installationCompleted:false});return r.result;
      }catch(e){hold(r,e);}
    },
    verifyTransition(args,result){const r=prepared;
      try{need(r&&r.requestId===field(args,'requestId')&&r.result===result,'TRANSITION_UNAVAILABLE');need(checkTransition(r),'TRANSITION_UNVERIFIED');r.phase='completed';return true;}
      catch(e){hold(r,e);}
    },
  });
}
module.exports={createCollectionDialogController};
