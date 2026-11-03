'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const R=require('./receipts.cjs');
function parameters(action='install_now'){
 return {gameId:'cyberpunk2077',profileId:'profile-a',requestId:'wizard-request-a',gamePath:path.resolve('model-game'),stagingPath:path.resolve('model-stage'),downloadPath:path.resolve('model-downloads'),
  filesystemIds:{gamePath:'1:1',stagingPath:'1:2',downloadPath:'2:1'},modId:'collection-owner-a',archiveId:'archive-a',collectionId:123,revisionId:456,revisionNumber:7,action};
}
function attempt(action='install_now'){
 return {protocol:'vortex-agent/1',receiptVersion:2,requestId:'wizard-request-a',operation:'advance_collection_wizard',gameId:'cyberpunk2077',profileId:'profile-a',at:'2030-01-01T00:00:00.000Z',parameters:parameters(action)};
}
function completion(a){
 const p=a.parameters;return {protocol:a.protocol,receiptVersion:2,requestId:a.requestId,operation:a.operation,gameId:a.gameId,profileId:a.profileId,at:'2030-01-01T00:00:01.000Z',
  operationCompleted:true,diskDeploymentVerified:false,verificationRequired:R.VERIFICATION,modId:p.modId,archiveId:p.archiveId,collectionId:p.collectionId,revisionId:p.revisionId,revisionNumber:p.revisionNumber,action:p.action,
  transition:p.action==='install_now'?'started':'finished',nativeTransitionVerified:true};
}
for(const action of ['install_now','done'])test('v2 '+action+' attempt/completion remains exact and accepted',()=>{const a=attempt(action);assert.equal(R.validAttempt(a),true);assert.equal(R.validCompletion(completion(a),a),true);assert.equal(R.VERSION,2);});
for(const key of ['modId','archiveId','collectionId','revisionId','revisionNumber','action'])test('completion mismatched '+key+' refuses',()=>{const a=attempt(),c=completion(a);c[key]=typeof c[key]==='number'?c[key]+1:'other';assert.equal(R.validCompletion(c,a),false);});
for(const [name,mutate]of [
 ['transition',c=>c.transition='finished'],['native verification false',c=>c.nativeTransitionVerified=false],['missing native verification',c=>delete c.nativeTransitionVerified],
 ['disk verification invented',c=>c.diskDeploymentVerified=true],['operation incomplete',c=>c.operationCompleted=false],['verification wording',c=>c.verificationRequired='complete'],
 ['request',c=>c.requestId='wizard-request-b'],['profile',c=>c.profileId='profile-b'],['operation',c=>c.operation='deploy_mods'],['extra field',c=>c.callback=()=>{}],['backdated',c=>c.at='2029-01-01T00:00:00.000Z']
])test('completion refuses '+name,()=>{const a=attempt(),c=completion(a);mutate(c);assert.equal(R.validCompletion(c,a),false);});
for(const [name,mutate]of [
 ['other game',a=>a.gameId='skyrimse'],['missing owner',a=>delete a.modId],['empty archive',a=>a.archiveId=''],['zero collection',a=>a.collectionId=0],
 ['string revision',a=>a.revisionId='456'],['fractional revision number',a=>a.revisionNumber=1.5],['unsafe integer',a=>a.collectionId=Number.MAX_SAFE_INTEGER+1],['unknown action',a=>a.action='skip'],
 ['old modIds',a=>a.modIds=['m']],['old enabled',a=>a.enabled=true],['old archivePath',a=>a.archivePath=path.resolve('x.zip')],['callback',a=>a.callback=()=>{}]
])test('new parameters refuse '+name,()=>{const a=parameters();mutate(a);assert.equal(R.validParameters(a,'advance_collection_wizard'),false);});
for(const op of ['set_mods_enabled','deploy_mods','download_nexus','install_download','install_local_archive'])test(op+' refuses every new wizard field',()=>{
 const legacy={...parameters()};for(const k of ['modId','archiveId','collectionId','revisionId','revisionNumber','action'])delete legacy[k];
 if(op==='set_mods_enabled')Object.assign(legacy,{modIds:['m'],enabled:true});
 if(op==='install_download')Object.assign(legacy,{downloadId:'d',size:1,sha256:'a'.repeat(64)});
 if(op==='download_nexus')Object.assign(legacy,{nexusModId:1,nexusFileId:2,size:1,sha256:'a'.repeat(64)});
 if(op==='install_local_archive')Object.assign(legacy,{archivePath:path.resolve('own.zip'),size:1,sha256:'a'.repeat(64)});
 assert.equal(R.validParameters(legacy,op),true);
 for(const key of ['modId','archiveId','collectionId','revisionId','revisionNumber','action'])assert.equal(R.validParameters({...legacy,[key]:parameters()[key]},op),false,key);
});
test('unknown operation is not admitted by parameter or attempt validation',()=>{assert.equal(R.validParameters(parameters(),'arbitrary_dispatch'),false);const a=attempt();a.operation='arbitrary_dispatch';assert.equal(R.validAttempt(a),false);});
test('normal v2 wizard failure remains reconcilable',()=>{const a=attempt();const f={protocol:a.protocol,receiptVersion:2,requestId:a.requestId,operation:a.operation,gameId:a.gameId,profileId:a.profileId,at:'2030-01-01T00:00:01.000Z',operationCompleted:false,effectsMayHaveOccurred:true,inspectBeforeRetry:true,errorCode:'COLLECTION_WIZARD_TRANSITION_UNKNOWN'};assert.equal(R.validFailure(f,a),true);});
test('unavailable or incomplete internal controller refuses before native queries/effects',()=>{
 const {createOperations}=require('./guard.cjs');let reads=0;
 for(const wizard of [undefined,{}, {prepare(){}}]){
  const ops=createOperations({getState(){reads++;throw Error('MUST_NOT_READ_NATIVE');}}, {}, {}, {wizard});
  assert.throws(()=>ops.advance_collection_wizard(parameters()),/COLLECTION_WIZARD_CONTROLLER_UNAVAILABLE/);
 }
 assert.equal(reads,0);
});
