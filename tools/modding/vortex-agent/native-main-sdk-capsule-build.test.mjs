import test from'node:test';import assert from'node:assert/strict';import fs from'node:fs';import path from'node:path';import vm from'node:vm';import{createHash}from'node:crypto';import{createRequire}from'node:module';import{pathToFileURL,fileURLToPath}from'node:url';
import{captureNativeSDKSources,NATIVE_SDK_SOURCE_NAMES}from'./native-sdk-capture.mjs';
import{buildNativeSDKCapsule}from'./native-sdk-capsule-build.mjs';
import{applyExact}from'./native-patch-test-fixture.mjs';
const HERE=path.dirname(fileURLToPath(import.meta.url)),ROOT=path.resolve(HERE,'../../..');
const SOURCE=process.env.VORTEX_CAPSULE_BUILD_SOURCE,SDK=process.env.VORTEX_CAPSULE_BUILD_SDK,BINDING=process.env.VORTEX_CAPSULE_BUILD_BINDING,ORIGINAL=process.env.VORTEX_NATIVE_SOURCE_ROOT;
const available=[SOURCE,SDK,BINDING,ORIGINAL].every(value=>typeof value==='string'&&path.isAbsolute(value));
const integration=(name,fn)=>test(name,{skip:available?false:'Set VORTEX_CAPSULE_BUILD_SOURCE/SDK/BINDING and VORTEX_NATIVE_SOURCE_ROOT',timeout:15000},fn);
const sha=b=>createHash('sha256').update(b).digest('hex');
const PACKET=path.join(HERE,'native-patches/vortex-persistence-2.9.1');
const metadata=JSON.parse(fs.readFileSync(path.join(PACKET,'native-main-sdk-capsule-build.json'))),patch=fs.readFileSync(path.join(PACKET,'native-main-sdk-capsule-build.patch'),'utf8');
let sourceCache;
function sources(){
 if(sourceCache)return sourceCache;
 const parent=JSON.parse(fs.readFileSync(path.join(PACKET,'native-main-runtime-binding.json'))),parentPatch=fs.readFileSync(path.join(PACKET,'native-main-runtime-binding.patch'),'utf8'),original=fs.readFileSync(path.join(ORIGINAL,parent.upstreamPath),'utf8');
 assert.equal(sha(original),parent.originalSourceSHA256);assert.equal(sha(parentPatch),parent.patchSHA256);
 const input=applyExact(original,parentPatch,parent.upstreamPath);assert.equal(sha(input),parent.outputSHA256);assert.equal(sha(input),metadata.inputSHA256);assert.equal(sha(patch),metadata.patchSHA256);
 const output=applyExact(input,patch,metadata.upstreamPath);assert.equal(sha(output),metadata.outputSHA256);
 const base=fs.readFileSync(path.join(SOURCE,'rolldown.base.mjs'),'utf8');assert.equal(sha(base),'c94b03882080ced12407a72d0f8f3e5502835889d0b5b5c2fedb7645c267b6b0');
 sourceCache={input,output,base};return sourceCache;
}
function config({env={},io=fs,banner}={}){
 const {base,output}=sources();
 const processFacade={env:{NODE_ENV:'production',...env},platform:process.platform,cwd(){assert.fail('no cwd fallback');}};
 const strip=s=>s.replace(/^import .*;\r?\n/gm,'').replace(/^export /gm,'').replaceAll('import.meta.dirname',JSON.stringify(HERE));
 const create=vm.runInNewContext(strip(base)+'\ncreateConfig;', {path,process:processFacade,defineConfig:x=>x});
 const prefix=output.slice(0,output.indexOf('const bundle = await rolldown(config);'));
 return vm.runInNewContext(strip(prefix)+'\nconfig;', {nativeFS:io,path,createHash,Buffer,TextDecoder,process:processFacade,mainOutputDirectory:path.join(HERE,'never-created-output'),createConfig(...args){const c=create(...args);if(banner!==undefined)c.output.banner=banner;return c;}},{timeout:2000});
}
let compiler;
async function fixture(){
 const parent=path.join(ROOT,'local-state/native-sdk-capsule-build-tests');fs.mkdirSync(parent,{recursive:true});const root=fs.mkdtempSync(path.join(parent,'build-'));
 const binding0=JSON.parse(fs.readFileSync(BINDING)),old=SDK,sdk=path.join(root,'tools/modding/vortex-agent');fs.mkdirSync(sdk,{recursive:true});
 for(const name of NATIVE_SDK_SOURCE_NAMES){const b=fs.readFileSync(path.join(old,name));assert.equal(sha(b),binding0.sourceSHA256[name]);fs.writeFileSync(path.join(sdk,name),b,{flag:'wx'});}
 const binding={...binding0,workspaceRoot:root.replaceAll('\\','/')},capture=captureNativeSDKSources(sdk,binding.sourceSHA256);
 compiler??=(await import(pathToFileURL(createRequire(path.join(SOURCE,'src/main/package.json')).resolve('rolldown')).href)).rolldown;
 const built=await buildNativeSDKCapsule(capture,Buffer.from(JSON.stringify(binding)),compiler),dir=path.join(root,'local-state/native-sdk-capsule');fs.mkdirSync(dir,{recursive:true});
 const artifact=path.join(dir,'compiled.json'),loader=path.join(dir,'loader.cjs'),loaderBytes=fs.readFileSync(path.join(ROOT,'tools/modding/vortex-agent/native-sdk-capsule-load.cjs'));
 assert.equal(sha(loaderBytes),'74830d23c15d8e17d87a5d770771040ccd3469ae181d205e433f6d7fa3e76fbf');
 fs.writeFileSync(artifact,built.artifact,{flag:'wx'});fs.writeFileSync(loader,loaderBytes,{flag:'wx'});
 const env={NEXUS_RUNTIME_WORKSPACE:root,NEXUS_RUNTIME_CAPSULE_SHA256:built.sha256,NEXUS_RUNTIME_CAPSULE_LOADER_SHA256:sha(loaderBytes)};
 return{root,binding,artifact,loader,env,built};
}
integration('patch pins parent and preserves the existing raw15 capture function byte-for-byte',()=>{
 const {input,output}=sources();const parent=JSON.parse(fs.readFileSync(path.join(PACKET,'native-main-runtime-binding.json')));assert.equal(metadata.inputSHA256,parent.outputSHA256);assert.equal(metadata.prerequisitePatchSHA256,parent.patchSHA256);
 const body=s=>s.slice(s.indexOf('function nativeRuntimeBinding()'),s.indexOf('\n\n',s.indexOf('  return binding;')));
 assert.equal(body(input),body(output));assert.equal(metadata.nativeAdmission,false);
});
integration('unconfigured builds embed both nulls without IO and reject orphan inputs',()=>{
 const io=new Proxy({},{get(){assert.fail('no unconfigured IO');}}),c=config({io,banner:'existing banner',env:{NEXUS_WORKSPACE:'Z:/ignored'}});
 assert.equal(c.transform.define.__NEXUS_NATIVE_RUNTIME_BINDING__,'null');assert.equal(c.transform.define.__NEXUS_NATIVE_CAPSULE__,'null');assert.equal(c.transform.define['process.env.NODE_ENV'],'"production"');assert(c.output.banner.startsWith('existing banner\n'));assert(c.output.banner.includes('const __NEXUS_NATIVE_CAPSULE_LOADER_SHA256__=null;'));assert(c.output.banner.includes('const __NEXUS_NATIVE_CAPSULE_LOAD__=null;'));
 for(const env of [{NEXUS_RUNTIME_CAPSULE_SHA256:'a'.repeat(64)},{NEXUS_RUNTIME_CAPSULE_LOADER_SHA256:'b'.repeat(64)}])assert.throws(()=>config({env,io}),/NATIVE_RUNTIME_CAPSULE_REFUSED/);
});
integration('actual builder artifact passes actual captured CJS banner and both nested builtin gates',async()=>{
 const f=await fixture(),c=config({env:f.env}),literal=JSON.parse(c.transform.define.__NEXUS_NATIVE_CAPSULE__);
 assert.deepEqual(Object.keys(literal),['schema','artifactBase64','artifactSHA256','loaderSHA256']);assert.equal(literal.schema,'native-sdk-capsule-binding/1');assert.equal(literal.artifactSHA256,f.built.sha256);assert.equal(sha(Buffer.from(literal.artifactBase64,'base64')),f.built.sha256);
 assert.equal(JSON.stringify(JSON.parse(c.transform.define.__NEXUS_NATIVE_RUNTIME_BINDING__)),JSON.stringify(f.binding));assert(c.output.banner.startsWith('const __NEXUS_NATIVE_CAPSULE_LOADER_SHA256__='));
 const get=new vm.Script('(function(require){'+c.output.banner+'\nreturn {load:__NEXUS_NATIVE_CAPSULE_LOAD__,loaderSHA:__NEXUS_NATIVE_CAPSULE_LOADER_SHA256__,outerStrict:(function(){return this;})()===undefined};})').runInThisContext();
 const scoped=get(createRequire(import.meta.url));assert.equal(scoped.loaderSHA,literal.loaderSHA256);assert.equal(scoped.loaderSHA,sha(fs.readFileSync(f.loader)));assert.equal(scoped.outerStrict,false);assert.equal(typeof scoped.load,'function');
 const loaded=scoped.load(Buffer.from(literal.artifactBase64,'base64'),literal.artifactSHA256,Buffer.from(JSON.stringify(f.binding)));
 assert.equal(loaded.artifactSHA256,f.built.sha256);assert.equal(typeof loaded.modules['native-executor-journal.mjs'].createNativeExecutorJournal,'function');
 assert.equal(typeof loaded.modules['owned-zip-relay-client.mjs'].createBoundOwnedZipRelay,'function');
 assert.throws(()=>config({env:f.env,banner:'existing banner'}),/BANNER_REFUSED/);assert.throws(()=>config({env:f.env,banner:()=>{assert.fail('must not call banner');}}),/BANNER_REFUSED/);
 assert.equal(fs.existsSync(path.join(f.root,'local-state/vortex-agent-build/native-install-executor')),false);
});
integration('independent expected hashes, required environment and exact binding prevent silent adoption',async()=>{
 const f=await fixture();
 for(const key of ['NEXUS_RUNTIME_CAPSULE_SHA256','NEXUS_RUNTIME_CAPSULE_LOADER_SHA256']){
  const missing={...f.env};delete missing[key];assert.throws(()=>config({env:missing}),/CAPSULE_REFUSED/);
  assert.throws(()=>config({env:{...f.env,[key]:'f'.repeat(64)}}),/CAPSULE_REFUSED/);assert.throws(()=>config({env:{...f.env,[key]:'A'.repeat(64)}}),/CAPSULE_REFUSED/);
 }
 const value=JSON.parse(f.built.artifact);value.binding.workspaceRoot+='-wrong';const bytes=Buffer.from(JSON.stringify(value));fs.writeFileSync(f.artifact,bytes);
 assert.throws(()=>config({env:{...f.env,NEXUS_RUNTIME_CAPSULE_SHA256:sha(bytes)}}),/CAPSULE_REFUSED/);
 fs.writeFileSync(f.artifact,f.built.artifact);fs.appendFileSync(path.join(f.root,'tools/modding/vortex-agent/strict-json.cjs'),'\n// own source changed\n');assert.throws(()=>config({env:f.env}),/CAPSULE_REFUSED/);
});
integration('canonical closed artifacts refuse extra fields, reordered keys, BOM and malformed UTF8',async()=>{
 const f=await fixture(),a=JSON.parse(f.built.artifact);
 for(const bytes of [Buffer.from(JSON.stringify({...a,extra:true})),Buffer.from(JSON.stringify(Object.fromEntries(Object.entries(a).reverse()))),Buffer.from(' '+f.built.artifact),Buffer.concat([Buffer.from([239,187,191]),Buffer.from(f.built.artifact)]),Buffer.from([255])]){
  fs.writeFileSync(f.artifact,bytes);assert.throws(()=>config({env:{...f.env,NEXUS_RUNTIME_CAPSULE_SHA256:sha(bytes)}}));
 }
});
integration('bounded ordinary FD capture refuses oversized, reparse and late generation drift',async()=>{
 const f=await fixture();
 fs.writeFileSync(f.loader,Buffer.alloc(65537,65));assert.throws(()=>config({env:{...f.env,NEXUS_RUNTIME_CAPSULE_LOADER_SHA256:sha(fs.readFileSync(f.loader))}}),/CAPSULE_REFUSED/);
 const raw=fs.readFileSync(path.join(ROOT,'tools/modding/vortex-agent/native-sdk-capsule-load.cjs'));fs.writeFileSync(f.loader,raw);
 const io={...fs,lstatSync(p,options){const s=fs.lstatSync(p,options);return p===f.loader?{...s,isFile:()=>true,isDirectory:()=>false,isSymbolicLink:()=>true}:s;}};
 assert.throws(()=>config({env:f.env,io}),/CAPSULE_REFUSED/);
 let changed=false;const drift={...fs,openSync(p,...args){if(p===f.loader&&!changed){changed=true;fs.appendFileSync(f.artifact,' ');}return fs.openSync(p,...args);}};
 assert.throws(()=>config({env:f.env,io:drift}),/CAPSULE_REFUSED/);assert(changed);
 const large=Buffer.alloc(4*1024*1024+1,65);fs.writeFileSync(f.artifact,large);let opened=false;
 const bounded={...fs,openSync(p,...args){if(p===f.artifact)opened=true;return fs.openSync(p,...args);}};
 assert.throws(()=>config({env:{...f.env,NEXUS_RUNTIME_CAPSULE_SHA256:sha(large)},io:bounded}),/CAPSULE_REFUSED/);assert.equal(opened,false);
});
integration('loader bytes are captured, not evaluated during build configuration',async()=>{
 const f=await fixture(),bytes=Buffer.from("throw Error('LOADER_MUST_NOT_RUN_AT_BUILD');\n");fs.writeFileSync(f.loader,bytes);
 const c=config({env:{...f.env,NEXUS_RUNTIME_CAPSULE_LOADER_SHA256:sha(bytes)}});assert(c.output.banner.includes('LOADER_MUST_NOT_RUN_AT_BUILD'));
});
