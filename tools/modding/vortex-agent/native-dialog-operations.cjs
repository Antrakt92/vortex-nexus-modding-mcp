'use strict';
const fs = require('node:fs/promises');
const disk = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {isProxy} = require('node:util/types');
const {VERIFICATION} = require('./receipts.cjs');
const {createNativeDialogController} = require('./native-dialog-controller.cjs');
const {createNativeDialogHostAdmission} = require('./native-dialog-host-admission.cjs');
const OP = 'respond_native_dialog', PROTOCOL = 'vortex-agent/1', SCHEMA = 'native-dialog-control-ledger/1';
const need = (v,c) => { if (!v) throw Error('NATIVE_DIALOG_' + c); };
const requestId = v => typeof v === 'string' && /^[A-Za-z0-9_-]{8,80}$/.test(v);
const identity = v => typeof v === 'string' && v.length>0 && v.length<=512 && !/[\x00-\x1f\x7f]/.test(v);
const sha256 = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const actions = ['cancel','ignore_dependencies','update_current_profile'];
const digest = v => crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
const dialogKeyFor = a => digest([a.gameId,a.profileId,a.dialogId,a.fingerprint]);
function object(value, keys) {
  need(value && typeof value === 'object' && !Array.isArray(value) && !isProxy(value), 'ARGUMENT_INVALID');
  need([Object.prototype,null].includes(Object.getPrototypeOf(value)), 'ARGUMENT_INVALID');
  need(Reflect.ownKeys(value).every(k=>typeof k==='string') && Object.keys(value).sort().join(',') === [...keys].sort().join(','), 'ARGUMENT_KEYS_INVALID');
  return Object.fromEntries(keys.map(k=>{ const d=Object.getOwnPropertyDescriptor(value,k); need(d?.enumerable && Object.hasOwn(d,'value'), 'ARGUMENT_ACCESSOR_REFUSED'); return [k,d.value]; }));
}
function parameters(value) {
  const a=object(value,['gameId','profileId','gamePath','stagingPath','downloadPath','filesystemIds','requestId','dialogId','fingerprint','action']);
  a.filesystemIds=object(a.filesystemIds,['gamePath','stagingPath','downloadPath']);
  need(requestId(a.requestId), 'REQUEST_ID_INVALID');
  for (const k of ['gameId','profileId','dialogId']) need(identity(a[k]), 'IDENTITY_INVALID');
  need(sha256(a.fingerprint), 'FINGERPRINT_INVALID');
  need(actions.includes(a.action), 'ACTION_INVALID');
  for (const k of ['gamePath','stagingPath','downloadPath']) need(typeof a[k]==='string' && path.isAbsolute(a[k]) && typeof a.filesystemIds[k]==='string' && a.filesystemIds[k].length>0, 'PATH_CONTEXT_REQUIRED');
  return a;
}
function plainParents(dir) {
  for (;;) {
    try { const s=disk.lstatSync(dir); need(s.isDirectory()&&!s.isSymbolicLink(), 'LEDGER_PATH_NOT_PLAIN'); }
    catch(e) { if(e.code!=='ENOENT') throw e; }
    const next=path.dirname(dir); if(next===dir) break; dir=next;
  }
}
async function readRecord(file) {
  const generation = s => `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}:${s.nlink}`;
  let before, handle;
  try {
    before=await fs.lstat(file,{bigint:true});
    need(before.isFile()&&!before.isSymbolicLink()&&before.size<=65536n, 'LEDGER_INVALID');
    const pin=generation(before);
    handle=await fs.open(file,'r');
    need(generation(await handle.stat({bigint:true}))===pin,'LEDGER_CHANGED');
    const bytes=Buffer.alloc(Number(before.size));
    for(let offset=0;offset<bytes.length;){
      const {bytesRead}=await handle.read(bytes,offset,bytes.length-offset,offset);
      need(bytesRead>0,'LEDGER_CHANGED');offset+=bytesRead;
    }
    need(generation(await handle.stat({bigint:true}))===pin
      &&generation(await fs.lstat(file,{bigint:true}))===pin,'LEDGER_CHANGED');
    let result;
    try { result=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)); }
    catch { throw Error('NATIVE_DIALOG_LEDGER_INVALID'); }
    need(result?.schema===SCHEMA&&result.operation===OP&&requestId(result.requestId)&&sha256(result.parametersDigest)
      &&identity(result.gameId)&&identity(result.profileId)&&identity(result.dialogId)&&sha256(result.fingerprint)
      &&actions.includes(result.action)&&result.dialogKey===dialogKeyFor(result),'LEDGER_INVALID');
    return result;
  } catch(e) { if(e.code==='ENOENT'){need(!before,'LEDGER_CHANGED');return null;} throw e; }
  finally { if(handle) await handle.close(); }
}
function createNativeDialogSession(api, selectors, {receipts,controllerOptions={}}) {
  const control=path.join(receipts,'native-dialog-control'); let controller, operation, readHooks, sessionBusy=false;
  async function inSession(fn){need(!sessionBusy,'SESSION_BUSY');sessionBusy=true;try{return await fn();}finally{sessionBusy=false;}}
  function readContext(a,hooks=operation?.hooks||readHooks) {
    need(typeof hooks?.assertHost==='function','CURRENT_GUARD_REQUIRED');
    const state=api.getState();
    need(selectors.activeGameId(state)===a.gameId&&selectors.activeProfileId(state)===a.profileId
      &&state.persistent?.profiles?.[a.profileId]?.gameId===a.gameId&&state.settings?.profiles?.nextProfileId===a.profileId,'CONTEXT_CHANGED');
    hooks.assertHost();
  }
  async function noUnresolved() {
    try { await fs.lstat(path.join(receipts,'unresolved.json')); throw Error('UNRESOLVED_OPERATION_INTERLOCK'); }
    catch(e) { if(e.code!=='ENOENT') throw e; }
  }
  const getController=()=>controller ||= createNativeDialogController(api,{...controllerOptions,selectors,assertRead:readContext,
    async assertRespond(a,full,scope) {
      need(operation&&operation.args===full&&a.dialogId===full.dialogId&&a.fingerprint===full.fingerprint
        &&a.action===full.action&&scope.abortOnly===(a.action==='cancel'),'OPERATION_OWNERSHIP_REQUIRED');
      operation.hooks.checkContext(full); readContext(a);
      if(!scope.abortOnly) { need(operation.ordinary,'ORDINARY_MUTEX_REQUIRED'); await noUnresolved(); }
    },
    performResponse(invoke,eligible,full,scope) {
      need(operation&&operation.args===full&&scope.abortOnly===(full.action==='cancel'),'OPERATION_OWNERSHIP_REQUIRED');
      const current=()=>{readContext(full);eligible();};
      if(scope.abortOnly) { operation.hooks.checkContext(full);current();return invoke(); }
      need(operation.ordinary&&typeof operation.effect==='function','ORDINARY_EFFECT_REQUIRED');
      // The ordinary effect first fsyncs unresolved.json, then synchronously
      // rechecks context, source and the front before this fixed invocation.
      return operation.effect(invoke,current);
    }});
  const file=(id,kind)=>path.join(control,`${id}.${kind}.json`);
  async function inspect(id) {
    const attempt=await readRecord(file(id,'attempt')), completion=await readRecord(file(id,'completion')), held=await readRecord(file(id,'held'));
    need(!completion&&!held||attempt,'LEDGER_ATTEMPT_MISSING');
    for(const record of [attempt,completion,held].filter(Boolean)) need(record.requestId===id
      &&record.parametersDigest===attempt.parametersDigest&&record.dialogKey===attempt.dialogKey
      &&record.action===attempt.action,'LEDGER_JOIN_INVALID');
    need(!attempt||attempt.noReplay===true,'LEDGER_INVALID');
    const response=completion?.response;
    need(!completion||response?.requestId===id&&response.operation===OP&&response.protocol===PROTOCOL
      &&response.status==='complete'&&response.schema==='native-dialog-response/1'
      &&['dialogId','action','gameId','profileId'].every(k=>response[k]===attempt[k])
      &&response.operationCompleted===true&&response.nativeDialogDismissalVerified===true
      &&response.verificationRequired===VERIFICATION&&response.dialogDismissalOnly===true
      &&['remember','installationCompleted','diskDeploymentVerified','callbackOriginVerified','targetArchiveIdentityVerified'].every(k=>response[k]===false)
      &&response.abortOnly===(attempt.action==='cancel'),'LEDGER_COMPLETION_INVALID');
    need(!held||held.operationCompleted===false&&typeof held.effectsMayHaveOccurred==='boolean'&&held.inspectBeforeRetry===true,'LEDGER_HELD_INVALID');
    need(!(held&&completion),'LEDGER_CONFLICTING_TERMINALS');
    return {status:completion?'complete':held?'held':attempt?'pending':'absent',attempt,completion,held};
  }
  async function noPriorDialog(key) {
    const entries=await fs.readdir(control); need(entries.length<=4096,'LEDGER_LIMIT');
    for(const name of entries) if(name.endsWith('.attempt.json')) {
      const prior=await readRecord(path.join(control,name)); need(prior,'LEDGER_CHANGED');
      need(name===path.basename(file(prior.requestId,'attempt')),'LEDGER_JOIN_INVALID');
      if(prior.dialogKey===key) { const result=await inspect(prior.requestId); need(result.held?.effectsMayHaveOccurred===false,'DIALOG_ALREADY_ATTEMPTED'); }
    }
  }
  async function inControl(fn) {
    plainParents(control); await fs.mkdir(control,{recursive:true}); plainParents(control);
    const lock=path.join(control,'mutation.lock'); let handle;
    try { handle=await fs.open(lock,'wx'); } catch(e) { if(e.code==='EEXIST') throw Error('NATIVE_DIALOG_CONTROL_BUSY'); throw e; }
    let owned,failed=false;
    try {
      owned=await handle.stat({bigint:true});
      await handle.writeFile(JSON.stringify({pid:process.pid,controlOnly:true})); await handle.sync(); return await fn();
    }
    catch(e) { failed=true; throw e; }
    finally {
      try {
        if(owned) {
          const now=await fs.lstat(lock,{bigint:true});
          need(!now.isSymbolicLink()&&now.dev===owned.dev&&now.ino===owned.ino,'CONTROL_MUTEX_CHANGED');
          await fs.unlink(lock);
        }
      } catch(e) { if(!failed) { failed=true; throw e; } }
      finally { try { await handle.close(); } catch(e) { if(!failed) throw e; } }
    }
  }
  return {
    read_native_dialog(args,hooks) {
      return inSession(async()=>{need(!operation,'ACTION_PENDING');readHooks=hooks;try{return await getController().read(args);}finally{readHooks=null;}});
    },
    async respond_native_dialog(args,hooks) {
      const a=parameters(args);
      return inSession(()=>inControl(async()=>{
        need(!operation,'ACTION_PENDING');const owned={args:a,hooks,ordinary:false,effect:null};operation=owned;
        try {
        need((await inspect(a.requestId)).status==='absent','REQUEST_REPLAY_REFUSED');
        hooks.checkContext(a); readContext(a,hooks);
        const dialogKey=dialogKeyFor(a); await noPriorDialog(dialogKey);
        async function invoke(ordinary) {
          if(ordinary) await noUnresolved();
          const base={schema:SCHEMA,operation:OP,requestId:a.requestId,parametersDigest:digest(a),dialogKey,
            gameId:a.gameId,profileId:a.profileId,action:a.action,dialogId:a.dialogId,fingerprint:a.fingerprint};
          await hooks.commitCompletion(file(a.requestId,'attempt'),{...base,at:new Date().toISOString(),noReplay:true});
          let returned=false,published=false;
          try {
            const respond=async (effect,beforeCompletion)=>{
              need(operation===owned,'CURRENT_GUARD_CHANGED');operation.ordinary=ordinary;operation.effect=effect;
              const result=await getController().respond(Object.fromEntries(['gameId','profileId','dialogId','fingerprint','action'].map(k=>[k,a[k]])),a);
              returned=true;beforeCompletion?.(()=>readContext(a,hooks));return {...result,gameId:a.gameId,profileId:a.profileId};
            };
            const result=ordinary?await hooks.ordinaryMutation(a,respond):await respond();
            const response={protocol:PROTOCOL,requestId:a.requestId,operation:OP,status:'complete',operationCompleted:true,
              diskDeploymentVerified:false,verificationRequired:VERIFICATION,...result};
            await hooks.commitCompletion(file(a.requestId,'completion'),{...base,at:new Date().toISOString(),response},()=>{hooks.checkContext(a);readContext(a,hooks);},()=>{published=true;});
            return response;
          } catch(error) {
            // A linked completion remains authoritative even if temporary-name cleanup fails.
            if(published) throw Error('NATIVE_DIALOG_COMPLETION_PUBLISHED_CLEANUP_PENDING');
            const message=error?.message;
            await hooks.commitCompletion(file(a.requestId,'held'),{...base,at:new Date().toISOString(),operationCompleted:false,
              effectsMayHaveOccurred:returned||message==='NATIVE_DIALOG_EFFECT_UNCERTAIN_RECONCILE',inspectBeforeRetry:true,
              errorCode:typeof message==='string'&&/^[A-Z][A-Z0-9_]+$/.test(message)?message:'UPSTREAM_FAILURE'});
            throw error;
          }
        }
        // Cancel has an independent control-plane lock. It never clears an install
        // barrier or obtains permission to install. Other actions use the ordinary guard.
        if(a.action==='cancel') return await invoke(false);
        await noUnresolved();
        try { await fs.lstat(path.join(receipts,'mutation.lock')); throw Error('NATIVE_DIALOG_ORDINARY_MUTATION_BUSY'); }
        catch(e) { if(e.code!=='ENOENT') throw e; }
        need(typeof hooks.ordinaryMutation==='function','ORDINARY_GUARD_REQUIRED');
        return await invoke(true);
        } finally { if(operation===owned)operation=null; }
      }));
    },
    async read_native_dialog_operation(args) {
      const {requestId:id}=object(args,['requestId']); need(requestId(id),'REQUEST_ID_INVALID'); plainParents(control);
      const result=await inspect(id);
      const ordinaryResponseHeld=result.held?.effectsMayHaveOccurred===true&&result.attempt.action!=='cancel';
      return {protocol:PROTOCOL,operation:OP,requestId:id,...result,replayAllowed:false,
        globalInterlockChanged:false,installationCompleted:false,...(ordinaryResponseHeld?{
          instruction:'Use read_native_dialog_operation and reconcile_operation with the original requestId. The ordinary receipt may already verify dismissal while the control receipt is held. Reconcile before another response.'
        }:{})};
    },
  };
}
// One native API object is one renderer session. Retain the host source proof
// so later requests can detect drift in that renderer without rehashing it.
// Request-specific context, credentials and mutation guards remain separate.
const sessions=new WeakMap();
const hostAdmissions=new WeakMap();
function defaultHostAdmission(api) {
  if(!hostAdmissions.has(api)) hostAdmissions.set(api,createNativeDialogHostAdmission(api));
  return hostAdmissions.get(api);
}
function createNativeDialogOperations(api,selectors,options) {
  need(api&&typeof api==='object'&&options&&typeof options.receipts==='string','SESSION_REQUIRED');
  const hooks={checkContext:options.checkContext,ordinaryMutation:options.ordinaryMutation,commitCompletion:options.commitCompletion,
    assertHost:options.assertHost||defaultHostAdmission(api)};
  need(['checkContext','commitCompletion','assertHost'].every(k=>typeof hooks[k]==='function'),'CURRENT_GUARD_REQUIRED');
  let paths=sessions.get(api);if(!paths){paths=new Map();sessions.set(api,paths);}
  const resolved=path.resolve(options.receipts),key=process.platform==='win32'?resolved.toLowerCase():resolved;
  let entry=paths.get(key);if(!entry){entry={selectors,game:selectors.activeGameId,profile:selectors.activeProfileId,
    session:createNativeDialogSession(api,selectors,{receipts:resolved,controllerOptions:options.controllerOptions})};paths.set(key,entry);}
  need(entry.game===selectors.activeGameId&&entry.profile===selectors.activeProfileId,'SESSION_SELECTORS_CHANGED');
  return Object.freeze({read_native_dialog:args=>entry.session.read_native_dialog(args,hooks),
    respond_native_dialog:args=>entry.session.respond_native_dialog(args,hooks),
    read_native_dialog_operation:args=>entry.session.read_native_dialog_operation(args)});
}
module.exports = {createNativeDialogOperations};
