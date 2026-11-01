import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {repo} from './native-query-source-admission.test.mjs';
import {createTerminalFixture, releaseRequest} from './native-executor-terminal-window.test.mjs';
import {createNativeExecutorJournal} from './native-executor-journal.mjs';
import job from './install-job-contract.cjs';
import dispatch from './native-dispatch-contract.cjs';

const encode = value => Buffer.from(JSON.stringify(value));
const sha = value => createHash('sha256').update(value).digest('hex');
const anchor = census => encode({schema:'native-executor-anchor/1',rootId:census.observedRootId,
  inventorySHA256:census.observedInventorySHA256});

// Actual journal and composed Main/Level/SQL-owner source. The transactional
// database, renderer adoption and physical worker observations are controlled
// fixtures; this does not authenticate a real renderer or worker completion.
test('actual terminal journal and source window keep pending anchor held until successor CAS and release', {
  skip:repo?false:'Set VORTEX_EXTENSION_ADMISSION_REPO',timeout:15000,
}, async t => {
  const gameId='cyberpunk2077', archive={...releaseRequest(1).archive,game:[gameId],localPath:'new.zip'};
  const f=await createTerminalFixture(t,{downloads:[archive]});
  const plan={schema:'install-job-plan/1',family:'tracked-new-disabled',contractId:job.CONTRACT_ID,
    context:{gameId,profileId:'fixture',gamePath:'F:/Fixture/Game',stagingPath:'F:/Fixture/Stage',downloadPath:'D:/Fixture/Downloads',
      filesystemIds:{gamePath:'1:2',stagingPath:'1:3',downloadPath:'2:4'}},
    package:{downloadId:archive.id,fileName:archive.localPath,expectedModId:'new',expectedType:'',bytes:archive.size,
      sha256:archive.archiveSHA256,md5:archive.fileMD5,expectedUncompressedBytes:10,payload:{'r6/scripts/own.reds':'a'.repeat(64)}},
    evidence:{buildSHA256:'a'.repeat(64),sourceSHA256:'a'.repeat(64),nativeAdmissionSHA256:'a'.repeat(64)},
    options:{enabled:false,deploy:false}};
  const request={schema:'native-dispatch-request/1',contractId:dispatch.CONTRACT_ID,
    operationId:'op_'+'1'.repeat(32),nativeJobId:'exec_'+'1'.repeat(32),planId:job.installPlanId(plan),
    managerScope:'manager-fixture-1',rendererGeneration:'renderer_'+'1'.repeat(32),admissionSHA256:'a'.repeat(64),plan};
  const requestSHA256=dispatch.dispatchRequestDigest(encode(request));
  const binding={operationId:request.operationId,nativeJobId:request.nativeJobId,requestSHA256,
    packetSHA256:'d'.repeat(64),workerLifetime:'worker_'+'1'.repeat(32)};
  const journal=createNativeExecutorJournal({root:path.join(f.root,'terminal-journal')});
  journal.begin(encode(request),binding.workerLifetime,binding.packetSHA256);
  const pending=journal.inventory(), before=anchor(pending);
  // Seed only the fixture database before source-owned reservation begins.
  f.committed.set('nativeExecutorAnchorV1',before.toString('utf8'));
  const registration=releaseRequest(1,{gameId,archive,operationId:request.operationId,nativeJobId:request.nativeJobId,
    requestSHA256,planId:request.planId});
  const modOwner=await f.reserve(gameId,'new'), observed=await f.register(modOwner,registration);
  const owner=f.main.beginNativeExecutorTerminalWindow(modOwner,request.operationId,request.nativeJobId,
    requestSHA256,observed.fullRecordSHA256);
  f.main.checkNativeExecutorTerminalWindow(owner);
  const retained=()=>{
    assert.equal(f.main.getNativeModPersistenceReservation().phase,'reserved');
    assert.equal(f.level.getNativeBackendWriteStatus().phase,'reserved');
    assert.equal(f.pool.getNativeSQLConnectionStatus().phase,'reserved');
  };
  retained();
  const evidence={schema:'native-executor-terminal-evidence/2',outcome:'committed_adopted_worker_closed',
    fullRecordSHA256:observed.fullRecordSHA256,registrationObservationSHA256:sha(encode(observed)),
    adoptionObservationSHA256:'3'.repeat(64),workerClosureObservationSHA256:'4'.repeat(64),
    ownershipHoldObservationSHA256:sha(encode({...binding,fullRecordSHA256:observed.fullRecordSHA256,writerOwnership:'retained'}))};
  const terminal=journal.appendTerminal(binding,encode(evidence));
  assert.equal(terminal.canReplay,false); assert.equal(terminal.independentCompletionVerified,false);
  retained(); assert.throws(()=>f.main.releaseNativeExecutorTerminalWindow(owner));
  const stale=journal.inventory({expectedRootId:pending.observedRootId,expectedInventorySHA256:pending.observedInventorySHA256});
  assert.equal(stale.historySealVerified,false);assert.equal(stale.startupHoldRequired,true);
  assert.equal(f.committed.get('nativeExecutorAnchorV1'),before.toString('utf8'));
  const closed=journal.inventory(), next=anchor(closed);
  const ack=await f.main.writeNativeExecutorTerminalAnchor(owner,before,next);
  assert.equal(ack.commitObserved,true);assert.equal(ack.anchorSHA256,sha(next));retained();
  assert.throws(()=>f.main.releaseNativeExecutorTerminalWindow(owner));
  assert.deepEqual(Buffer.from(await f.main.readNativeExecutorTerminalAnchor(owner)),next);
  const receipt=f.main.releaseNativeExecutorTerminalWindow(owner);
  assert.equal(receipt.released,true);assert.equal(receipt.fullRecordSHA256,observed.fullRecordSHA256);
  assert.equal(f.main.getNativeModPersistenceReservation().phase,'not_reserved');
  assert.equal(f.pool.getNativeSQLConnectionStatus().phase,'not_reserved');
  const persisted=JSON.parse(f.committed.get('nativeExecutorAnchorV1'));
  const anchored=journal.inventory({expectedRootId:persisted.rootId,expectedInventorySHA256:persisted.inventorySHA256});
  assert.equal(anchored.historySealVerified,true);assert.equal(anchored.startupHoldRequired,false);
  assert.equal(anchored.closedCount,1);assert.equal(anchored.canReplay,false);
});
