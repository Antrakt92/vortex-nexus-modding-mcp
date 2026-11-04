'use strict';
const crypto=require('node:crypto');
const {isProxy}=require('node:util/types');
const {QUESTION_TEXT}=require('./collection-dialog-policy.cjs');
const DEPENDENCY_TEXT="You're updating a mod that others depend upon and the update doesn't seem to be compatible (according to the dependency information). If you continue we have to disable these dependencies, otherwise you'll continually get warnings about it.";
const need=(v,c)=>{if(!v)throw Error('NATIVE_DIALOG_'+c);};
const id=v=>typeof v==='string'&&v.length>0&&v.length<=512&&!/[\x00-\x1f\x7f]/.test(v);
function field(v,k){need(v&&typeof v==='object'&&!isProxy(v),'RECORD_INVALID');const d=Object.getOwnPropertyDescriptor(v,k);need(!d||Object.hasOwn(d,'value'),'ACCESSOR_REFUSED');return d?.value;}
function snapshot(input){let nodes=0;const seen=new Set();function copy(v,depth){
 need(++nodes<=20000&&depth<=16,'SNAPSHOT_LIMIT');if(v===null||v===undefined||typeof v==='boolean')return v;
 if(typeof v==='string'){need(v.length<=32768,'SNAPSHOT_LIMIT');return v;}if(typeof v==='number'){need(Number.isFinite(v),'VALUE_INVALID');return v;}
 need(typeof v==='object'&&!isProxy(v)&&!seen.has(v),'VALUE_INVALID');const array=Array.isArray(v),proto=Object.getPrototypeOf(v);need(array?proto===Array.prototype:proto===Object.prototype||proto===null,'VALUE_INVALID');
 const keys=Reflect.ownKeys(v);need(keys.length<=2049&&keys.every(k=>typeof k==='string'),'SNAPSHOT_LIMIT');
 if(array)need(v.length<=2048&&keys.length===v.length+1&&keys.every(k=>k==='length'||/^(0|[1-9][0-9]*)$/.test(k)&&Number(k)<v.length),'ARRAY_INVALID');
 seen.add(v);const out=array?[]:Object.create(null);for(const k of keys){if(array&&k==='length')continue;const d=Object.getOwnPropertyDescriptor(v,k);need(d?.enumerable&&Object.hasOwn(d,'value'),'ACCESSOR_REFUSED');Object.defineProperty(out,k,{value:copy(d.value,depth+1),enumerable:true});}seen.delete(v);return out;
 }return copy(input,0);}
function digest(v){function encode(x){if(x===null)return['null'];if(x===undefined)return['undefined'];if(typeof x==='object')return[Array.isArray(x)?'array':'object',Object.keys(x).sort().map(k=>[k,encode(x[k])])];return[typeof x,Object.is(x,-0)?'-0':x];}return crypto.createHash('sha256').update(JSON.stringify(encode(snapshot(v)))).digest('hex');}
function closed(v,keys){need(v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===keys.slice().sort().join(','),'SHAPE_INVALID');}
// Native 2.9.1 InstallManager.queryIgnoreDependent/userVersionChoice and
// actions/notifications.closeDialog. A visible dialog has no callback-origin
// or incoming-archive token. This controller never claims either attribution.
function classify(d){
 closed(d,['id','type','title','content','defaultAction','actions']);need(id(d.id)&&d.type==='question'&&id(d.title)&&d.defaultAction===undefined,'QUESTION_INVALID');
 closed(d.content,['text','options','checkboxes']);closed(d.content.options,['wrap']);need(d.content.options.wrap===true,'QUESTION_INVALID');
 need(Array.isArray(d.content.checkboxes)&&d.content.checkboxes.length===1,'REMEMBER_INVALID');const box=d.content.checkboxes[0];closed(box,['id','value','text']);need(box.id==='remember'&&box.value===false&&box.text==='Remember my choice','REMEMBER_INVALID');
 if(d.title==='Updating may break dependencies'&&d.content.text===DEPENDENCY_TEXT&&digest(d.actions)===digest(['Cancel','Ignore']))return{family:'dependency_warning',actions:{cancel:'Cancel',ignore_dependencies:'Ignore'}};
 if(d.content.text===QUESTION_TEXT&&digest(d.actions)===digest(['Cancel','Update all profiles','Update current profile']))return{family:'previous_version',actions:{cancel:'Cancel',update_current_profile:'Update current profile'}};
 throw Error('NATIVE_DIALOG_UNSUPPORTED_QUESTION');
}
function createNativeDialogController(api,{selectors,assertRead,assertRespond,performResponse=(invoke,eligible)=>{eligible();return invoke();},now=Date.now,sleep=ms=>new Promise(r=>setTimeout(r,ms)),transitionTimeoutMs=15000,pollMs=100}={}){
 need(typeof api?.getState==='function'&&typeof api?.closeDialog==='function'&&typeof selectors?.activeGameId==='function'&&typeof selectors?.activeProfileId==='function','API_UNAVAILABLE');
 need(typeof assertRead==='function'&&typeof assertRespond==='function'&&typeof performResponse==='function'&&typeof now==='function'&&typeof sleep==='function','ADMISSION_REQUIRED');
 need(Number.isInteger(transitionTimeoutMs)&&transitionTimeoutMs>0&&transitionTimeoutMs<=15000&&Number.isInteger(pollMs)&&pollMs>0&&pollMs<=1000,'WAIT_BOUND_INVALID');
 const getState=api.getState,closeDialog=api.closeDialog,gameSelector=selectors.activeGameId,profileSelector=selectors.activeProfileId,used=new Set();let observed=null,busy=false;
 function methods(){need(api.getState===getState&&api.closeDialog===closeDialog&&selectors.activeGameId===gameSelector&&selectors.activeProfileId===profileSelector,'API_CHANGED');}
 function request(args,write=false){const a=snapshot(args);closed(a,write?['gameId','profileId','dialogId','fingerprint','action']:['gameId','profileId']);need(id(a.gameId)&&id(a.profileId),'CONTEXT_REQUIRED');if(write)need(id(a.dialogId)&&/^[a-f0-9]{64}$/.test(a.fingerprint)&&['cancel','ignore_dependencies','update_current_profile'].includes(a.action),'ACTION_INVALID');return a;}
 function capture(args){methods();const s=getState.call(api),gameId=gameSelector(s),profileId=profileSelector(s),settings=field(s,'settings'),next=field(field(settings,'profiles'),'nextProfileId');
  need(gameId===args.gameId&&profileId===args.profileId&&next===profileId,'CONTEXT_CHANGED');const profile=field(field(field(s,'persistent'),'profiles'),profileId);need(field(profile,'gameId')===gameId,'PROFILE_CHANGED');
  const context={gameId,profileId,nextProfileId:next,profileGameId:field(profile,'gameId')};const queue=field(field(field(s,'session'),'notifications'),'dialogs');need(Array.isArray(queue)&&!isProxy(queue)&&queue.length<=128,'QUEUE_INVALID');
  const ids=[];for(let i=0;i<queue.length;i++){const row=field(queue,String(i)),key=field(row,'id');need(id(key)&&!ids.includes(key),'DIALOG_ID_AMBIGUOUS');ids.push(key);}
  if(!queue.length)return{context,ids,front:null};const front=snapshot(field(queue,'0'));return{context,ids,front,fingerprint:digest({context,front})};
 }
 function unchanged(a,b){need(digest(a.context)===digest(b.context),'CONTEXT_CHANGED');need(a.front&&b.front&&a.fingerprint===b.fingerprint,'FRONT_CHANGED');}
 async function bounded(task,deadline){const budget=deadline-now();need(budget>0,'DISMISSAL_TIMEOUT');let timer;try{return await Promise.race([Promise.resolve().then(task),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('NATIVE_DIALOG_DISMISSAL_TIMEOUT')),budget);})]);}finally{clearTimeout(timer);}}
 function evidence(){return{callbackOriginVerified:false,targetArchiveIdentityVerified:false,installationCompleted:false,dialogDismissalOnly:true};}
 return Object.freeze({
  async read(args){need(!busy,'ACTION_PENDING');const a=request(args);await assertRead(a);const first=capture(a);await assertRead(a);const current=capture(a);need(digest(first)===digest(current),'READ_CHANGED');observed=null;
   if(!current.front)return{schema:'native-dialog-readiness/1',status:'empty',queueSize:0,eligibleActions:[],...evidence()};
   const target=classify(current.front);observed={...current,at:now(),family:target.family,actions:target.actions};return{schema:'native-dialog-readiness/1',status:'ready',gameId:a.gameId,profileId:a.profileId,dialogId:current.front.id,fingerprint:current.fingerprint,family:target.family,title:current.front.title,queueSize:current.ids.length,eligibleActions:Object.keys(target.actions),...evidence()};
  },
  async respond(args,context){need(!busy,'ACTION_PENDING');busy=true;let attempted=false;try{
   const a=request(args,true),r=observed;need(r&&r.front.id===a.dialogId&&r.fingerprint===a.fingerprint&&now()-r.at>=0&&now()-r.at<=30000,'FRESH_OBSERVATION_REQUIRED');
   need(Object.hasOwn(r.actions,a.action),'ACTION_FAMILY_MISMATCH');const key=a.dialogId+':'+a.fingerprint;need(!used.has(key),'REPLAY_REFUSED');
   // The captured caller implements source qualification and operation ownership.
   // Cancel is abort-only: its caller must admit it despite a retained failed
   // GLOBAL marker, without clearing that marker or granting mutation authority.
   const scope=Object.freeze({abortOnly:a.action==='cancel',dialogDismissalOnly:true});
   await assertRespond(a,context,scope);unchanged(r,capture(a));await assertRespond(a,context,scope);unchanged(r,capture(a));methods();
   let delegateOpen=true,invokeCalls=0;
   const eligible=()=>{need(delegateOpen&&!attempted,'RESPONSE_NOT_ELIGIBLE');need(now()-r.at>=0&&now()-r.at<=30000,'FRESH_OBSERVATION_REQUIRED');unchanged(r,capture(a));methods();need(!used.has(key),'REPLAY_REFUSED');need(used.size<4096,'ATTEMPT_LIMIT');return true;};
   const invoke=()=>{invokeCalls++;need(invokeCalls===1,'MULTIPLE_RESPONSES_REFUSED');eligible();used.add(key);observed=null;attempted=true;return closeDialog.call(api,a.dialogId,r.actions[a.action],{remember:false});};
   // Only this source-captured seam may arm a normal durable operation. It must
   // call the synchronous eligibility check and fixed invocation inside its
   // guarded effect; no API request can provide or retain either capability.
   try{await performResponse(invoke,eligible,context,scope);}finally{delegateOpen=false;}
   need(invokeCalls===1&&attempted,'RESPONSE_NOT_INVOKED');
   const deadline=now()+transitionTimeoutMs;while(true){await bounded(()=>assertRead({gameId:a.gameId,profileId:a.profileId}),deadline);const current=capture(a);need(digest(current.context)===digest(r.context),'CONTEXT_CHANGED');
    if(!current.ids.includes(a.dialogId)){const tail=r.ids.slice(1);need(current.ids.length>=tail.length&&tail.every((id,i)=>current.ids[i]===id),'OTHER_DIALOG_CHANGED');return{schema:'native-dialog-response/1',action:a.action,dialogId:a.dialogId,nativeDialogDismissalVerified:true,remember:false,abortOnly:scope.abortOnly,...evidence()};}
    need(current.fingerprint===r.fingerprint,'FRONT_CHANGED');need(now()<deadline,'DISMISSAL_TIMEOUT');await bounded(()=>sleep(pollMs),deadline);
   }
  }catch(error){if(attempted)throw Error('NATIVE_DIALOG_EFFECT_UNCERTAIN_RECONCILE');throw error;}finally{busy=false;}
  }
 });
}
module.exports={createNativeDialogController};
