// Actual source-backed Renderer/store/manager fixture. No actor on import.
// Only preload/Main delivery is controlled here; no host or worker is started.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const once = (text, before, after) => {
  assert.equal(text.split(before).length, 2, before);
  return text.replace(before, after);
};
let loaded;
async function helper() {
  if (loaded) return loaded;
  const url = new URL('./native-renderer-executor-completion.test.mjs', import.meta.url);
  const packet = new URL('./native-patches/vortex-persistence-2.9.1/', import.meta.url);
  const parent = JSON.parse(fs.readFileSync(new URL('native-renderer-executor-completion.json', packet)));
  const metadata = JSON.parse(fs.readFileSync(new URL('native-renderer-executor-successor.json', packet)));
  const patch = fs.readFileSync(new URL('native-renderer-executor-successor.patch', packet), 'utf8');
  assert.equal(metadata.upstreamPath, 'src/renderer/src/ExtensionManager.ts');
  assert.equal(metadata.inputSHA256, parent.outputSHA256);
  assert.equal(metadata.prerequisitePatch, 'native-renderer-executor-completion.patch');
  assert.equal(metadata.prerequisitePatchSHA256, parent.patchSHA256);
  assert.equal(sha(patch), metadata.patchSHA256);
  let text = fs.readFileSync(url, 'utf8');
  const loop = "for(const name of['native-renderer-executor-transport','native-renderer-executor-continuation','native-renderer-executor-completion']){const next=stage(name);assert.equal(sha(source),next.m.inputSHA256);source=applyExact(source,next.patch,next.m.upstreamPath);assert.equal(sha(source),next.m.outputSHA256);}";
  const successorLoop = "for(const name of['native-renderer-executor-transport','native-renderer-executor-continuation','native-renderer-executor-completion','native-renderer-executor-successor']){const next=stage(name);assert.equal(sha(next.patch),next.m.patchSHA256);assert.equal(sha(source),next.m.inputSHA256);source=applyExact(source,next.patch,next.m.upstreamPath);assert.equal(sha(source),next.m.outputSHA256);}";
  text = once(text, loop, successorLoop);
  text = once(text, "'/Native|nativeTransport|nativeExecutor|nativeManagerExport|mNative|getApi|getExtensionInitFunc/'",
    "'/Native|nativeSuccessor|nativeTransport|nativeExecutor|nativeManagerExport|mNative|getApi|getExtensionInitFunc/'");
  text = once(text, 'const prepareGate=deferred(),executeGate=deferred();',
    'const prepareGate=deferred(),executeGate=deferred(),successorGate=deferred(),successorCalls=[];');
  text = once(text, ' const window={api:{persist}},module=await helpers(),',
    ' persist.handoffNativeExecutorSuccessor=(transportId,executionId)=>{successorCalls.push({transportId,executionId});return options.handoffInvoke?options.handoffInvoke(transportId,executionId):successorGate.promise;};\n const window={api:{persist}},module=await helpers(),');
  text = once(text, 'prepareGate,executeGate,invalidations,executed,prepareCalls,challenge,',
    'prepareGate,executeGate,successorGate,successorCalls,invalidations,executed,prepareCalls,challenge,');
  text = text.replace(/(from\s*['"])(\.\/[^'"]+)(['"])/g, (_all, before, relative, after) => before + new URL(relative, url).href + after)
    .replaceAll("'import.meta.url'", "'__RENDERER_SUCCESSOR_META_LITERAL__'")
    .replaceAll('import.meta.url', JSON.stringify(url.href))
    .replaceAll('__RENDERER_SUCCESSOR_META_LITERAL__', 'import.meta.url');
  loaded = import('data:text/javascript;base64,' + Buffer.from(text).toString('base64'));
  return loaded;
}

export async function createRendererSuccessorFixture(options = {}) {
  const f = await (await helper()).createRendererCompletionFixture(options);
  return {
    ...f,
    async complete() {
      await f.prepared();
      const pending = f.ext.executeNativeExecutor();
      for (const n of [1, 2, 3, 4, 5, 6, 7]) assert.notEqual((await f.receive(f.challenge(n))).state, 'failed');
      f.executeGate.resolve(f.result());
      return pending;
    },
    successorACK() {
      const binding = f.binding();
      return {schema: 'native-executor-successor/1', transportId: f.transportId, executionId: f.executionId,
        operationId: binding.operationId, nativeJobId: binding.nativeJobId, requestSHA256: binding.requestSHA256,
        ready: true, effectsAllowed: false, installationPermit: false, nativeAdmission: false};
    },
  };
}
