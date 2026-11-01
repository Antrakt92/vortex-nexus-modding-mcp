// Reuse the same five four-actor scenarios with the actual capsule-backed Main.
// Process/SQL/Electron facts remain explicit fixtures; no worker or app is started.
import fs from 'node:fs';
import assert from 'node:assert/strict';
const original=new URL('./native-executor-completion-integration.test.mjs',import.meta.url);
let text=fs.readFileSync(original,'utf8');
function once(before,after){assert.equal(text.split(before).length,2,before);text=text.replace(before,after);}
once("import {createMainCompletionFixture} from './native-main-executor-completion.test.mjs';",
  "import {createMainSDKCapsuleFixture as createMainCompletionFixture} from './native-main-sdk-capsule.test.mjs';");
once('const main=await createMainCompletionFixture(t,{...options.main,',
  'const main=await createMainCompletionFixture(t,{absentSDK:true,...options.main,');
once('all={main,renderer,preload,ipc,prepared,execute:()=>renderer.ext.executeNativeExecutor()};return all;',
  'assert.equal(main.capsule.loads(),1);assert.equal(fs.existsSync(main.sdk),false);'+
  'all={main,renderer,preload,ipc,prepared,execute:()=>renderer.ext.executeNativeExecutor()};return all;');
once('const ready=process.env.VORTEX_EXTENSION_ADMISSION_REPO&&process.env.VORTEX_EXTENSION_ADMISSION_DEPS;',
  'const ready=process.env.VORTEX_EXTENSION_ADMISSION_REPO&&process.env.VORTEX_EXTENSION_ADMISSION_DEPS&&process.env.VORTEX_CAPSULE_BUILD_SOURCE;');
assert.equal(text.split("integration('").length,6);
text=text.replaceAll("integration('","integration('capsule: ");
text=text.replace(/(from\s*['"])(\.\/[^'"]+)(['"])/g,(_a,b,c,d)=>b+new URL(c,original).href+d);
await import('data:text/javascript;base64,'+Buffer.from(text).toString('base64'));
