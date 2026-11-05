'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),disk=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createOperations,context,commitCompletion}=require('./guard.cjs');
const receiptSchema=require('./receipts.cjs');
const {QUESTION_TEXT}=require('./collection-dialog-policy.cjs');
const TEXT="You're updating a mod that others depend upon and the update doesn't seem to be compatible (according to the dependency information). If you continue we have to disable these dependencies, otherwise you'll continually get warnings about it.";
function dialog(version=false) {return {id:'front',type:'question',title:version?'Existing mod':'Updating may break dependencies',defaultAction:undefined,
  content:{text:version?QUESTION_TEXT:TEXT,options:{wrap:true},checkboxes:[{id:'remember',value:false,text:'Remember my choice'}]},
  actions:version?['Cancel','Update all profiles','Update current profile']:['Cancel','Ignore']};}
async function fixture(t,{version=false,close,commit}={}) {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'native-dialog-control-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const paths={gamePath:path.join(dir,'game'),stagingPath:path.join(dir,'stage'),downloadPath:path.join(dir,'download')};
  for(const p of Object.values(paths))await fs.mkdir(p);
  const receipts=path.join(dir,'receipts');await fs.mkdir(receipts);
  const state={persistent:{profiles:{profile:{gameId:'game'}}},settings:{profiles:{nextProfileId:'profile'},gameMode:{discovered:{game:{path:paths.gamePath}}}},session:{notifications:{dialogs:[dialog(version)]}}};
  let source=true,clock=100;const calls=[],selectors={activeGameId:()=> 'game',activeProfileId:()=> 'profile',installPathForGame:()=>paths.stagingPath,downloadPathForGame:()=>paths.downloadPath};
  const api={getState:()=>state,closeDialog(id,label,input){calls.push({id,label,input,ordinaryLock:disk.existsSync(path.join(receipts,'mutation.lock'))});if(close)return close(state,receipts);state.session.notifications.dialogs=[];}};
  const baseOptions={receipts,stopped(){},nativeDialogOptions:{assertHost(){if(!source)throw Error('SOURCE_CHANGED');},
    ...(commit?{commitCompletion:commit}:{}),controllerOptions:{now:()=>clock,sleep:async ms=>{clock+=ms;},transitionTimeoutMs:10,pollMs:1}}};
  const fresh=(patch={})=>createOperations(api,{},selectors,{...baseOptions,...patch,nativeDialogOptions:{...baseOptions.nativeDialogOptions,...patch.nativeDialogOptions}}),ops=fresh();
  const common=context(api,selectors);return{dir,receipts,state,calls,ops,common,fresh,api,selectors,sourceChanged(){source=false;},read:()=>ops.read_native_dialog({gameId:'game',profileId:'profile'}),
    args:(r,action='cancel',requestId='request_0001')=>({...common,filesystemIds:{...common.filesystemIds},requestId,dialogId:r.dialogId,fingerprint:r.fingerprint,action}),
    record:(id,kind)=>fs.readFile(path.join(receipts,'native-dialog-control',`${id}.${kind}.json`),'utf8').then(JSON.parse)};
}
test('Cancel works despite both ordinary barriers and preserves their exact bytes',async t=>{
  const f=await fixture(t),r=await f.read();
  await fs.writeFile(path.join(f.receipts,'unresolved.json'),'held GLOBAL');await fs.writeFile(path.join(f.receipts,'mutation.lock'),'foreign lock');
  const result=await f.ops.respond_native_dialog(f.args(r));
  assert.equal(result.operation,'respond_native_dialog');assert.equal(result.operationCompleted,true);assert.equal(result.diskDeploymentVerified,false);
  assert.equal(result.installationCompleted,false);assert.equal(result.callbackOriginVerified,false);assert.equal(result.targetArchiveIdentityVerified,false);assert.equal(result.abortOnly,true);
  assert.deepEqual(f.calls,[{id:'front',label:'Cancel',input:{remember:false},ordinaryLock:true}]);
  assert.equal(await fs.readFile(path.join(f.receipts,'unresolved.json'),'utf8'),'held GLOBAL');assert.equal(await fs.readFile(path.join(f.receipts,'mutation.lock'),'utf8'),'foreign lock');
  const ledger=await f.ops.read_native_dialog_operation({requestId:'request_0001'});assert.equal(ledger.status,'complete');assert.equal(ledger.replayAllowed,false);
  await assert.rejects(f.ops.respond_native_dialog(f.args(r)),/REQUEST_REPLAY/);assert.equal(f.calls.length,1);
});
test('Ignore and update use ordinary mutex; retained unresolved or mutation lock cannot be bypassed',async t=>{
  for(const version of [false,true]) {
    const f=await fixture(t,{version}),r=await f.read(),action=version?'update_current_profile':'ignore_dependencies';
    await fs.writeFile(path.join(f.receipts,'unresolved.json'),'held');await assert.rejects(f.ops.respond_native_dialog(f.args(r,action)),/UNRESOLVED/);assert.equal(f.calls.length,0);
    await fs.unlink(path.join(f.receipts,'unresolved.json'));await fs.writeFile(path.join(f.receipts,'mutation.lock'),'held');
    await assert.rejects(f.ops.respond_native_dialog(f.args(r,action)),/ORDINARY_MUTATION_BUSY/);assert.equal(f.calls.length,0);
    await fs.unlink(path.join(f.receipts,'mutation.lock'));const result=await f.ops.respond_native_dialog(f.args(r,action));
    assert.equal(result.abortOnly,false);assert.equal(f.calls[0].ordinaryLock,true);assert.equal(disk.existsSync(path.join(f.receipts,'mutation.lock')),false);
    const attempt=JSON.parse(await fs.readFile(path.join(f.receipts,'request_0001.attempt.json'),'utf8'));
    const completion=JSON.parse(await fs.readFile(path.join(f.receipts,'request_0001.completion.json'),'utf8'));
    assert.equal(receiptSchema.validAttempt(attempt),true);assert.equal(receiptSchema.validCompletion(completion,attempt),true);
    for(const patch of [{remember:true},{abortOnly:true},{callbackOriginVerified:true},{targetArchiveIdentityVerified:true},
      {installationCompleted:true},{dialogDismissalOnly:false},{nativeDialogDismissalVerified:false},{action:'cancel'},
      {schema:'other/1'},{sessionId:'invented-origin'}]) assert.equal(receiptSchema.validCompletion({...completion,...patch},attempt),false);
    assert.equal(receiptSchema.validParameters({...attempt.parameters,action:'cancel'},'respond_native_dialog'),false);
    assert.equal(receiptSchema.validParameters({...attempt.parameters,fingerprint:'not-a-digest'},'respond_native_dialog'),false);
    assert.equal(disk.existsSync(path.join(f.receipts,'unresolved.json')),false);
  }
});
test('non-Cancel callback observes durably armed standard GLOBAL before invocation',async t=>{
  const f=await fixture(t,{close(state,receipts){
    const held=JSON.parse(disk.readFileSync(path.join(receipts,'unresolved.json'),'utf8'));
    assert.equal(receiptSchema.validAttempt(held),true);assert.equal(held.operation,'respond_native_dialog');assert.equal(held.parameters.action,'ignore_dependencies');
    state.session.notifications.dialogs=[];
  }}),r=await f.read();
  await f.ops.respond_native_dialog(f.args(r,'ignore_dependencies'));assert.equal(f.calls.length,1);
  assert.equal(disk.existsSync(path.join(f.receipts,'unresolved.json')),false);
});
test('uncertain non-Cancel keeps standard GLOBAL and blocks every ordinary mutation; Cancel preserves it',async t=>{
  const f=await fixture(t,{close(){}}),r=await f.read();
  await assert.rejects(f.ops.respond_native_dialog(f.args(r,'ignore_dependencies')),/EFFECT_UNCERTAIN/);
  const marker=await fs.readFile(path.join(f.receipts,'unresolved.json'),'utf8');
  const failure=JSON.parse(await fs.readFile(path.join(f.receipts,'request_0001.failed.json'),'utf8'));
  assert.equal(failure.effectsMayHaveOccurred,true);assert.equal(failure.inspectBeforeRetry,true);
  await assert.rejects(f.ops.set_mods_enabled({...f.common,requestId:'ordinary_0002',modIds:['uninstalled'],enabled:true}),/UNRESOLVED_OPERATION_INTERLOCK/);
  assert.equal(await fs.readFile(path.join(f.receipts,'unresolved.json'),'utf8'),marker);
  const next=dialog();next.id='another-front';f.state.session.notifications.dialogs=[next];const q=await f.read();
  await assert.rejects(f.ops.respond_native_dialog(f.args(q,'cancel','request_0003')),/EFFECT_UNCERTAIN/);
  assert.equal(f.calls.length,2);assert.equal(f.calls[1].label,'Cancel');
  assert.equal(await fs.readFile(path.join(f.receipts,'unresolved.json'),'utf8'),marker);
});
test('full filesystem and fresh source pins are required before a callback',async t=>{
  const f=await fixture(t),r=await f.read(),a=f.args(r);a.filesystemIds.gamePath='wrong';
  await assert.rejects(f.ops.respond_native_dialog(a),/FILESYSTEM_IDENTITY/);assert.equal(f.calls.length,0);
  f.sourceChanged();await assert.rejects(f.ops.respond_native_dialog(f.args(r)),/SOURCE_CHANGED/);assert.equal(f.calls.length,0);
});
test('uncertain dismissal leaves durable held and refuses same target through a new request id',async t=>{
  const f=await fixture(t,{close(){}}),r=await f.read();await assert.rejects(f.ops.respond_native_dialog(f.args(r)),/EFFECT_UNCERTAIN/);
  assert.equal((await f.record('request_0001','held')).effectsMayHaveOccurred,true);
  const q=await f.read();await assert.rejects(f.ops.respond_native_dialog(f.args(q,'cancel','request_0002')),/DIALOG_ALREADY_ATTEMPTED/);assert.equal(f.calls.length,1);
  const ledger=await f.ops.read_native_dialog_operation({requestId:'request_0001'});assert.equal(ledger.status,'held');assert.equal(ledger.globalInterlockChanged,false);
});
test('completion write failure after dismissal never claims a no-effect retry',async t=>{
  const f=await fixture(t,{commit:async(file,...args)=>{if(file.endsWith('.completion.json'))throw Error('DISK_FAILURE');return commitCompletion(file,...args);}}),r=await f.read();
  await assert.rejects(f.ops.respond_native_dialog(f.args(r)),/DISK_FAILURE/);assert.equal(f.calls.length,1);assert.equal((await f.record('request_0001','held')).effectsMayHaveOccurred,true);
  // Same request is never accepted even though the original dialog has gone.
  await assert.rejects(f.ops.respond_native_dialog(f.args(r)),/REQUEST_REPLAY/);
});
test('published completion survives cleanup errors without conflicting failure record',async t=>{
  const f=await fixture(t,{commit:async(file,value,verify,published)=>{await commitCompletion(file,value,verify,published);if(file.endsWith('.completion.json'))throw Error('CLEANUP_ERROR');}}),r=await f.read();
  await assert.rejects(f.ops.respond_native_dialog(f.args(r)),/COMPLETION_PUBLISHED_CLEANUP_PENDING/);
  const ledger=await f.ops.read_native_dialog_operation({requestId:'request_0001'});assert.equal(ledger.status,'complete');assert.equal(ledger.held,null);assert.equal(f.calls.length,1);
});
test('own control mutex excludes concurrent clients without modifying foreign locks',async t=>{
  const f=await fixture(t),r=await f.read(),dir=path.join(f.receipts,'native-dialog-control');await fs.mkdir(dir);await fs.writeFile(path.join(dir,'mutation.lock'),'another control');
  await assert.rejects(f.ops.respond_native_dialog(f.args(r)),/CONTROL_BUSY/);assert.equal(f.calls.length,0);assert.equal(await fs.readFile(path.join(dir,'mutation.lock'),'utf8'),'another control');
});
test('input accessors, extra action keys, traversal and corrupt ledger are refused',async t=>{
  const f=await fixture(t),r=await f.read();let accessed=0;const a=f.args(r);Object.defineProperty(a,'action',{enumerable:true,get(){accessed++;return 'cancel';}});
  await assert.rejects(f.ops.respond_native_dialog(a),/ACCESSOR/);assert.equal(accessed,0);
  await assert.rejects(f.ops.respond_native_dialog({...f.args(r),sourceApproved:true}),/KEYS/);
  await assert.rejects(f.ops.read_native_dialog_operation({requestId:'../escape'}),/REQUEST_ID/);
  assert.equal((await f.ops.read_native_dialog_operation({requestId:'unseen_0001'})).status,'absent');
  const dir=path.join(f.receipts,'native-dialog-control');await fs.mkdir(dir);await fs.writeFile(path.join(dir,'request_0001.attempt.json'),'{}');
  await assert.rejects(f.ops.read_native_dialog_operation({requestId:'request_0001'}),/LEDGER_INVALID/);assert.equal(f.calls.length,0);
});


test('two independent request guards share observation but only response guard owns checks, commits and GLOBAL effect',async t=>{
 const f=await fixture(t,{close(state,receipts){assert(disk.existsSync(path.join(receipts,'unresolved.json')));assert(disk.existsSync(path.join(receipts,'mutation.lock')));state.session.notifications.dialogs=[];}});
 let oldAllowed=true,oldChecks=0,newChecks=0,oldCommits=0,newCommits=0;
 const reader=f.fresh({stopped(){oldChecks++;assert(oldAllowed,'STALE_GUARD_USED');},nativeDialogOptions:{assertHost(){assert(oldAllowed,'STALE_SOURCE_USED');},commitCompletion:async(...args)=>{oldCommits++;return commitCompletion(...args);}}});
 const r=await reader.read_native_dialog({gameId:'game',profileId:'profile'});oldAllowed=false;
 const writer=f.fresh({credentials:['rotated-non-overlap-secret'],stopped(){newChecks++;},nativeDialogOptions:{assertHost(){newChecks++;},commitCompletion:async(...args)=>{newCommits++;return commitCompletion(...args);}}});
 const result=await writer.respond_native_dialog(f.args(r,'ignore_dependencies'));
 assert.equal(result.nativeDialogDismissalVerified,true);assert.equal(oldChecks,0);assert.equal(oldCommits,0);assert(newChecks>2);assert.equal(newCommits,2);assert.equal(f.calls.length,1);
 assert.equal(disk.existsSync(path.join(f.receipts,'unresolved.json')),false);assert.equal((await reader.read_native_dialog_operation({requestId:'request_0001'})).status,'complete');
 const third=f.fresh();await assert.rejects(third.respond_native_dialog(f.args(r,'ignore_dependencies')),/REQUEST_REPLAY/);assert.equal(f.calls.length,1);
});
test('credential rotation in the response guard is not bypassed by a retained read controller',async t=>{
 const f=await fixture(t),r=await f.fresh().read_native_dialog({gameId:'game',profileId:'profile'});
 const rotated=f.fresh({credentials:['ignore_dependencies']});await assert.rejects(rotated.respond_native_dialog(f.args(r,'ignore_dependencies')),/OPERATIONAL_SECRET_OVERLAP/);assert.equal(f.calls.length,0);
 const current=f.fresh({credentials:['new-secret']});const q=await current.read_native_dialog({gameId:'game',profileId:'profile'});await current.respond_native_dialog(f.args(q,'ignore_dependencies','request_0002'));assert.equal(f.calls.length,1);
});
test('concurrent request reads cannot overwrite current source hooks and response cannot cross a pending read',async t=>{
 const f=await fixture(t);let firstChecks=0,secondChecks=0;
 const first=f.fresh({nativeDialogOptions:{assertHost(){firstChecks++;}}}),second=f.fresh({nativeDialogOptions:{assertHost(){secondChecks++;}}});
 // controller.read really yields at await assertRead; the core must retain its
 // source hooks until that actual asynchronous read has finished.
 const pending=first.read_native_dialog({gameId:'game',profileId:'profile'});
 await assert.rejects(second.read_native_dialog({gameId:'game',profileId:'profile'}),/SESSION_BUSY/);await pending;
 assert.equal(firstChecks,2);assert.equal(secondChecks,0);
 const r=await f.read(),closing=f.fresh().respond_native_dialog(f.args(r));
 await assert.rejects(f.fresh().read_native_dialog({gameId:'game',profileId:'profile'}),/SESSION_BUSY/);await closing;assert.equal(f.calls.length,1);
});
