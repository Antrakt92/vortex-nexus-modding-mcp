import test from 'node:test';
import assert from 'node:assert/strict';
import {createReleaseFixture, releaseRequest} from './native-registration-release.test.mjs';
import {createRendererRegistrationReleaseFixture} from './native-renderer-registration-release.test.mjs';

const integration = (name, action) => test(name, {timeout:15000,
  skip: process.env.VORTEX_EXTENSION_ADMISSION_REPO && process.env.VORTEX_EXTENSION_ADMISSION_DEPS
    ? false : 'Set the official source cache and qualified dependencies'}, action);

function rendererFor(requests) {
  const archiveRows = Object.fromEntries(requests.map(({archive}) => [archive.id, {
    state:archive.state, game:[...archive.game], localPath:archive.localPath,
    size:archive.size, fileMD5:archive.fileMD5,
  }]));
  return createRendererRegistrationReleaseFixture({archiveRows});
}

integration('actual main results flow through two renderer adoption/release cycles on the same component instances', async t => {
  const requests = [releaseRequest(1), releaseRequest(2)];
  const main = await createReleaseFixture(t), renderer = rendererFor(requests);
  let sent = 0, firstRecord;
  const oldOwners = [];
  for (const [index, request] of requests.entries()) {
    const local = await renderer.owners(request.modId);
    const owner = await main.reserve(request.gameId, request.modId);
    const observed = await main.register(owner, request);
    renderer.adopt(local, JSON.stringify(observed));
    const state = renderer.store.getState();
    assert.equal(JSON.stringify(state.persistent.mods.game[request.modId]), observed.recordJSON);
    assert.equal(state.persistent.downloads.files[request.archive.id].installed.modId, request.modId);
    assert.deepEqual(state.persistent.profiles.p.modState ?? {}, {});
    if (index === 0) firstRecord = state.persistent.mods.game.new;
    else assert.equal(state.persistent.mods.game.new, firstRecord);
    renderer.store.dispatch({type:'SETTING', payload:{key:'pending'+index, value:index+1}});
    const ticket = renderer.prepare(local);
    renderer.check(ticket);
    assert.equal(renderer.manager.getNativeInstallExclusion().exclusiveHeld, true);
    const released = main.release(owner);
    assert.equal(released.released, true);
    for (const key of ['operationId','nativeJobId','requestSHA256','recordSHA256','fullRecordSHA256']) {
      assert.equal(released[key], observed[key]);
    }
    renderer.finalize(ticket);
    renderer.fire();
    assert.equal(renderer.sent.length, sent+1);
    for (const batch of renderer.sent.slice(sent)) {
      assert.equal(batch.hive, 'settings');
      await main.main.applyDiffOperationsAcknowledged(batch.hive, batch.operations);
    }
    sent = renderer.sent.length;
    assert.equal(main.committed.get('settings###pending'+index), JSON.stringify(index+1));
    assert.throws(() => main.release(owner));
    assert.throws(() => renderer.finalize(ticket));
    oldOwners.push(local);
  }
  assert.equal(main.committed.get('persistent###mods###game###new###archiveId'), '"archive"');
  assert.equal(main.committed.get('persistent###mods###game###new2###archiveId'), '"archive2"');
  assert.doesNotMatch(JSON.stringify(renderer.sent), /__nmtNativeRegistration|"installed"/);
  for (const owner of oldOwners) assert.throws(() => renderer.api.checkNativeRendererTarget(owner.root));
  assert.equal(renderer.manager.getNativeInstallExclusion().exclusiveHeld, false);
});

integration('discarded main release observation never implicitly opens renderer or its buffered writes', async t => {
  const request = releaseRequest(1), main = await createReleaseFixture(t), renderer = rendererFor([request]);
  const local = await renderer.owners(request.modId), owner = await main.reserve(request.gameId, request.modId);
  const observed = await main.register(owner, request);
  renderer.adopt(local, JSON.stringify(observed));
  renderer.store.dispatch({type:'SETTING', payload:{key:'held', value:true}});
  const ticket = renderer.prepare(local);
  main.release(owner); // Deliberately discard the local observation; no IPC is modeled here.
  renderer.fire();
  renderer.check(ticket);
  assert.equal(renderer.manager.getNativeInstallExclusion().exclusiveHeld, true);
  assert.equal(renderer.api.getNativeRendererTargetStatus().phase, 'committed_protected');
  assert.deepEqual(renderer.sent, []);
  assert.equal(main.committed.has('settings###held'), false);
  assert.throws(() => renderer.manager.reserveNativeInstallExclusion());
});
