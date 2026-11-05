'use strict';
const {isProxy,isDate}=require('node:util/types'),crypto=require('node:crypto');
const need=(v,c)=>{if(!v)throw Error('MOD_RECORD_FINGERPRINTS_'+c);};
const id=v=>typeof v==='string'&&v.length>0&&v.length<=512&&!/[\x00-\x1f\x7f]/.test(v);
// Exact tagged encoding domain of our collection raw-state.cjs (R3): numbers
// are strings, object keys and array index keys are sorted lexicographically.
// Additional bounded-input refusals do not alter the encoded accepted values.
function encode(input,nativeRecord=false){let nodes=0;const ancestors=new Set();function copy(v,depth,at){
 need(++nodes<=1000000&&depth<=40,'RAW_LIMIT');if(v===undefined)return['undefined'];if(v===null)return['null'];
 if(typeof v==='boolean'||typeof v==='string'){if(typeof v==='string')need(v.length<=1048576,'RAW_LIMIT');return[typeof v,v];}
 if(typeof v==='number'){need(Number.isFinite(v),'RAW_NUMBER');return['number',Object.is(v,-0)?'-0':String(v)];}
 need(typeof v==='object'&&!isProxy(v)&&!ancestors.has(v),'RAW_INVALID');
 // WHY: a freshly installed native record carries this one Date until persistence.
 // Keep the reviewed native-origin tag; all other fields/arguments remain raw515.
 if(nativeRecord&&isDate(v)){need(at.length===2&&at[0]==='attributes'&&at[1]==='installTime'&&Reflect.ownKeys(v).length===0,'RAW_DATE_PATH');const milliseconds=Date.prototype.getTime.call(v);need(Number.isFinite(milliseconds),'RAW_DATE_INVALID');return['native-install-date',String(milliseconds)];}
 const array=Array.isArray(v),proto=Object.getPrototypeOf(v),keys=Reflect.ownKeys(v);
 need(array?proto===Array.prototype:proto===Object.prototype||proto===null,'RAW_PROTO');need(keys.length<=100001,'RAW_LIMIT');need(keys.every(k=>typeof k==='string'),'RAW_SYMBOL');
 if(array)need(keys.length===v.length+1&&keys.every(k=>k==='length'||/^(0|[1-9][0-9]*)$/.test(k)&&Number(k)<v.length),'RAW_ARRAY');
 ancestors.add(v);const rows=[];for(const key of keys.filter(k=>!array||k!=='length').sort()){const d=Object.getOwnPropertyDescriptor(v,key);need(d&&Object.hasOwn(d,'value')&&d.enumerable,'RAW_DESCRIPTOR');rows.push([key,copy(d.value,depth+1,at.concat(key))]);}ancestors.delete(v);return[array?'array':'object',rows];
 }return copy(input,0,[]);}
const hashEncoded=v=>crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex'),digest=v=>hashEncoded(encode(v));
function field(o,k){need(o&&typeof o==='object'&&!Array.isArray(o)&&!isProxy(o)&&[Object.prototype,null].includes(Object.getPrototypeOf(o)),'RECORD_INVALID');const d=Object.getOwnPropertyDescriptor(o,k);need(!d||d.enumerable&&Object.hasOwn(d,'value'),'ACCESSOR_REFUSED');return d?.value;}
function encodedField(encoded,key){return encoded[1].find(row=>row[0]===key)?.[1];}
const fields=encoded=>encoded?.[0]==='object'?encoded[1].map(([key,value])=>({keyDigest:digest(key),valueDigest:hashEncoded(value)})):[];
function project(modId,record,baselineOrder){
 const encoded=encode(record,true),recordDigest=hashEncoded(encoded),rulesValue=encodedField(encoded,'rules'),attributes=encodedField(encoded,'attributes');
 const rules={present:rulesValue!==undefined,type:rulesValue===undefined?'absent':rulesValue[0]};let baselineRuleOrder=baselineOrder?{matched:false}:undefined;
 if(rulesValue?.[0]==='array'){
  const count=rulesValue[1].length;need(count<=4096,'RULE_LIMIT');const byIndex=new Map(rulesValue[1]);
  const ordered=Array.from({length:count},(_,i)=>byIndex.get(String(i))),orderedElementDigests=ordered.map(hashEncoded),sorted=ordered.map((value,i)=>({value,sha:orderedElementDigests[i]})).sort((a,b)=>a.sha<b.sha?-1:a.sha>b.sha?1:0);
  const sortedArray=['array',sorted.map((row,i)=>[String(i),row.value]).sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:0)];
  const invariant=['object',encoded[1].map(([key,value])=>[key,key==='rules'?sortedArray:value])];
  Object.assign(rules,{count,orderedElementDigests,multisetDigest:digest(orderedElementDigests.slice().sort()),permutationInvariantRecordDigest:hashEncoded(invariant)});
  if(baselineOrder&&JSON.stringify(baselineOrder.slice().sort())===JSON.stringify(orderedElementDigests.slice().sort())){
   const buckets=new Map();ordered.forEach((value,i)=>{const sha=orderedElementDigests[i];if(!buckets.has(sha))buckets.set(sha,[]);buckets.get(sha).push(value);});
   const reordered=['array',baselineOrder.map((sha,i)=>[String(i),buckets.get(sha).shift()]).sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:0)];
   baselineRuleOrder={matched:true,recordDigest:hashEncoded(['object',encoded[1].map(([key,value])=>[key,key==='rules'?reordered:value])])};
  }
 }
 return{modId,recordDigest,topLevelFields:fields(encoded),attributeFields:fields(attributes),rules,...(baselineRuleOrder?{baselineRuleOrder}:{})};
}
function readModRecordFingerprints(api,selectors,args){
 const input=encode(args);need(input[0]==='object'&&['gameId,modIds,profileId','gameId,modIds,profileId,ruleOrderBaselines'].includes(input[1].map(r=>r[0]).join(',')),'ARGUMENT_SHAPE');
 const gameId=field(args,'gameId'),profileId=field(args,'profileId'),modIds=field(args,'modIds');
 need(id(gameId)&&id(profileId)&&Array.isArray(modIds)&&modIds.length>0&&modIds.length<=20&&modIds.every(id)&&new Set(modIds).size===modIds.length,'TARGETS_INVALID');
 need(typeof api?.getState==='function'&&typeof selectors?.activeGameId==='function'&&typeof selectors?.activeProfileId==='function','API_UNAVAILABLE');
 const baselines=field(args,'ruleOrderBaselines'),orders=new Map();if(baselines!==undefined){need(Array.isArray(baselines)&&baselines.length<=20,'BASELINES_INVALID');for(const row of baselines){need(row&&typeof row==='object'&&!Array.isArray(row),'BASELINE_SHAPE');need(Object.keys(row).sort().join(',')==='modId,ruleElementDigests','BASELINE_SHAPE');const modId=field(row,'modId'),digests=field(row,'ruleElementDigests');need(modIds.includes(modId)&&!orders.has(modId)&&Array.isArray(digests)&&digests.length<=4096&&digests.every(d=>typeof d==='string'&&/^[a-f0-9]{64}$/.test(d)),'BASELINE_INVALID');orders.set(modId,digests.slice());}}
 const targets=modIds.slice(),getState=api.getState,gameSelector=selectors.activeGameId,profileSelector=selectors.activeProfileId;
 function capture(){need(api.getState===getState&&selectors.activeGameId===gameSelector&&selectors.activeProfileId===profileSelector,'API_CHANGED');const state=getState.call(api);
  const persistent=field(state,'persistent'),profiles=field(persistent,'profiles'),profile=field(profiles,profileId),settings=field(state,'settings'),next=field(field(settings,'profiles'),'nextProfileId');
  need(gameSelector(state)===gameId&&profileSelector(state)===profileId&&field(profile,'gameId')===gameId&&next===profileId,'CONTEXT_CHANGED');
  const mods=field(field(persistent,'mods'),gameId),records=targets.map(modId=>{const record=field(mods,modId);need(field(record,'state')==='installed','TARGET_NOT_INSTALLED');return project(modId,record,orders.get(modId));});
  need(api.getState===getState&&selectors.activeGameId===gameSelector&&selectors.activeProfileId===profileSelector,'API_CHANGED');return{gameId,profileId,nextProfileId:next,records};
 }
 const first=capture(),second=capture();need(JSON.stringify(first)===JSON.stringify(second),'SNAPSHOT_CHANGED');
 return{schema:'mod-record-fingerprints/1',gameId,profileId,records:first.records,nativeEffects:false,compatibilityVerified:false};
}
module.exports={readModRecordFingerprints};
