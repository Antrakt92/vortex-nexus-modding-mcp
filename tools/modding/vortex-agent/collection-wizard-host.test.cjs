'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const source=fs.readFileSync(path.join(__dirname,'collection-wizard-host.cjs'),'utf8');
const OFFICIAL='ec3a29d58ea65a1ca84e456742c894a19efe96920a6710063d221d451a26d59a';
const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
function fixture(){
 const root=path.resolve('modeled-wizard-host'),own=path.join(root,'user/plugins/adapter'),user=path.join(root,'user'),manifest=path.join(root,'reviewed.json'),pkg=path.join(root,'resources/app.asar');
 const files=new Map(),symlinks=new Set();let serial=1,reads=0,factories=0,proves=0,afterRead=null,beforeReturn=null;
 const key=p=>(/^[a-z]:[\\/]/i.test(p)?path.win32.normalize(p):path.resolve(p)).replace(/\\/g,'/').toLowerCase();
 function put(p,body){const old=files.get(key(p));files.set(key(p),{body:Buffer.from(body),ino:old?.ino??serial++,version:(old?.version??0)+1});}
 function stat(p,opts={}){const f=files.get(key(p)),big=opts.bigint===true;return {dev:1n,ino:BigInt(f?.ino??0),size:big?BigInt(f?.body.length??0):f?.body.length??0,mtimeNs:BigInt(f?.version??0),ctimeNs:BigInt(f?.version??0),isSymbolicLink:()=>symlinks.has(key(p)),isFile:()=>!!f};}
 const stamp=p=>{const s=stat(p,{bigint:true});return[s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs].join(':');};
 const disk={promises:{},existsSync:p=>files.has(key(p)),lstatSync:stat,statSync:stat,readFileSync(p){reads++;const f=files.get(key(p));if(!f)throw Error('MODELED_FILE_MISSING');const result=Buffer.from(f.body);afterRead?.(p);return result;}};
 put(pkg,'official host');put(path.join(own,'index.js'),'reviewed adapter');
 put(path.join(own,'provenance.json'),JSON.stringify({pluginSha256:sha('reviewed adapter')}));
 let extensions=[{dynamic:true,path:own,name:'adapter',info:{id:'adapter',version:'1.0',bundled:false}},{dynamic:false,name:'builtin'}];
 const api={getLoadedExtensions:()=>extensions};
 const stub={normalizeAdditionalSources:require('./local-install-host.cjs').normalizeAdditionalSources,createLocalInstallHostAdmission({packagePath,expected}){factories++;return async()=>{
  proves++;const all=[{path:packagePath,sha256:OFFICIAL},...expected.dynamic.flatMap(d=>d.files.map(f=>({path:path.join(d.path,f.path),sha256:f.sha256}))),...(expected.additionalSources||[])];
  const sources=all.map(f=>{const body=files.get(key(f.path))?.body;assert.ok(body,'modeled admitted file exists');assert.equal(f.path===packagePath?body.toString():sha(body),f.path===packagePath?'official host':f.sha256);return {...f,generation:stamp(f.path)};});
  beforeReturn?.();return {appAsarSha256:OFFICIAL,dynamicExtensions:expected.dynamic.length,sources};
 };}};
 const module={exports:{}};
 const requireModel=name=>name==='original-fs'?disk:name==='./local-install-host.cjs'?stub:name==='./stock-vortex-2.9.1-admission.json'?{appAsarSha256:OFFICIAL,extensions:[]}:name==='./paths.cjs'?{receipts:path.join(root,'receipts')}:require(name);
 const load=vm.runInThisContext('(function(require,module,exports,__dirname,process){'+source+'\n})');
 load(requireModel,module,module.exports,own,{execPath:path.join(root,'Vortex.exe')});
 const helpers=rows=>put(manifest,JSON.stringify({schema:'collection-wizard-reviewed-helpers/1',reviewed:true,appAsarSha256:OFFICIAL,helpers:rows}));
 const make=()=>module.exports.createWizardHostAdmission(api,{getVortexPath:()=>user},{reviewedHelpersPath:manifest});
 const addHelper=(folder='helper')=>{const p=path.join(user,'plugins',folder);put(path.join(p,'index.js'),'reviewed helper');put(path.join(p,'worker.cjs'),'reviewed worker');extensions.push({dynamic:true,path:p,name:folder});helpers([{folder,files:[{path:'index.js',sha256:sha('reviewed helper')},{path:'worker.cjs',sha256:sha('reviewed worker')}]}]);return p;};
 return {root,own,pkg,manifest,disk,make,put,helpers,addHelper,api,symlinks,stat,files,key,stamp,exports:module.exports,
  get extensions(){return extensions;},set extensions(v){extensions=v;},set afterRead(v){afterRead=v;},set beforeReturn(v){beforeReturn=v;},counters:()=>({reads,factories,proves})};
}
test('admission returns frozen proof; immediate sync check only stats/census, with no rereads',async()=>{
 const f=fixture(),admit=f.make(),proof=await admit();assert.equal(proof.sourceAdmitted,true);assert.equal(Object.isFrozen(proof.sources),true);
 const before=f.counters();assert.equal(admit.revalidate(proof),proof);assert.deepEqual(f.counters(),before);assert.equal(admit.revalidate(proof).then,undefined);
 await admit();assert.equal(f.counters().factories,1);
});
test('reviewed helper closure is passed through and proved, not only its entrypoint',async()=>{
 const f=fixture(),helper=f.addHelper(),proof=await f.make()();assert.equal(proof.sources.length,4);assert.ok(proof.sources.some(p=>f.key(p.path)===f.key(path.join(helper,'worker.cjs'))));
});
for(const target of ['app','adapter','helper','manifest','provenance'])test('synchronous boundary refuses changed '+target+' generation',async()=>{
 const f=fixture(),helper=f.addHelper(),admit=f.make(),proof=await admit();
 const p={app:f.pkg,adapter:path.join(f.own,'index.js'),helper:path.join(helper,'worker.cjs'),manifest:f.manifest,provenance:path.join(f.own,'provenance.json')}[target];
 f.put(p,'changed');assert.throws(()=>admit.revalidate(proof),/SOURCE_GENERATION_CHANGED/);assert.throws(()=>admit.revalidate(proof),/HOST_PROOF_REQUIRED/);
});
test('byte-identical inode replacement invalidates prepared synchronous proof',async()=>{
 const f=fixture(),admit=f.make(),proof=await admit(),entry=f.files.get(f.key(f.pkg));entry.ino++;assert.throws(()=>admit.revalidate(proof),/SOURCE_GENERATION_CHANGED/);
});
for(const field of ['path','name','dynamic','version'])test('loaded census '+field+' drift refuses immediately',async()=>{
 const f=fixture(),admit=f.make(),proof=await admit();
 if(field==='version')f.extensions[0].info.version='2.0';else f.extensions[0][field]=field==='dynamic'?false:'changed';
 assert.throws(()=>admit.revalidate(proof),/EXTENSION|EXTENSIONS/);
});
test('non-dynamic extension census changes also refuse',async()=>{const f=fixture(),admit=f.make(),proof=await admit();f.extensions[1].name='other';assert.throws(()=>admit.revalidate(proof),/EXTENSIONS_CHANGED/);});
test('caller cannot forge/copy a proof or use another issuer',async()=>{
 const f=fixture(),admit=f.make(),proof=await admit();assert.throws(()=>admit.revalidate({...proof}),/HOST_PROOF_REQUIRED/);
 const other=f.make();await other();assert.throws(()=>other.revalidate(proof),/HOST_PROOF_REQUIRED/);
});
test('missing manifest becomes stale if a new manifest appears',async()=>{const f=fixture(),admit=f.make(),proof=await admit();f.helpers([]);assert.throws(()=>admit.revalidate(proof),/METADATA_CHANGED/);});
test('unknown helper refuses before the hash verifier is constructed',async()=>{const f=fixture();f.extensions.push({dynamic:true,path:path.join(f.root,'user/plugins/unreviewed')});await assert.rejects(f.make()(),/UNREVIEWED_EXTENSION/);assert.equal(f.counters().factories,0);});
test('own adapter must actually be loaded',async()=>{const f=fixture();f.extensions=f.extensions.slice(1);await assert.rejects(f.make()(),/ADAPTER_NOT_LOADED/);});
test('source or census drift during asynchronous proof cannot issue a usable proof',async()=>{
 const f=fixture();f.beforeReturn=()=>{f.extensions.push({dynamic:false,name:'late'});};await assert.rejects(f.make()(),/EXTENSIONS_CHANGED/);
});
test('metadata read races and reparse ancestors refuse',async()=>{
 const f=fixture();f.helpers([]);f.afterRead=p=>{if(p===f.manifest)f.put(p,'raced');};await assert.rejects(f.make()(),/METADATA_CHANGED/);
 const g=fixture();g.symlinks.add(g.key(path.dirname(g.own)));await assert.rejects(g.make()(),/REPARSE/);
});
test('synchronous source ancestor symlink refuses even when file stat is unchanged',async()=>{const f=fixture(),admit=f.make(),proof=await admit();f.symlinks.add(f.key(path.dirname(f.pkg)));assert.throws(()=>admit.revalidate(proof),/REPARSE/);});
for(const [name,rows]of [
 ['parent path',[{folder:'helper',files:[{path:'../index.js',sha256:'a'.repeat(64)}]}]],
 ['absolute path',[{folder:'helper',files:[{path:'/index.js',sha256:'a'.repeat(64)}]}]],
 ['backslash',[{folder:'helper',files:[{path:'dir\\index.js',sha256:'a'.repeat(64)}]}]],
 ['bad hash',[{folder:'helper',files:[{path:'index.js',sha256:'bad'}]}]],
 ['duplicate case file',[{folder:'helper',files:[{path:'index.js',sha256:'a'.repeat(64)},{path:'INDEX.JS',sha256:'a'.repeat(64)}]}]],
 ['missing entry',[{folder:'helper',files:[{path:'worker.cjs',sha256:'a'.repeat(64)}]}]],
 ['duplicate case folder',[{folder:'helper',files:[{path:'index.js',sha256:'a'.repeat(64)}]},{folder:'HELPER',files:[{path:'index.js',sha256:'a'.repeat(64)}]}]]
])test('invalid even unloaded helper manifest refuses: '+name,async()=>{const f=fixture();f.helpers(rows);await assert.rejects(f.make()(),/ADMISSION_INVALID|HELPER_/);assert.equal(f.counters().factories,0);});
test('failed fresh admission invalidates an older successfully prepared proof',async()=>{const f=fixture(),admit=f.make(),proof=await admit();f.helpers([{folder:'bad',files:[]}]);await assert.rejects(admit());assert.throws(()=>admit.revalidate(proof),/HOST_PROOF_REQUIRED/);});
test('missing relative manifest is invalid configuration, not an empty admission',()=>{const f=fixture();assert.throws(()=>f.exports.reviewedHelpers('relative-missing.json'),/ADMISSION_PATH/);});

function externalHelper(f,refs,folder='helper'){
 f.addHelper(folder);f.helpers([{folder,files:[{path:'index.js',sha256:sha('reviewed helper')},{path:'worker.cjs',sha256:sha('reviewed worker')}],externalSources:refs}]);
}
for(const target of ['reviewed.json','SOURCE-GRAPH.json','operation.cjs'])test('external '+target+' is independently proved and invalidates click proof on drift',async()=>{
 const f=fixture(),p='F:/reviewed-helper/'+target;f.put(p,'sealed external');externalHelper(f,[{path:p,sha256:sha('sealed external')}]);
 const admit=f.make(),proof=await admit();assert.ok(proof.sources.some(s=>f.key(s.path)===f.key(p)));const before=f.counters();admit.revalidate(proof);assert.deepEqual(f.counters(),before);
 f.put(p,'changed');assert.throws(()=>admit.revalidate(proof),/SOURCE_GENERATION_CHANGED/);
});
test('external sources are actually hashed, never silently ignored',async()=>{
 const f=fixture(),p='F:/reviewed-helper/reviewed.json';f.put(p,'wrong');externalHelper(f,[{path:p,sha256:sha('reviewed')}]);await assert.rejects(f.make()());
});
test('shared external references deduplicate with exact hash; conflicting pins refuse',async()=>{
 const f=fixture(),p='F:/reviewed-helper/shared.cjs',ref={path:p,sha256:sha('shared')};f.put(p,'shared');f.addHelper('one');f.addHelper('two');
 const row=(folder,r)=>({folder,files:[{path:'index.js',sha256:sha('reviewed helper')}],externalSources:[r]});
 f.helpers([row('one',ref),row('two',{...ref,path:'f:/REVIEWED-helper/shared.cjs'})]);const proof=await f.make()();assert.equal(proof.sources.filter(s=>f.key(s.path)===f.key(p)).length,1);
 f.helpers([row('one',ref),row('two',{...ref,sha256:'a'.repeat(64)})]);await assert.rejects(f.make()(),/SOURCE_HASH_CONFLICT/);
});
test('unloaded helper external files are validated but not read',async()=>{
 const f=fixture();f.helpers([{folder:'unloaded',files:[{path:'index.js',sha256:'a'.repeat(64)}],externalSources:[{path:'F:/missing/not-loaded.cjs',sha256:'b'.repeat(64)}]}]);assert.equal((await f.make()()).sources.length,2);
});
test('external reparse ancestor refuses immediate revalidation',async()=>{
 const f=fixture(),p='F:/reviewed-helper/config.json';f.put(p,'sealed');externalHelper(f,[{path:p,sha256:sha('sealed')}]);const admit=f.make(),proof=await admit();f.symlinks.add(f.key('F:/reviewed-helper'));assert.throws(()=>admit.revalidate(proof),/REPARSE/);
});
for(const [label,refs]of [
 ['relative',[{path:'relative.cjs',sha256:'a'.repeat(64)}]],['UNC',[{path:'//server/share/a',sha256:'a'.repeat(64)}]],
 ['control',[{path:'F:/bad\nname',sha256:'a'.repeat(64)}]],['parent',[{path:'F:/a/../b',sha256:'a'.repeat(64)}]],
 ['unknown field',[{path:'F:/a',sha256:'a'.repeat(64),execute:true}]],['duplicate',[{path:'F:/a',sha256:'a'.repeat(64)},{path:'f:/A',sha256:'a'.repeat(64)}]],
 ['too many',Array.from({length:129},(_,i)=>({path:'F:/a'+i,sha256:'a'.repeat(64)}))],['null',null]
])test('invalid externalSources refuses eagerly even for unloaded helper: '+label,async()=>{const f=fixture();externalHelper(f,refs);f.extensions=f.extensions.filter(e=>e.name!=='helper');await assert.rejects(f.make()(),/BINDING_INVALID|ADMISSION_INVALID/);assert.equal(f.counters().factories,0);});
for(const where of ['manifest','helper','file'])test('unknown '+where+' fields refuse instead of ignoring source policy',async()=>{
 const f=fixture();f.addHelper();const value=JSON.parse(f.files.get(f.key(f.manifest)).body.toString());(where==='manifest'?value:where==='helper'?value.helpers[0]:value.helpers[0].files[0]).unsupported=true;f.put(f.manifest,JSON.stringify(value));await assert.rejects(f.make()(),/ADMISSION_INVALID|HELPER_FILE_INVALID/);
});
