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
const digest = v => crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
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
  for (const k of ['gameId','profileId','dialogId']) need(typeof a[k]==='string' && a[k].length>0 && a[k].length<=512 && !/[\x00-\x1f\x7f]/.test(a[k]), 'IDENTITY_INVALID');
  need(typeof a.fingerprint==='string' && /^[a-f0-9]{64}$/.test(a.fingerprint), 'FINGERPRINT_INVALID');
  need(['cancel','ignore_dependencies','update_current_profile'].includes(a.action), 'ACTION_INVALID');
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
  let handle;
  try {
    const before=await fs.lstat(file,{bigint:true});
    need(before.isFile()&&!before.isSymbolicLink()&&before.size<=65536n, 'LEDGER_INVALID');
    handle=await fs.open(file,'r'); const actual=await handle.stat({bigint:true});
    need(actual.dev===before.dev&&actual.ino===before.ino&&actual.size===before.size,'LEDGER_CHANGED');
    const bytes=Buffer.alloc(65537),{bytesRead}=await handle.read(bytes,0,bytes.length,0);
    need(bytesRead<=65536,'LEDGER_INVALID');
    const result=JSON.parse(bytes.subarray(0,bytesRead).toString('utf8'));
    need(result?.schema===SCHEMA&&result.operation===OP&&requestId(result.requestId)&&/^[a-f0-9]{64}$/.test(result.parametersDigest)&&/^[a-f0-9]{64}$/.test(result.dialogKey), 'LEDGER_INVALID');
    return result;
  } catch(e) { if(e.code==='ENOENT') return null; throw e; }
  finally { if(handle) await handle.close(); }
}
function createNativeDialogOperations(api, selectors, {receipts,checkContext,ordinaryMutation,commitCompletion,
  assertHost=createNativeDialogHostAdmission(api),controllerOptions={}}) {
  const control=path.join(receipts,'native-dialog-control'); let controller, operation;
  function readContext(a) {
    const state=api.getState();
    need(selectors.activeGameId(state)===a.gameId&&selectors.activeProfileId(state)===a.profileId
      &&state.persistent?.profiles?.[a.profileId]?.gameId===a.gameId&&state.settings?.profiles?.nextProfileId===a.profileId,'CONTEXT_CHANGED');
    assertHost();
  }
  async function noUnresolved() {
    try { await fs.lstat(path.join(receipts,'unresolved.json')); throw Error('UNRESOLVED_OPERATION_INTERLOCK'); }
    catch(e) { if(e.code!=='ENOENT') throw e; }
  }
  const getController=()=>controller ||= createNativeDialogController(api,{...controllerOptions,selectors,assertRead:readContext,
    async assertRespond(a,full,scope) {
      need(operation&&operation.args===full&&a.dialogId===full.dialogId&&a.fingerprint===full.fingerprint
        &&a.action===full.action&&scope.abortOnly===(a.action==='cancel'),'OPERATION_OWNERSHIP_REQUIRED');
      checkContext(full); readContext(a);
      if(!scope.abortOnly) { need(operation.ordinary,'ORDINARY_MUTEX_REQUIRED'); await noUnresolved(); }
    },
    performResponse(invoke,eligible,full,scope) {
      need(operation&&operation.args===full&&scope.abortOnly===(full.action==='cancel'),'OPERATION_OWNERSHIP_REQUIRED');
      const current=()=>{readContext(full);eligible();};
      if(scope.abortOnly) { checkContext(full);current();return invoke(); }
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
      &&record.parametersDigest===attempt.parametersDigest&&record.dialogKey===attempt.dialogKey,'LEDGER_JOIN_INVALID');
    need(!completion||completion.response?.requestId===id&&completion.response.operation===OP
      &&completion.response.operationCompleted===true&&completion.response.nativeDialogDismissalVerified===true,'LEDGER_COMPLETION_INVALID');
    need(!held||held.operationCompleted===false&&typeof held.effectsMayHaveOccurred==='boolean'&&held.inspectBeforeRetry===true,'LEDGER_HELD_INVALID');
    need(!(held&&completion),'LEDGER_CONFLICTING_TERMINALS');
    return {status:completion?'complete':held?'held':attempt?'pending':'absent',attempt,completion,held};
  }
  async function noPriorDialog(key) {
    const entries=await fs.readdir(control); need(entries.length<=4096,'LEDGER_LIMIT');
    for(const name of entries) if(name.endsWith('.attempt.json')) {
      const prior=await readRecord(path.join(control,name)); need(prior,'LEDGER_CHANGED');
      if(prior.dialogKey===key) { const result=await inspect(prior.requestId); need(result.held?.effectsMayHaveOccurred===false,'DIALOG_ALREADY_ATTEMPTED'); }
    }
  }
  async function inControl(fn) {
    plainParents(control); await fs.mkdir(control,{recursive:true}); plainParents(control);
    const lock=path.join(control,'mutation.lock'); let handle;
    try { handle=await fs.open(lock,'wx'); } catch(e) { if(e.code==='EEXIST') throw Error('NATIVE_DIALOG_CONTROL_BUSY'); throw e; }
    const owned=await handle.stat({bigint:true}); let failed=false;
    try { await handle.writeFile(JSON.stringify({pid:process.pid,controlOnly:true})); await handle.sync(); return await fn(); }
    catch(e) { failed=true; throw e; }
    finally {
      try { const now=await fs.lstat(lock,{bigint:true}); need(!now.isSymbolicLink()&&now.dev===owned.dev&&now.ino===owned.ino,'CONTROL_MUTEX_CHANGED'); await fs.unlink(lock); }
      catch(e) { if(!failed) { failed=true; throw e; } }
      finally { try { await handle.close(); } catch(e) { if(!failed) throw e; } }
    }
  }
  return {
    read_native_dialog: args=>getController().read(args),
    async respond_native_dialog(args) {
      const a=parameters(args);
      return inControl(async()=>{
        need((await inspect(a.requestId)).status==='absent','REQUEST_REPLAY_REFUSED');
        checkContext(a); readContext(a);
        const dialogKey=digest([a.gameId,a.profileId,a.dialogId,a.fingerprint]); await noPriorDialog(dialogKey);
        async function invoke(ordinary) {
          if(ordinary) await noUnresolved();
          const base={schema:SCHEMA,operation:OP,requestId:a.requestId,parametersDigest:digest(a),dialogKey,
            gameId:a.gameId,profileId:a.profileId,action:a.action,dialogId:a.dialogId,fingerprint:a.fingerprint};
          await commitCompletion(file(a.requestId,'attempt'),{...base,at:new Date().toISOString(),noReplay:true});
          let returned=false,published=false;
          try {
            const respond=async (effect,beforeCompletion)=>{
              operation={args:a,ordinary,effect};
              const result=await getController().respond(Object.fromEntries(['gameId','profileId','dialogId','fingerprint','action'].map(k=>[k,a[k]])),a);
              returned=true;beforeCompletion?.(()=>readContext(a));return {...result,gameId:a.gameId,profileId:a.profileId};
            };
            const result=ordinary?await ordinaryMutation(a,respond):await respond();
            const response={protocol:PROTOCOL,requestId:a.requestId,operation:OP,status:'complete',operationCompleted:true,
              diskDeploymentVerified:false,verificationRequired:VERIFICATION,...result};
            await commitCompletion(file(a.requestId,'completion'),{...base,at:new Date().toISOString(),response},()=>{checkContext(a);readContext(a);},()=>{published=true;});
            return response;
          } catch(error) {
            // A linked completion remains authoritative even if temporary-name cleanup fails.
            if(published) throw Error('NATIVE_DIALOG_COMPLETION_PUBLISHED_CLEANUP_PENDING');
            await commitCompletion(file(a.requestId,'held'),{...base,at:new Date().toISOString(),operationCompleted:false,
              effectsMayHaveOccurred:returned||error.message==='NATIVE_DIALOG_EFFECT_UNCERTAIN_RECONCILE',inspectBeforeRetry:true,
              errorCode:/^[A-Z][A-Z0-9_]+$/.test(error?.message||'')?error.message:'UPSTREAM_FAILURE'});
            throw error;
          } finally { operation=null; }
        }
        // Cancel has an independent control-plane lock. It never clears an install
        // barrier or obtains permission to install. Other actions use the ordinary guard.
        if(a.action==='cancel') return invoke(false);
        await noUnresolved();
        try { await fs.lstat(path.join(receipts,'mutation.lock')); throw Error('NATIVE_DIALOG_ORDINARY_MUTATION_BUSY'); }
        catch(e) { if(e.code!=='ENOENT') throw e; }
        need(typeof ordinaryMutation==='function','ORDINARY_GUARD_REQUIRED');
        return invoke(true);
      });
    },
    async read_native_dialog_operation(args) {
      const {requestId:id}=object(args,['requestId']); need(requestId(id),'REQUEST_ID_INVALID'); plainParents(control);
      return {protocol:PROTOCOL,operation:OP,requestId:id,...await inspect(id),replayAllowed:false,
        globalInterlockChanged:false,installationCompleted:false};
    },
  };
}
module.exports = {createNativeDialogOperations};
