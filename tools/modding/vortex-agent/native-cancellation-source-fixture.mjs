// Fixed test intake only. No candidate paths or caller-selected source stages.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {applyExact} from './native-patch-test-fixture.mjs';
import {completionSource} from './native-executor-completion-preload.test.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
const FIXED=Object.freeze({
  "native-manager-inert-release": {
    "packet": "vortex-2.9.1",
    "upstreamPath": "src/renderer/src/extensions/mod_management/InstallManager.ts",
    "inputSHA256": "38ceb37ac994f9da61e0a93b3be8e0e7618a9833b7e514e5aec710638653d667",
    "outputSHA256": "fa286ebca414fc3368de7ef7b50a71a7c5327768098c42f8aabda1a4e7d1bdad",
    "patchSHA256": "00c4050a245027f66b721c86f3491ef7e94aee03f1e36da4d2382e221294ebcd",
    "prerequisitePatch": "native-manager-registration-release.patch",
    "prerequisitePatchSHA256": "a89507c72cf8c8d74c2cc9f63692b27c206654b9d6e7ea610465e9275bdca16a"
  },
  "native-renderer-inert-flush-release": {
    "packet": "vortex-persistence-2.9.1",
    "upstreamPath": "src/renderer/src/store/persistDiffMiddleware.ts",
    "inputSHA256": "32639c4e836a0ceac7e75ab9b12a69cd73fb283f3a3937512d815b151abfad35",
    "outputSHA256": "7316a95aa075c758b52218c65998d576b217d57ab391aecd73e7466f55234bb9",
    "patchSHA256": "4a978aae276e0f5e31d6473fe955fb176ed493498561a0d0699dbc1abed9ada5",
    "prerequisitePatch": "renderer-persistence-release.patch",
    "prerequisitePatchSHA256": "a70d3918843f7c99130393a991df872f6e8dc94f90d195d512242bc30cb5c7c4"
  },
  "native-renderer-inert-target-release": {
    "packet": "vortex-persistence-2.9.1",
    "upstreamPath": "src/renderer/src/reducers/index.ts",
    "inputSHA256": "36290d8a0a158bfd87f2024461bcf6a711913841f5f94048f9b20e139a8fca69",
    "outputSHA256": "987a9529c672b683ec01c3e8fae9440a58c8a646943b67531a0d2bfc9e4cd3d7",
    "patchSHA256": "d3812f3a454f3b028683ca6c844a6dbf07130f8b55816f147852ca617a836d49",
    "prerequisitePatch": "renderer-registration-release.patch",
    "prerequisitePatchSHA256": "9627e58347f3c88c016fb1165163478899901a0cf17e5e5115f8da27cc47131b"
  },
  "native-renderer-executor-cancellation": {
    "packet": "vortex-persistence-2.9.1",
    "upstreamPath": "src/renderer/src/ExtensionManager.ts",
    "inputSHA256": "f981d5c086b1b786a37aca5d5c50ce06a214a34ec7d71c3fcdfa63bb6fa9fa4d",
    "outputSHA256": "e85b35a5fa63df53c93e349dd74441666f13e49c397847f2a8c8c94c3e4de910",
    "patchSHA256": "4a755dbbdec6d08fbd550a8ab4de9340e2340ff19fe92329a77bfedc007f614e",
    "prerequisitePatch": "native-renderer-executor-successor.patch",
    "prerequisitePatchSHA256": "828be1be6d39ef2488a4766fd258003b1f8075188aeea72a6af0d3b13c6fffc2"
  },
  "native-cancellation-ipc": {
    "packet": "vortex-persistence-2.9.1",
    "upstreamPath": "src/main/src/store/persistenceIPC.ts",
    "inputSHA256": "4d9ee91bf5995613ab96ce6b13ebf4fa850aa80ded57bdb904e75b653a4de5e6",
    "outputSHA256": "2121519b5b71ae2b2fec2ee970d2e3b9b988399fa22bf2254d3ce4fd2172ce0a",
    "patchSHA256": "b3cba7c50b5db5ca0f478a29e39f16217d147c9ba7b38a15edb666d3816e83ad",
    "prerequisitePatch": "native-executor-successor-ipc.patch",
    "prerequisitePatchSHA256": "5225b386045418f9b72a4b2b577a1a7cfec489877e139a290a79a8f8b18bcad4"
  },
  "native-cancellation-preload": {
    "packet": "vortex-persistence-2.9.1",
    "upstreamPath": "src/preload/src/index.ts",
    "inputSHA256": "34786958d20f60d2518ae9ba0a5c1008c95f0e9d04ee5dc8b54f92453ee8b6ef",
    "outputSHA256": "5b30d381bd254b9856be8286b56b32abf4c28a7d746b46636dd6b41ac2b45ab2",
    "patchSHA256": "fc657875cd29c835aa30dfe84d163b2ac7e1c026e4f44ac4325b13abee07636a",
    "prerequisitePatch": "native-executor-successor-preload.patch",
    "prerequisitePatchSHA256": "696ed1e4b953013ac29fe35ff2202d753b551e2b4e999dc41c48fe789749a6fd"
  },
  "native-cancellation-shared-ipc": {
    "packet": "vortex-persistence-2.9.1",
    "upstreamPath": "src/shared/src/types/ipc.ts",
    "inputSHA256": "178717922db74ac7d44abee629502a6255bdaed3ccef20d5ae8822cb835a9f5d",
    "outputSHA256": "65afe26807ab78bbf8a9921aacd3cc9ff798fd69178b2b76d4771d215761bf3e",
    "patchSHA256": "05e2bb65ac2a83f89d89815f0fce54a0d9f767efa1c58dd371a1d75ecb6a2358",
    "prerequisitePatch": "native-executor-successor-shared-ipc.patch",
    "prerequisitePatchSHA256": "dea8189b02f86f7990b623a7a7ced369b09ba027d96835f9d532d5a8a89cd6c0"
  },
  "native-cancellation-shared-preload": {
    "packet": "vortex-persistence-2.9.1",
    "upstreamPath": "src/shared/src/types/preload.ts",
    "inputSHA256": "626a073797f8ba7a6da5755fcc389b7cf0beba7455ed8604b0c9897d12a662fd",
    "outputSHA256": "b593053a10b6f447b460bf68ed6d2bba291f536e4ca6ae0c593b6b8933a1b108",
    "patchSHA256": "3a55708a5c76f2ef3131364cc7d1ae01b2d1c60d593190fde79aaac0f2d39db5",
    "prerequisitePatch": "native-executor-successor-shared-preload.patch",
    "prerequisitePatchSHA256": "42ed10bb9a5ab4395261d57db5596a70c1cadadb30fc423cde1a57af7cc84b59"
  }
});
function intake(name){
 assert(Object.hasOwn(FIXED,name),'fixed cancellation test stage');const e=FIXED[name];
 const folder=new URL('./native-patches/'+e.packet+'/',import.meta.url);
 const m=JSON.parse(fs.readFileSync(new URL(name+'.json',folder))),patch=fs.readFileSync(new URL(name+'.patch',folder),'utf8');
 for(const[k,v]of Object.entries(e))if(k!=='packet')assert.equal(m[k],v,name+':'+k);
 assert.equal(sha(patch),e.patchSHA256);
 const parent=JSON.parse(fs.readFileSync(new URL(e.prerequisitePatch.replace(/\.patch$/,'.json'),folder)));
 assert.equal(parent.patchSHA256,e.prerequisitePatchSHA256);assert.equal(parent.outputSHA256,e.inputSHA256);
 return{e,m,patch};
}
export function applyRendererCancellationStage(source,name){
 const{e,patch}=intake(name);assert.equal(sha(source),e.inputSHA256);
 const result=applyExact(source,patch,e.upstreamPath);assert.equal(sha(result),e.outputSHA256);return result;
}
export function cancellationSource(name){
 const{e}=intake(name);assert.notEqual(e.packet,'vortex-2.9.1');
 const result=completionSource(name);assert.equal(sha(result),e.outputSHA256);return result;
}
