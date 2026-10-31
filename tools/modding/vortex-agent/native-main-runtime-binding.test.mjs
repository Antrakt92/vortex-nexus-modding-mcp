import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {repo,original,stage,sha} from './native-query-source-admission.test.mjs';
import {applyExact} from './native-patch-test-fixture.mjs';

const NAMES=['owned-zip-relay-client.mjs','owned-zip-relay-runner.mjs','child-terminal-observer.cjs',
  'owned-zip-worker-client.mjs','owned-zip-worker.py','owned-file-transfer.py','owned-zip-extractor.py',
  'native-executor-journal.mjs','native-intent-journal.mjs','immutable-records.mjs','paths.cjs','paths-core.cjs',
  'native-dispatch-contract.cjs','install-job-contract.cjs','strict-json.cjs'];
const BUILD_SHA='e8d85c7eb88cc6aeb3bc5a46e976b4e2fb213166fb2b4a14457d09d058ec39e1';
const BASE_SHA='c94b03882080ced12407a72d0f8f3e5502835889d0b5b5c2fedb7645c267b6b0';
const HERE=path.dirname(fileURLToPath(import.meta.url));
const integration=(name,fn)=>test(name,{timeout:10000,skip:repo?false:'Set VORTEX_EXTENSION_ADMISSION_REPO'},fn);

function source(){
  const input=original('src/main/build.mjs').toString(),{m,patch}=stage('native-main-runtime-binding');
  assert.equal(sha(input),BUILD_SHA);assert.equal(m.inputSHA256,BUILD_SHA);assert.equal(sha(patch),m.patchSHA256);
  const output=applyExact(input,patch,m.upstreamPath);assert.equal(sha(output),m.outputSHA256);return output;
}
function config({workspace,io=fs,extraEnv={},patched=true}={}){
  const env={NODE_ENV:'production',...extraEnv};if(workspace!==undefined)env.NEXUS_RUNTIME_WORKSPACE=workspace;
  const ownProcess={env,platform:process.platform,cwd(){assert.fail('No cwd lookup allowed');}};
  const base=original('rolldown.base.mjs').toString();assert.equal(sha(base),BASE_SHA);
  const strip=s=>s.replace(/^import .*;\r?\n/gm,'').replace(/^export /gm,'').replaceAll('import.meta.dirname',JSON.stringify(HERE));
  const createConfig=vm.runInNewContext(strip(base)+'\ncreateConfig;',{path,process:ownProcess,defineConfig:x=>x},{timeout:1000});
  const text=patched?source():original('src/main/build.mjs').toString();
  // Run the actual build prefix and actual upstream createConfig. Bundling,
  // worker bundling and wasm copying are outside this pure config fixture.
  const prefix=text.slice(0,text.indexOf('const bundle = await rolldown(config);'));
  return vm.runInNewContext(strip(prefix)+'\nconfig;',{path,nativeFS:io,createHash,Buffer,process:ownProcess,
    createConfig,mainOutputDirectory:path.join(HERE,'own-not-created-build')},{timeout:1000});
}
function fixture(t){
  // The builder intentionally pins every ancestor generation. Parallel suites
  // create siblings in global Temp, so keep these fixtures under our own parent.
  const requestedParent=path.resolve(HERE,'../../../local-state/executor-pending-anchor/recovery/build-tests');
  for(let current=requestedParent;;current=path.dirname(current)){
    let stat;try{stat=fs.lstatSync(current);}catch(error){if(error.code!=='ENOENT')throw error;}
    if(stat){assert(stat.isDirectory());assert(!stat.isSymbolicLink());}
    if(current===path.dirname(current))break;
  }
  fs.mkdirSync(requestedParent,{recursive:true});
  const parent=fs.realpathSync(requestedParent),root=fs.mkdtempSync(path.join(parent,'nmt-runtime-binding-'));
  const sdk=path.join(root,'tools','modding','vortex-agent');fs.mkdirSync(sdk,{recursive:true});
  for(const name of NAMES)fs.writeFileSync(path.join(sdk,name),'throw new Error("SDK must not execute: '+name+'");\n',{flag:'wx'});
  t.after(()=>{assert.equal(path.dirname(root),parent);assert(path.basename(root).startsWith('nmt-runtime-binding-'));assert(!fs.lstatSync(root).isSymbolicLink());fs.rmSync(root,{recursive:true});});
  return{root,sdk};
}
const tuple=c=>JSON.parse(c.transform.define.__NEXUS_NATIVE_RUNTIME_BINDING__);

test('runtime build artifact is an exact first-stage official source patch without admission',()=>{
  const {m,patch}=stage('native-main-runtime-binding');assert.equal(sha(patch),m.patchSHA256);
  assert.equal(m.upstreamPath,'src/main/build.mjs');assert.equal(m.originalSourceSHA256,BUILD_SHA);
  for(const key of ['installed','nativeAcceptanceVerified','installationPermit','powerLossPersistenceVerified','startupGateSupported'])assert.equal(m[key],false);
});
integration('absent build-only input embeds null without filesystem, cwd or ambient fallback',()=>{
  const io=new Proxy({},{get(){assert.fail('Absent input must do no filesystem IO');}});
  const c=config({io,extraEnv:{NEXUS_WORKSPACE:'C:/ignored',HOME:'C:/ignored',USERPROFILE:'C:/ignored'}});
  assert.equal(c.transform.define.__NEXUS_NATIVE_RUNTIME_BINDING__,'null');
  assert.equal(c.transform.define['process.env.NODE_ENV'],'"production"');
  assert.equal(config({patched:false}).transform.define.__NEXUS_NATIVE_RUNTIME_BINDING__,undefined);
});
integration('actual fixed fifteen-source closure becomes a literal, preserving existing upstream config and no SDK execution',t=>{
  const f=fixture(t),c=config({workspace:f.root}),binding=tuple(c);
  assert.deepEqual(Object.keys(binding),['schema','workspaceRoot','relayNodeSHA256','sourceSHA256']);
  assert.equal(binding.schema,'native-executor-runtime-binding/1');assert.equal(binding.workspaceRoot,f.root.replaceAll('\\','/'));
  assert.equal(binding.relayNodeSHA256,'5c976096e04e5c2c1f091938926234cc9fbebfe9787ddd149351b3b0ecc707b5');
  assert.deepEqual(Object.keys(binding.sourceSHA256),NAMES);
  for(const name of NAMES)assert.equal(binding.sourceSHA256[name],sha(fs.readFileSync(path.join(f.sdk,name))));
  assert.equal(c.transform.define['process.env.NODE_ENV'],'"production"');assert.equal(c.output.format,'cjs');
  assert.equal(c.output.dynamicImportInCjs,false);assert.equal(c.external('node:fs'),true);assert.equal(c.external('./own'),false);
});
integration('actual maintained SDK closure hashes every fixed leaf, including paths-core, without importing it',()=>{
  const workspace=path.resolve(HERE,'../../..'),binding=tuple(config({workspace}));assert.deepEqual(Object.keys(binding.sourceSHA256),NAMES);
  for(const name of NAMES)assert.equal(binding.sourceSHA256[name],sha(fs.readFileSync(path.join(HERE,name))));
});
integration('wrong explicit environment never falls back and rejects before filesystem reads',()=>{
  const io=new Proxy({},{get(){assert.fail('Invalid input must not read FS');}});
  const values=['','relative','file:///C:/Nexus',' C:/Nexus ','C:/Nexus/../other','C:/Nexus/./other','bad\0root','C:/Nexus/with\ncontrol','C:/Nexus/with\x1fcontrol'];
  if(process.platform==='win32')values.push('\\rooted-without-drive','/rooted-without-drive','C:relative','\\\\?\\C:\\Nexus','\\\\.\\C:\\Nexus');
  for(const workspace of values)assert.throws(()=>config({workspace,io}),/NATIVE_RUNTIME_BINDING_REFUSED/);
});
integration('serialized binding over the runtime codec 8KiB limit refuses even with valid mapped physical fixtures',t=>{
  const f=fixture(t),large=path.join(f.root,'a'.repeat(9000));
  const mapped=p=>typeof p==='string'&&p.startsWith(large)?f.root+p.slice(large.length):p;
  const io={...fs,lstatSync(p,...rest){return fs.lstatSync(mapped(p),...rest);},openSync(p,...rest){return fs.openSync(mapped(p),...rest);}};
  assert.throws(()=>config({workspace:large,io}),/NATIVE_RUNTIME_BINDING_REFUSED/);
});
integration('literal serialization preserves path punctuation without interpreting it as code',t=>{
  const f=fixture(t),workspace=path.join(f.root,"literal-$'-`workspace"),sdk=path.join(workspace,'tools','modding','vortex-agent');
  fs.mkdirSync(sdk,{recursive:true});for(const name of NAMES)fs.copyFileSync(path.join(f.sdk,name),path.join(sdk,name));
  const c=config({workspace}),literal=c.transform.define.__NEXUS_NATIVE_RUNTIME_BINDING__;
  assert.equal(JSON.parse(literal).workspaceRoot,workspace.replaceAll('\\','/'));
  assert.equal(vm.runInNewContext('('+literal+').workspaceRoot'),workspace.replaceAll('\\','/'));
});
integration('missing or oversize leaf refuses without importing source or performing an unbounded read',t=>{
  const f=fixture(t),leaf=path.join(f.sdk,NAMES[0]);fs.unlinkSync(leaf);assert.throws(()=>config({workspace:f.root}));
  fs.writeFileSync(leaf,Buffer.alloc(524289));let reads=0;
  assert.throws(()=>config({workspace:f.root,io:{...fs,readSync(...a){reads++;return fs.readSync(...a);}}}),/REFUSED/);assert.equal(reads,0);
});
integration('leaf and ancestor symlinks refuse rather than following them',t=>{
  const f=fixture(t),leaf=path.join(f.sdk,NAMES[0]),target=path.join(f.root,'own-target');fs.writeFileSync(target,'own');fs.unlinkSync(leaf);fs.symlinkSync(target,leaf,'file');
  assert.throws(()=>config({workspace:f.root}),/REFUSED/);fs.unlinkSync(leaf);fs.writeFileSync(leaf,'own');
  const alias=path.join(f.root,'alias');fs.symlinkSync(path.join(f.root,'tools'),alias,'junction');
  const nested=path.join(f.root,'aliased-workspace');fs.mkdirSync(nested);fs.symlinkSync(path.join(f.root,'tools'),path.join(nested,'tools'),'junction');
  assert.throws(()=>config({workspace:nested}),/REFUSED/);
});
integration('growth during a read refuses at admitted size plus one, closes its FD, and bounds chunks',t=>{
  const f=fixture(t),leaf=path.join(f.sdk,NAMES[0]);let changed=false,opened=0,closed=0,maxRead=0;
  const io={...fs,openSync(...a){opened++;return fs.openSync(...a);},closeSync(...a){closed++;return fs.closeSync(...a);},readSync(...a){maxRead=Math.max(maxRead,a[3]);const n=fs.readSync(...a);if(!changed){changed=true;fs.appendFileSync(leaf,'growth');}return n;}};
  assert.throws(()=>config({workspace:f.root,io}),/REFUSED/);assert.equal(opened,closed);assert(maxRead<=65536);
});
integration('cross-leaf late drift and directory replacement are caught by terminal resampling',t=>{
  for(const kind of ['leaf','directory']){
    const f=fixture(t),first=path.join(f.sdk,NAMES[0]);let reads=0,changed=false;
    const io={...fs,readSync(...a){const n=fs.readSync(...a);reads++;if(!changed&&reads===3){changed=true;if(kind==='leaf')fs.appendFileSync(first,'late');else fs.mkdirSync(path.join(f.sdk,'new-directory'));}return n;}};
    assert.throws(()=>config({workspace:f.root,io}),/REFUSED/);assert.equal(changed,true);
  }
});
