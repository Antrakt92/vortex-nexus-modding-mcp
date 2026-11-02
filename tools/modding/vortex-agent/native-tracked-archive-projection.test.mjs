// Exact maintained LevelPersist chain from reviewed pristine source. Default discovery is inert; SQL is opt-in.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {stripTypeScriptTypes,createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {TextDecoder,types} from 'node:util';
import {applyExact} from './native-patch-test-fixture.mjs';
import strictJSON from './strict-json.cjs';
const HERE=path.dirname(fileURLToPath(import.meta.url));
const sha=raw=>createHash('sha256').update(raw).digest('hex');
const selection=()=>({schema:'native-tracked-archive-selection/1',gameId:'cyberpunk2077',profileId:'_profile-1',downloadId:'download_1'});
const encode=v=>Buffer.from(JSON.stringify(v));
const error=code=>e=>e?.message===code;
const base='persistent###downloads###files###download_1';
const keys=['state','game','localPath','size','fileMD5','id'].map(k=>base+'###'+k).concat(['settings###profiles###activeProfileId','persistent###profiles###_profile-1###gameId','settings###downloads###path']);
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
const LEVEL_PATH='src/main/src/store/LevelPersist.ts';
const ORIGINAL_SHA256='742929670876a79c7332a13d16381cf2098ee55f57f838e3e35668853d1455a1';
const FINAL_SHA256='9531b9c384bbbb0325b6300b417ba35fa6b631cde8069533894fb879dfd3ce33';
const originalFile=process.env.VORTEX_NATIVE_LEVEL_PERSIST_SOURCE;
const originalRoot=process.env.VORTEX_NATIVE_SOURCE_ROOT;
const hasOriginal=Boolean(originalFile||originalRoot);
const sourceOptions={skip:hasOriginal?false:'Set VORTEX_NATIVE_LEVEL_PERSIST_SOURCE or VORTEX_NATIVE_SOURCE_ROOT to the reviewed pristine Vortex2.9.1 LevelPersist source'};
const sourceTest=(name,body)=>test(name,sourceOptions,body);
let preparedSource;
function source(){
 if(preparedSource!==undefined)return preparedSource;
 const file=originalFile||path.join(originalRoot??'',LEVEL_PATH);assert(path.isAbsolute(file),'original source path must be absolute');
 const read=(file,cap)=>{const stat=fs.statSync(file);assert(stat.isFile()&&stat.size>0&&stat.size<=cap,'bounded source fixture file');const raw=fs.readFileSync(file);assert(raw.length<=cap);return raw;};
 const rawGraph=read(path.join(HERE,'native-source-series.json'),100*1024);
 const series=strictJSON.parseStrictJSON(rawGraph,{maxBytes:100*1024,maxDepth:8,maxTokens:8000});
 assert.equal(series.schema,'native-source-series/2');assert.equal(series.upstreamRepository,'https://github.com/Nexus-Mods/Vortex');
 assert.equal(series.upstreamTag,'v2.9.1');assert.equal(series.upstreamCommit,'c80326367cbe6d96621ad6cf4a5488ef49bac110');
 const record=series.files.find(row=>row.path===LEVEL_PATH);assert(record);assert.equal(record.originalSHA256,ORIGINAL_SHA256);assert.equal(record.finalSHA256,FINAL_SHA256);
 const original=read(file,2*1024*1024);assert.equal(sha(original),record.originalSHA256,'only pristine original upstream bytes may seed this source fixture');
 let text=new TextDecoder('utf-8',{fatal:true}).decode(original),current=record.originalSHA256;
 const selected=series.patches.filter(row=>row.path===LEVEL_PATH);assert(selected.length>0);const done=new Map();
 for(const row of series.patches){
  assert.equal(typeof row.name,'string');assert(/^[a-z][a-z-]{0,63}$/.test(row.name));assert(!done.has(row.name),'duplicate graph stage');
  if(row.path!==LEVEL_PATH){done.set(row.name,row);continue;}
  assert.equal(row.packet,'persistence');const directory=path.join(HERE,'native-patches/vortex-persistence-2.9.1');
  const rawManifest=read(path.join(directory,row.name+'.json'),16*1024),rawPatch=read(path.join(directory,row.name+'.patch'),1024*1024);
  assert.equal(sha(rawManifest),row.manifestSHA256);assert.equal(sha(rawPatch),row.patchSHA256);
  const manifest=strictJSON.parseStrictJSON(rawManifest,{maxBytes:16*1024,maxDepth:8,maxTokens:2000});
  assert.equal(manifest.schema,'native-source-patch/1');assert.equal(manifest.upstreamPath,LEVEL_PATH);
  for(const key of ['upstreamRepository','upstreamTag','upstreamCommit'])assert.equal(manifest[key],series[key]);
  assert.equal(manifest.originalSourceSHA256??record.originalSHA256,record.originalSHA256);
  for(const key of ['inputSHA256','outputSHA256','patchSHA256','prerequisitePatch','prerequisitePatchSHA256','requiredManagerPatchSHA256','requiredCompanionPatch','requiredCompanionPatchSHA256','requiredCompanionOutputSHA256','requiredCompanionPacket'])assert.equal(manifest[key]??null,row[key]??null);
  assert.deepEqual(manifest.additionalCompanions??[],row.additionalCompanions??[]);
  assert.equal(manifest.preparedOnly,true);assert.equal(manifest.installed,false);assert.equal(manifest.nativeAcceptanceVerified,false);
  if(row.prerequisitePatch){const parent=done.get(row.prerequisitePatch.slice(0,-6));assert(parent);assert.equal(parent.packet,row.packet);assert.equal(parent.patchSHA256,row.prerequisitePatchSHA256);}
  if(row.requiredCompanionPatch){const parent=done.get(row.requiredCompanionPatch.slice(0,-6));assert(parent);assert.equal(parent.packet,row.requiredCompanionPacket??row.packet);assert.equal(parent.patchSHA256,row.requiredCompanionPatchSHA256);assert.equal(parent.outputSHA256,row.requiredCompanionOutputSHA256);}
  for(const edge of row.additionalCompanions??[]){const parent=done.get(edge.name);assert(parent);assert.equal(parent.packet,edge.packet);assert.equal(parent.patchSHA256,edge.patchSHA256);assert.equal(parent.outputSHA256,edge.outputSHA256);}
  if(row.requiredManagerPatchSHA256)assert([...done.values()].some(parent=>parent.patchSHA256===row.requiredManagerPatchSHA256&&parent.path.endsWith('/InstallManager.ts')));
  assert.equal(row.inputSHA256,current);assert.equal(sha(Buffer.from(text)),row.inputSHA256);
  text=applyExact(text,new TextDecoder('utf-8',{fatal:true}).decode(rawPatch),LEVEL_PATH);current=sha(Buffer.from(text));assert.equal(current,row.outputSHA256);done.set(row.name,row);
 }
 assert.equal(current,record.finalSHA256);assert.equal(current,FINAL_SHA256);preparedSource=text;return preparedSource;
}
function exports(){
 let code=source().replace(/^import [\s\S]*?;\r?\n/gm,'').replace(/^export default .*;\r?\n?/gm,'').replace(/^export /gm,'');
 class Singleton {static getInstance(){throw Error('NO_DATABASE_OR_POOL_ALLOWED');}}
 return vm.runInNewContext(stripTypeScriptTypes(code,{mode:'transform'})+'\n({LevelPersist,snapshotNativeTrackedArchiveSelection});',{
  Buffer,process,NativeRegistrationDecoder:TextDecoder,nativeRegistrationTypes:types,nativeRegistrationHash:createHash,path,
  DuckDBSingleton:Singleton,unknownToError:e=>e,log(){},getVortexPath(){throw Error('NO_PATH_LOOKUP_ALLOWED');},
 },{filename:LEVEL_PATH,timeout:1000});
}
function fixture(options={}){
 const rows=[['state','finished'],['game',['cyberpunk2077']],['localPath','Own Fixture.zip'],['size',200],['fileMD5','a'.repeat(32)]].map(([k,v])=>[base+'###'+k,JSON.stringify(v)]);
 rows.push(['settings###profiles###activeProfileId',JSON.stringify('_profile-1')],['persistent###profiles###_profile-1###gameId',JSON.stringify('cyberpunk2077')]);
 options.rows?.(rows);const calls=[],materialized=[];
 const slots=(text,params)=>text.split(',').map(v=>params[Number(v.trim().slice(1))-1]);
 // Bounded semantic SQL facade: execute actual selected/guard/descendant predicates over raw key rows.
 function query(sql,params){
  const selectedMatch=/CASE WHEN key IN \(([^)]+)\) AND octet_length\(encode\(value\)\)<=8192/.exec(sql),whereMatch=/WHERE key IS NULL OR key IN \(([^)]+)\)/.exec(sql),limitMatch=/LIMIT (\d+)\s*$/.exec(sql);
  assert(selectedMatch&&whereMatch&&limitMatch,'actual fixed SQL projection must remain bounded');
  const selected=new Set(slots(selectedMatch[1],params)),direct=new Set(slots(whereMatch[1],params));
  const descendants=[...sql.matchAll(/starts_with\(key,\$(\d+) \|\| '###'\)/g)].map(m=>params[Number(m[1])-1]);
  const found=rows.filter(([key])=>key===null||direct.has(key)||descendants.some(prefix=>typeof key==='string'&&key.startsWith(prefix+'###'))).slice(0,Number(limitMatch[1])).map(([key,value])=>[
   typeof key==='string'&&key.length<=512?key:null,selected.has(key)&&typeof value==='string'&&Buffer.byteLength(value,'utf8')<=8192?value:null]);
  materialized.push(structuredClone(found));return found;
 }
 const connection={run(){throw Error('READ_ONLY_NO_SQL_RUN');},async runAndReadAll(sql,params){calls.push({sql,params:structuredClone(params)});await options.before?.();const found=query(sql,params);return options.reader?.(found)??{getRows:()=>options.result?.(found)??found};}};
 const api=exports(),level=new api.LevelPersist(connection,'fixture');return{...api,level,connection,rows,calls,materialized,read:bytes=>level.readNativeTrackedArchiveProjection(bytes??encode(selection()))};
}
sourceTest('actual private backend SELECT derives frozen semantic row and context with missing optional fields explicit',async()=>{
 const f=fixture(),v=await f.read();assert.equal(f.calls.length,1);assert.deepEqual(f.calls[0].params.slice(0,9),keys);
 assert.equal(v.schema,'native-tracked-archive-projection/1');assert.equal(v.activeProfileId,'_profile-1');assert.equal(v.profileGameId,'cyberpunk2077');
 assert.equal(v.downloadPattern.present,false);assert.equal(v.downloadPattern.value,null);assert.equal(v.archive.idPresent,false);assert.equal(v.archive.state,'finished');assert.equal(v.archive.fileMD5,'a'.repeat(32));
 assert(Object.isFrozen(v)&&Object.isFrozen(v.archive)&&Object.isFrozen(v.archive.game)&&Object.isFrozen(v.downloadPattern));
 assert.deepEqual(Object.keys(v),['schema','activeProfileId','profileGameId','downloadPattern','archive']);assert.equal(Object.hasOwn(v,'nativeAdmission'),false);
});
sourceTest('selected stored JSON formatting is semantic, optional id/pattern presence is preserved without resolving paths',async()=>{
 for(const pattern of ['', '{USERDATA}/downloads','F:/Downloads']){const f=fixture({rows:rows=>{rows.push([keys[5],' "download_1" '],[keys[8],JSON.stringify(pattern)]);rows[1][1]=' [ "cyberpunk2077" ] ';}}),v=await f.read();assert.equal(v.archive.idPresent,true);assert.equal(v.downloadPattern.present,true);assert.equal(v.downloadPattern.value,pattern);}
});
sourceTest('selection byte snapshot is canonical closed data, no path/SHA/native provider inputs',()=>{
 const {snapshotNativeTrackedArchiveSelection:snapshot}=exports();assert.equal(snapshot(encode(selection())).profileId,'_profile-1');
 for(const value of[{...selection(),parent:'F:/secret'},{...selection(),sha256:'a'.repeat(64)},{...selection(),gameId:'other'},{...selection(),downloadId:'a###b'},{...selection(),downloadId:'CONSTRUCTOR'}])assert.throws(()=>snapshot(encode(value)),error('NATIVE_TRACKED_ARCHIVE_SELECTION'));
 for(const bytes of[Buffer.from('{"schema":"native-tracked-archive-selection/1","schema":"native-tracked-archive-selection/1","gameId":"cyberpunk2077","profileId":"_profile-1","downloadId":"download_1"}'),Buffer.from([255]),Buffer.alloc(1025),Buffer.from(JSON.stringify(selection(),null,2))])assert.throws(()=>snapshot(bytes),error('NATIVE_TRACKED_ARCHIVE_SELECTION'));
 let calls=0;const proxy=new Proxy(encode(selection()),{get(){calls++;throw Error('trap');}});assert.throws(()=>snapshot(proxy),error('NATIVE_TRACKED_ARCHIVE_SELECTION'));assert.equal(calls,0);
 const carrier=encode(selection());Object.defineProperty(carrier,'buffer',{get(){calls++;throw Error('getter');}});assert.equal(snapshot(carrier).downloadId,'download_1');assert.equal(calls,0);
 const shared=new Uint8Array(new SharedArrayBuffer(1024));assert.throws(()=>snapshot(shared),error('NATIVE_TRACKED_ARCHIVE_SELECTION'));
 const rab=new ArrayBuffer(1024,{maxByteLength:2048});assert.equal(rab.resizable,true);assert.throws(()=>snapshot(new Uint8Array(rab)),error('NATIVE_TRACKED_ARCHIVE_SELECTION'));
});
sourceTest('invalid selection and fake receivers never reach SQL',async()=>{
 const f=fixture();await assert.rejects(f.read(encode({...selection(),owner:{}})),error('NATIVE_TRACKED_ARCHIVE_SELECTION'));assert.equal(f.calls.length,0);
 await assert.rejects(f.LevelPersist.prototype.readNativeTrackedArchiveProjection.call({},encode(selection())),error('NATIVE_TRACKED_ARCHIVE_PROJECTION_REFUSED'));assert.equal(f.calls.length,0);
});
sourceTest('missing fields and malformed finished-row/context/id/pattern values refuse at actual selected result',async()=>{
 const mutations=[rows=>rows.splice(0,1),rows=>rows[0][1]='"started"',rows=>rows[1][1]='["cyberpunk2077","other"]',rows=>rows[2][1]='"../escape.zip"',rows=>rows[3][1]='true',rows=>rows[3][1]='67108865',rows=>rows[4][1]='"bad"',rows=>rows[5][1]='"other_profile"',rows=>rows[6][1]='"other_game"',rows=>rows.push([keys[5],'"other_id"']),rows=>rows.push([keys[8],'null']),rows=>rows[0][1]='{'];
 for(const mutate of mutations){const f=fixture({rows:mutate});await assert.rejects(f.read(),error('NATIVE_TRACKED_ARCHIVE_PROJECTION_CONFLICT'));assert.equal(f.calls.length,1);assert.equal(f.materialized.length,1);}
});
sourceTest('every proper ancestor, selected-field descendant and installed subtree refuses; unrelated secrets never materialize',async()=>{
 const prefixes=new Set();for(const key of keys){const parts=key.split('###');for(let i=1;i<parts.length;i++)prefixes.add(parts.slice(0,i).join('###'));}
 for(const bad of[...prefixes,...keys.map(k=>k+'###child'),base+'###installed',base+'###installed###modId']){const f=fixture({rows:rows=>rows.push([bad,'{"private":"must_not_export"}'])});await assert.rejects(f.read(),error('NATIVE_TRACKED_ARCHIVE_PROJECTION_CONFLICT'));assert.equal(f.materialized[0].find(([key])=>key===bad)?.[1],null);}
 const f=fixture({rows:rows=>rows.push([base+'###urls','"PRIVATE_URL"'],[base+'###modInfo','"PRIVATE_INFO"'],['account###token','"PRIVATE_ACCOUNT"'])});await f.read();assert.equal(f.materialized[0].length,7);assert(!JSON.stringify(f.materialized).includes('PRIVATE_'));
});
sourceTest('oversized selected values, duplicate raw rows and descendant overflow fail closed',async()=>{
 for(const mutate of[rows=>rows[2][1]='"'+'a'.repeat(8192)+'"',rows=>rows.push([...rows[0]]),rows=>{for(let n=0;n<40;n++)rows.push([keys[0]+'###'+n,'"private"']);}]){const f=fixture({rows:mutate});await assert.rejects(f.read(),error('NATIVE_TRACKED_ARCHIVE_PROJECTION_CONFLICT'));assert.equal(f.calls.length,1);}
});
sourceTest('selection is detached before SQL awaits; paused method identity drift and raw exposure hold',async()=>{
 const gate=deferred(),f=fixture({before:()=>gate.promise}),bytes=encode(selection()),pending=f.read(bytes);assert.equal(f.calls.length,1);bytes.fill(0);gate.resolve();assert.equal((await pending).archive.id,'download_1');
 for(const drift of['method','raw']){const wait=deferred(),g=fixture({before:()=>wait.promise}),p=g.read();if(drift==='method')g.connection.runAndReadAll=()=>{throw Error('SUBSTITUTED');};else assert.equal(g.level.connection,g.connection);wait.resolve();await assert.rejects(p,error('NATIVE_TRACKED_ARCHIVE_PROJECTION_HELD'));assert.equal(g.calls.length,1);}
});
sourceTest('raw exposure before read refuses and a concurrent read cannot create a second SQL flight',async()=>{
 const f=fixture();void f.level.connection;await assert.rejects(f.read(),error('NATIVE_TRACKED_ARCHIVE_PROJECTION_REFUSED'));assert.equal(f.calls.length,0);
 const gate=deferred(),g=fixture({before:()=>gate.promise}),first=g.read();await assert.rejects(g.read(),error('NATIVE_TRACKED_ARCHIVE_PROJECTION_REFUSED'));assert.equal(g.calls.length,1);gate.resolve();assert.equal((await first).archive.id,'download_1');
});
sourceTest('result accessors/proxies never execute and backend query primary survives release of the read flag',async()=>{
 let calls=0;const f=fixture({reader:()=>Object.defineProperty({},'getRows',{get(){calls++;throw Error('getter');}})});await assert.rejects(f.read(),error('NATIVE_TRACKED_ARCHIVE_PROJECTION_CONFLICT'));assert.equal(calls,0);
 const g=fixture({result:()=>new Proxy([],{get(){calls++;throw Error('trap');}})});await assert.rejects(g.read(),error('NATIVE_TRACKED_ARCHIVE_PROJECTION_CONFLICT'));assert.equal(calls,0);
 const primary=Error('QUERY_PRIMARY'),h=fixture({before:()=>{throw primary;}});await assert.rejects(h.read(),e=>e===primary);await assert.rejects(h.read(),e=>e===primary);assert.equal(h.calls.length,2,'read-only failure does not mint or consume native IDs');
});


// Explicit opt-in to an ALREADY REVIEWED installed @duckdb/node-api package root.
// Merely loading this test file never resolves/requires the package or opens a DB.
const nativePackageRoot=process.env.VORTEX_NATIVE_DUCKDB_NODE_API;
const nativeOptions={skip:!hasOriginal?sourceOptions.skip:nativePackageRoot?false:'Set VORTEX_NATIVE_DUCKDB_NODE_API to the reviewed @duckdb/node-api 1.5.1-r.1 package root for fresh :memory: SQL only'};
function reviewedNativeAPI(){
 assert.equal(typeof nativePackageRoot,'string');assert(path.isAbsolute(nativePackageRoot),'native package root must be absolute and independently reviewed');
 const root=fs.realpathSync(nativePackageRoot),metadata=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
 assert.equal(metadata.name,'@duckdb/node-api');assert.equal(metadata.version,'1.5.1-r.1');
 const api=createRequire(import.meta.url)(root);assert.equal(typeof api.DuckDBInstance?.create,'function');return api;
}
function nativeSeed(){return[['state','finished'],['game',['cyberpunk2077']],['localPath','Own Fixture.zip'],['size',200],['fileMD5','a'.repeat(32)]].map(([key,value])=>[base+'###'+key,JSON.stringify(value)]).concat([
 ['settings###profiles###activeProfileId',JSON.stringify('_profile-1')],['persistent###profiles###_profile-1###gameId',JSON.stringify('cyberpunk2077')]]);}
async function withNativeRows(mutate,body){
 let instance,connection,failed=false,primary,result;
 try{
  const {LevelPersist}=exports(); // Pin/load the exact source before any native dependency.
  const api=reviewedNativeAPI();
  instance=await api.DuckDBInstance.create(':memory:',{enable_external_access:'false',autoinstall_known_extensions:'false',autoload_known_extensions:'false'});
  connection=await instance.connect();
  await connection.run('SET enable_external_access=false');
  const setting=await connection.runAndReadAll("SELECT current_setting('enable_external_access')");assert.equal(setting.getRows()[0][0],false);
  await connection.run('CREATE SCHEMA fixture');await connection.run('CREATE TABLE fixture.kv (key VARCHAR, value VARCHAR)');
  const rows=nativeSeed();mutate?.(rows);
  for(const[key,value]of rows)await connection.run('INSERT INTO fixture.kv VALUES ($1,$2)',[key,value]);
  const level=new LevelPersist(connection,'fixture');
  // The actual unwrapped DuckDBConnection reaches the maintained class PRIVATE field.
  // No model SQL executor, fake rows or application singleton is used here.
  result=await body({level,connection,read:()=>level.readNativeTrackedArchiveProjection(encode(selection()))});
 }catch(error){failed=true;primary=error;}
 try{connection?.closeSync();}catch(error){if(!failed){failed=true;primary=error;}}
 try{instance?.closeSync();}catch(error){if(!failed){failed=true;primary=error;}}
 if(failed)throw primary;return result;
}
test('native SQL valid seven-field projection omits unrelated private sentinels',nativeOptions,async()=>{
 await withNativeRows(rows=>rows.push([base+'###urls','"PRIVATE_URL_SENTINEL"'],['account###token','"PRIVATE_ACCOUNT_SENTINEL"']),async({read})=>{
  const value=await read();assert.equal(value.archive.localPath,'Own Fixture.zip');assert.equal(value.archive.idPresent,false);assert.equal(value.downloadPattern.present,false);
  assert(!JSON.stringify(value).includes('PRIVATE_'));assert.equal(Object.hasOwn(value,'nativeAdmission'),false);
 });
});
test('native SQL optional stored id and literal pattern produce the nine-field variant',nativeOptions,async()=>{
 await withNativeRows(rows=>rows.push([keys[5],'"download_1"'],[keys[8],'"{USERDATA}/downloads"']),async({read})=>{
  const value=await read();assert.equal(value.archive.idPresent,true);assert.equal(value.downloadPattern.present,true);assert.equal(value.downloadPattern.value,'{USERDATA}/downloads');
 });
});
for(const [name,key]of[['persistent ancestor','persistent'],['downloads ancestor','persistent###downloads'],['profile ancestor','persistent###profiles###_profile-1'],['selected-field descendant',keys[0]+'###child'],['installed descendant',base+'###installed###modId']]){
 test('native SQL refuses '+name,nativeOptions,async()=>{
  await withNativeRows(rows=>rows.push([key,'{"PRIVATE_BLOB_SENTINEL":true}']),async({read})=>{
   await assert.rejects(read(),error('NATIVE_TRACKED_ARCHIVE_PROJECTION_CONFLICT'));
  });
 });
}
test('native SQL oversized selected leaf is capped before projection acceptance',nativeOptions,async()=>{
 await withNativeRows(rows=>{rows[2][1]=JSON.stringify('x'.repeat(8193));},async({read})=>{
  await assert.rejects(read(),error('NATIVE_TRACKED_ARCHIVE_PROJECTION_CONFLICT'));
 });
});
test('native SQL duplicate raw keys cannot prove a unique tracked row',nativeOptions,async()=>{
 await withNativeRows(rows=>rows.push([...rows[0]]),async({read})=>{
  await assert.rejects(read(),error('NATIVE_TRACKED_ARCHIVE_PROJECTION_CONFLICT'));
 });
});
