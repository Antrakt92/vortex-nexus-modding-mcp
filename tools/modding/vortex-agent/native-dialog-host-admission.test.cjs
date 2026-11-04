'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createNativeDialogHostAdmission,SOURCES}=require('./native-dialog-host-admission.cjs');
function fixture(t,options={}) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'native-dialog-source-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const exe=path.join(dir,'Vortex.exe'),source=path.join(dir,'resources','app.asar');
  fs.mkdirSync(path.dirname(source)); fs.writeFileSync(exe,'fixture'); fs.writeFileSync(source,'source');
  let creation=1,version='2.9.1',hashes=0;
  const api={getPath:()=>exe,getState:()=>({app:{appVersion:version}})};
  const admit=createNativeDialogHostAdmission(api,{processInfo:{pid:123,getCreationTime:()=>creation},hash(){hashes++;return options.hash||Object.keys(SOURCES)[0];}});
  return {dir,exe,source,api,admit,changeGeneration(){creation++;},changeVersion(){version='3.0.0';},get hashes(){return hashes;}};
}
test('pins reviewed host source once per exact same generation and source identity',t=>{
  const f=fixture(t);assert.equal(f.admit().variant,'official-2.9.1');assert.equal(f.admit(),f.admit());assert.equal(f.hashes,1);
  fs.appendFileSync(f.source,'changed');assert.throws(f.admit,/SOURCE_CHANGED_IN_HOST/);assert.equal(f.hashes,1);
});
test('generation, version, API replacement and unreviewed bytes are refused',t=>{
  const a=fixture(t);a.admit();a.changeGeneration();assert.throws(a.admit,/SOURCE_CHANGED_IN_HOST/);
  const b=fixture(t);b.changeVersion();assert.throws(b.admit,/HOST_VERSION_UNSUPPORTED/);
  const c=fixture(t);c.api.getPath=()=>c.exe;assert.throws(c.admit,/HOST_API_CHANGED/);
  const d=fixture(t,{hash:'f'.repeat(64)});assert.throws(d.admit,/HOST_SOURCE_UNREVIEWED/);
});
test('hardlinked source and missing generation are refused before hash admission',t=>{
  const f=fixture(t);fs.linkSync(f.source,path.join(f.dir,'alias'));assert.throws(f.admit,/SOURCE_NOT_PLAIN_FILE/);assert.equal(f.hashes,0);
  const g=fixture(t);assert.throws(createNativeDialogHostAdmission(g.api,{processInfo:{pid:123}}),/HOST_GENERATION_UNAVAILABLE/);
});
test('source recheck after hashing refuses bytes swapped during initial proof',t=>{
  const f=fixture(t);const admit=createNativeDialogHostAdmission(f.api,{processInfo:{pid:123,getCreationTime:()=>1},hash(){fs.appendFileSync(f.source,'changed');return Object.keys(SOURCES)[1];}});
  assert.throws(admit,/SOURCE_CHANGED_DURING_HASH/);
});
test('real hash path pins the opened descriptor and refuses an unreviewed real file',t=>{
  const f=fixture(t),processInfo={pid:123,getCreationTime:()=>1};
  assert.throws(createNativeDialogHostAdmission(f.api,{processInfo}),/HOST_SOURCE_UNREVIEWED/);
  const io={...fs,fstatSync(fd,opts){const s=fs.fstatSync(fd,opts);return {...s,ino:s.ino+1n};}};
  assert.throws(createNativeDialogHostAdmission(f.api,{processInfo,io}),/SOURCE_CHANGED_DURING_HASH/);
});
