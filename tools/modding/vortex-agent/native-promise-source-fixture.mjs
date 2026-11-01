// Test intake only: fixed maintained source graph + already installed reviewed dependencies.
// No Electron, SDK, Main/Renderer lifecycle or native actor is imported here.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {assembleNativeSources,NATIVE_SOURCE_PATHS} from './native-source-series.mjs';
export const nativePromiseFixturesAvailable=Boolean(process.env.VORTEX_NATIVE_SOURCE_ROOT&&process.env.VORTEX_CAPSULE_BUILD_SOURCE);
export const nativePromiseFixtureReason='Set VORTEX_NATIVE_SOURCE_ROOT (exact original26-file export) and VORTEX_CAPSULE_BUILD_SOURCE (reviewed existing TypeScript/Zone workspace); required acceptance sets VORTEX_NATIVE_PROMISE_REQUIRED=1';
if(process.env.VORTEX_NATIVE_PROMISE_REQUIRED==='1')assert(nativePromiseFixturesAvailable,nativePromiseFixtureReason);
const sha=b=>createHash('sha256').update(b).digest('hex');
function pinned(p,hash){const bytes=fs.readFileSync(p);assert.equal(sha(bytes),hash,p);return bytes.toString('utf8');}
let retained;
export function nativePromiseSourceFixture(){
 assert(nativePromiseFixturesAvailable,nativePromiseFixtureReason);
 if(retained)return retained;
 const originalRoot=process.env.VORTEX_NATIVE_SOURCE_ROOT,dependencyRoot=process.env.VORTEX_CAPSULE_BUILD_SOURCE;
 assert(path.isAbsolute(originalRoot)&&path.isAbsolute(dependencyRoot),'explicit absolute source inputs');
 const input=Object.fromEntries(NATIVE_SOURCE_PATHS.map(file=>[file,new Uint8Array(fs.readFileSync(path.join(originalRoot,file)))]));
 const assembled=assembleNativeSources(input);assert.equal(assembled.receipt.nativeAdmission,false);assert.equal(assembled.receipt.effectsAllowed,false);
 const require=createRequire(path.join(dependencyRoot,'package.json')),typescriptPath=require.resolve('typescript');
 pinned(typescriptPath,'569177652966bd528c319171c7dd22860dbf72bde116cbc4f644f1d02bb12e39');const ts=require(typescriptPath);
 const zone=pinned(path.join(dependencyRoot,'node_modules/.pnpm/zone.js@0.15.1/node_modules/zone.js/bundles/zone.umd.js'),'89410ee544a43dd8bc4ff4418eac9f5123c477735f688e9957db1086aeea066d');
 const get=(file,expected)=>{assert(NATIVE_SOURCE_PATHS.includes(file));const row=assembled.receipt.sources.find(row=>row.path===file);assert.equal(row.finalSHA256,expected,'maintained promise source stage');const bytes=assembled.sources[file];assert.equal(sha(bytes),expected);return Buffer.from(bytes).toString('utf8');};
 retained=Object.freeze({ts,zone,preload:get('src/preload/src/index.ts','990d562e5ae2821f7a6e4d77d37d270948bf8f38579ce2d87102b55f278a9df1'),renderer:get('src/renderer/src/ExtensionManager.ts','f1d0e87d10f7b02c99485218f7101196f19f4d4a4b169676efabf014be55d5d5')});
 return retained;
}