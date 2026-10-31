import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {TextDecoder,types as nativeRegistrationTypes} from 'node:util';
import {repo,prepared,stage,sha,execute,parsed,deferred,tick} from './native-query-source-admission.test.mjs';
import {registrationBackend,registrationBytes} from './native-owned-mod-registration.test.mjs';
import {trackedBytes} from './native-tracked-mod-registration.test.mjs';
import {applyExact} from './native-patch-test-fixture.mjs';
export {deferred,tick};
export const ANCHOR_KEY='nativeExecutorAnchorV1';
export const anchorBytes=(hash='a'.repeat(64),rootId='0:123')=>Buffer.from(JSON.stringify({schema:'native-executor-anchor/1',rootId,inventorySHA256:hash}));
const stages=['new-mod-conflict-query','backend-write-admission','native-backend-sql-admission','native-owned-mod-registration','native-tracked-mod-registration','native-backend-registration-release'];
function source(){const input=prepared(stages),{m,patch}=stage('native-executor-anchor-storage');assert.equal(sha(input),m.inputSHA256);assert.equal(sha(patch),m.patchSHA256);const output=applyExact(input,patch,m.upstreamPath);assert.equal(sha(output),m.outputSHA256);return output;}
/** Actual patched Level/Registry/Singleton with an owned in-memory SQL facade.
 * This validates source calls/transactions; it is not a native database result. */
export async function createAnchorFixture(t,options={}){
 const f=await registrationBackend(t,{main:true}),committed=new Map(options.seed??[]),calls=[];let transaction=null;
 f.backend.run=async(sql,params)=>{
  calls.push({sql,params:params===undefined?undefined:structuredClone(params)});await options.beforeRun?.(sql,params);
  const data=transaction??committed;
  if(sql==='BEGIN TRANSACTION'){assert.equal(transaction,null);transaction=new Map(committed);}
  else if(sql==='COMMIT'){assert.ok(transaction);committed.clear();for(const pair of transaction)committed.set(...pair);transaction=null;}
  else if(sql==='ROLLBACK'){transaction=null;}
  else if(sql.startsWith('INSERT INTO')){assert.equal(params.length%2,0);for(let i=0;i<params.length;i+=2)data.set(params[i],params[i+1]);}
  else if(sql.startsWith('DELETE FROM')){for(const key of [...data.keys()])for(let i=0;i<params.length;i+=2)if(key===params[i]||key.startsWith(params[i+1]))data.delete(key);}
  else throw Error('UNSUPPORTED_OWN_SQL_WRITE');
  await options.afterRun?.(sql,params);
 };
 f.backend.runAndReadAll=async(sql,params)=>{
  calls.push({sql,params:params===undefined?undefined:structuredClone(params)});await options.beforeRead?.(sql,params);
  const data=transaction??committed;let rows;
  if(sql.includes('AS exact_key'))rows=[...data].filter(([key])=>key===ANCHOR_KEY||key.startsWith(ANCHOR_KEY+'###')).slice(0,2).map(([key,value])=>[key===ANCHOR_KEY,sql.includes('AS value_hex')?(typeof value==='string'&&Buffer.byteLength(value,'utf8')<=1024?Buffer.from(value,'utf8').toString('hex').toUpperCase():null):(typeof value==='string'&&[...value].length<=1024?(options.driverStripsBOM?value.replace(/^\ufeff/,''):value):null)]);
  else if(sql.includes('SELECT 1 FROM keys'))rows=options.conflict?[[1]]:[];
  else if(sql.startsWith('WITH keys'))rows=[...data].filter(([key])=>key===params[0]||key.startsWith(params[0]+'###'));
  else if(sql.startsWith('SELECT DISTINCT'))rows=[...new Set([...data.keys()].filter(key=>key===null?sql.includes('key IS NULL OR')||!sql.includes('WHERE'):options.ignoreFilter||!key.startsWith(ANCHOR_KEY)).map(key=>key===null?null:key.split('###')[0]))].map(value=>[value]);
  else if(sql.startsWith('SELECT value'))rows=data.has(params[0])?[[data.get(params[0])]]:[];
  else if(sql.startsWith('SELECT key, value'))rows=[...data].filter(([key])=>key===null?sql.includes('key IS NULL OR')||!sql.includes('WHERE'):(options.ignoreFilter||!(key===ANCHOR_KEY||key.startsWith(ANCHOR_KEY+'###')))&&(!sql.includes('starts_with(key, $1)')||key.startsWith(params[0])));
  else if(sql.startsWith('SELECT key'))rows=[...data.keys()].filter(key=>key===null?sql.includes('key IS NULL OR')||!sql.includes('WHERE'):options.ignoreFilter||!(key===ANCHOR_KEY||key.startsWith(ANCHOR_KEY+'###'))).map(key=>[key]);
  else throw Error('UNSUPPORTED_OWN_SQL_READ');
  return {getRows:()=>options.rows?options.rows(sql,rows):rows};
 };
 const types=execute(source(),'({LevelPersist,snapshotNativeNewModRegistration,snapshotNativeTrackedModRegistration,snapshotNativeExecutorAnchor,isNativeExecutorAnchorKey})',{
  DuckDBSingleton:f.Singleton,nativeRegistrationHash:createHash,NativeRegistrationDecoder:TextDecoder,nativeRegistrationTypes,unknownToError:e=>e,log:options.log??(()=>{})});
 const level=new types.LevelPersist(f.backend,'db'),query=await f.pool.createConnection(),registry=new f.Registry(query);await registry.initialize(parsed(f.root),f.root);
 let backendOwner,sqlOwner;if(!options.unreserved){backendOwner=await level.reserveNativeBackendWrites();sqlOwner=level.reserveNativeSQLAdmission(backendOwner,registry);}
 return {...f,...types,types,level,registry,backendOwner,sqlOwner,committed,calls,transaction:()=>transaction,
  read:()=>types.LevelPersist.prototype.readNativeExecutorAnchor.call(level),write:(expected,next)=>types.LevelPersist.prototype.writeNativeExecutorAnchor.call(level,backendOwner,sqlOwner,registry,expected,next)};
}
const integration=(name,fn)=>test(name,{timeout:10000,skip:repo?false:'Set VORTEX_EXTENSION_ADMISSION_REPO'},fn);
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 test('storage patch metadata pins exact full75 Level source and stays prepared only',()=>{const{m,patch}=stage('native-executor-anchor-storage');assert.equal(sha(patch),m.patchSHA256);assert.equal(m.inputSHA256,'c509be8df5498636db703244d5e874d6f988dd836a681d48e741da6168517d0d');for(const key of ['installed','nativeAcceptanceVerified','installationPermit','powerLossPersistenceVerified','releaseSupported'])assert.equal(m[key],false);});
 integration('canonical anchor snapshot is closed and detached; serialized aliases are private',async t=>{const f=await createAnchorFixture(t),raw=anchorBytes(),snapshot=f.snapshotNativeExecutorAnchor(raw);raw.fill(0);assert.equal(snapshot.rootId,'0:123');assert.equal(Object.isFrozen(snapshot),true);for(const key of [ANCHOR_KEY,ANCHOR_KEY+'###child',ANCHOR_KEY+'###'])assert.equal(f.isNativeExecutorAnchorKey(key),true);assert.equal(f.isNativeExecutorAnchorKey(ANCHOR_KEY+'x'),false);});
 integration('absent read then owned exact CAS write, readback, and second update preserve owners',async t=>{const f=await createAnchorFixture(t);assert.equal(await f.read(),null);const a=anchorBytes(),b=anchorBytes('b'.repeat(64)),first=await f.write(null,a);assert.equal(first.commitObserved,true);assert.equal(first.anchorSHA256,sha(a));assert.equal(first.previousSHA256,null);assert.deepEqual(Buffer.from(await f.read()),a);const second=await f.write(a,b);assert.equal(second.previousSHA256,sha(a));assert.deepEqual(Buffer.from(await f.read()),b);f.level.checkNativeSQLAdmission(f.sqlOwner,f.backendOwner,f.registry);assert.equal(f.level.getNativeBackendWriteStatus().activeIntents,0);});
 integration('canonical codec rejects lossy/duplicate/noncanonical/shared and getter inputs without callbacks',async t=>{
  const f=await createAnchorFixture(t);let calls=0;const raw=anchorBytes(),shared=new Uint8Array(new SharedArrayBuffer(raw.length));shared.set(raw);
  const getter={get byteLength(){calls++;return 1}},proxy=new Proxy(raw,{get(){calls++;throw Error('trap')}});
  for(const value of [Buffer.from('{}'),Buffer.from(' '+raw),Buffer.from('{"schema":"native-executor-anchor/1","rootId":"0:123","rootId":"0:123","inventorySHA256":"'+'a'.repeat(64)+'"}'),Buffer.from(JSON.stringify({rootId:'0:123',schema:'native-executor-anchor/1',inventorySHA256:'a'.repeat(64)})),Buffer.alloc(1025),Buffer.from([255]),shared,getter,proxy])assert.throws(()=>f.snapshotNativeExecutorAnchor(value),/NATIVE_EXECUTOR_ANCHOR_HOLD/);
  assert.equal(calls,0);assert.equal(f.calls.length,0);
 });
 integration('strict fixed reader distinguishes only actual absence; corrupt/descendant/query failures hold without DataInvalid',async t=>{
  for(const seed of [[[ANCHOR_KEY,'not json']],[[ANCHOR_KEY+'###child',anchorBytes().toString()]],[[ANCHOR_KEY,anchorBytes().toString()],[ANCHOR_KEY+'###child','x']],[[ANCHOR_KEY,'x'.repeat(2048)]],[[ANCHOR_KEY,null]]]){const f=await createAnchorFixture(t,{seed});await assert.rejects(f.read(),e=>e.name==='Error'&&e.message==='NATIVE_EXECUTOR_ANCHOR_HOLD');assert.equal(f.level.getNativeBackendWriteStatus().phase,'held');assert.match(f.calls[0].sql,/octet_length\(encode\(value\)\) <= 1024/);assert.match(f.calls[0].sql,/LIMIT 2/);assert.doesNotMatch(f.calls[0].sql,/SELECT key,/);}
  const f=await createAnchorFixture(t,{beforeRead:()=>{throw Error('private SQL path')}});await assert.rejects(f.read(),e=>e.message==='NATIVE_EXECUTOR_ANCHOR_HOLD'&&!e.message.includes('private'));
 });
 integration('strict read contributes an active intent and pending backend reservation drains it before grant',async t=>{
  const gate=deferred(),f=await createAnchorFixture(t,{unreserved:true,beforeRead:()=>gate.promise});const reading=f.read();await tick();assert.equal(f.level.getNativeBackendWriteStatus().activeIntents,1);let granted=false;const reserve=f.level.reserveNativeBackendWrites().then(o=>{granted=true;return o});await tick();assert.equal(granted,false);gate.resolve();assert.equal(await reading,null);const owner=await reserve;f.level.checkNativeBackendWriteOwner(owner);assert.equal(f.level.getNativeBackendWriteStatus().activeIntents,0);
 });
 integration('raw exposure and held/error read states cannot become an absent anchor',async t=>{
  const f=await createAnchorFixture(t,{unreserved:true});assert.equal(f.level.connection,f.backend);await assert.rejects(f.read(),/HOLD/);assert.equal(f.calls.length,0);
  const gate=deferred(),g=await createAnchorFixture(t,{unreserved:true,beforeRead:()=>gate.promise});const reading=g.read(),reserved=g.level.reserveNativeBackendWrites().then(()=>assert.fail('grant'),e=>e);gate.reject(Error('read failed'));await assert.rejects(reading,/HOLD/);assert.match((await reserved).message,/HELD/);
 });
 integration('ordinary exact/descendant/serialized-alias APIs reject anchor keys and full batches before any SQL',async t=>{
  const aliases=[[ANCHOR_KEY],[ANCHOR_KEY,'child'],[ANCHOR_KEY+'###child']];
  for(const parts of aliases)for(const action of [(f,k)=>f.level.getItem(k),(f,k)=>f.level.setItem(k,'value'),(f,k)=>f.level.removeItem(k),(f,k)=>f.level.bulkSetItem([{key:['ordinary'],value:'one'},{key:k,value:'two'}]),(f,k)=>f.level.bulkRemoveItem([['ordinary'],k])]){const f=await createAnchorFixture(t,{unreserved:true});await assert.rejects(action(f,parts),/HOLD/);assert.equal(f.calls.length,0);assert.equal(f.committed.size,0);}
 });
 integration('ordinary enumeration and hydration projections omit fixed root and descendants even if facade returns them',async t=>{
  const seed=[[ANCHOR_KEY,anchorBytes().toString()],[ANCHOR_KEY+'###child','private'],['persistent###own','visible']];const f=await createAnchorFixture(t,{unreserved:true,seed,ignoreFilter:true});assert.deepEqual(Array.from(await f.level.getAllKeys(),row=>Array.from(row)),[['persistent','own']]);assert.deepEqual(Array.from(await f.level.getPersistedHives()),['persistent']);const kvs=await f.level.getAllKVs();assert.equal(kvs.length,1);assert.equal(kvs[0].value,'visible');assert.deepEqual(Array.from(kvs[0].key),['persistent','own']);await assert.rejects(f.level.getAllKVs(ANCHOR_KEY),/HOLD/);await assert.rejects(f.level.getAllKVs(ANCHOR_KEY+'###child'),/HOLD/);
 });
 integration('whole batches snapshot primitive keys and values before logging/SQL callbacks; getters never execute',async t=>{
  const key=['ordinary'],items=[{key,value:'first'}],f=await createAnchorFixture(t,{unreserved:true,beforeRun:()=>{key[0]=ANCHOR_KEY;items[0].value='mutated'}});await f.level.bulkSetItem(items);assert.equal(f.committed.get('ordinary'),'first');assert.equal(f.committed.has(ANCHOR_KEY),false);
  let callbacks=0;const getter={get key(){callbacks++;return[ANCHOR_KEY]},value:'hidden'},g=await createAnchorFixture(t,{unreserved:true});await assert.rejects(g.level.bulkSetItem([{key:['safe'],value:'one'},getter]),/HOLD/);assert.equal(callbacks,0);assert.equal(g.calls.length,0);
  const removing=['ordinary'],h=await createAnchorFixture(t,{unreserved:true,seed:[['ordinary','keep'],[ANCHOR_KEY,anchorBytes().toString()]],beforeRun:()=>{removing[0]=ANCHOR_KEY}});
  await h.level.bulkRemoveItem([removing]);assert.equal(h.committed.has('ordinary'),false);assert.equal(h.committed.get(ANCHOR_KEY),anchorBytes().toString());
 });
 integration('CAS conflict and descendant corruption roll back before COMMIT and never overwrite existing bytes',async t=>{
  for(const seed of [[[ANCHOR_KEY,anchorBytes().toString()]],[[ANCHOR_KEY+'###child','foreign']]]){const f=await createAnchorFixture(t,{seed});await assert.rejects(f.write(null,anchorBytes('b'.repeat(64))),/HOLD/);assert.deepEqual([...f.committed],seed);assert.equal(f.calls.filter(c=>c.sql==='ROLLBACK').length,1);assert.equal(f.calls.some(c=>c.sql==='COMMIT'),false);await assert.rejects(f.write(null,anchorBytes()),/HOLD/);}
 });
 integration('owned active/transaction counters remain truthful and idle checks/registration/release refuse without opening anything',async t=>{
  const gate=deferred(),f=await createAnchorFixture(t,{beforeRun:sql=>sql==='BEGIN TRANSACTION'?gate.promise:undefined});const writing=f.write(null,anchorBytes());await tick();const status=f.level.getNativeBackendWriteStatus();assert.equal(status.activeIntents,1);assert.equal(status.transactionPending,1);assert.equal(status.inTransaction,false);assert.throws(()=>f.level.checkNativeBackendWriteOwner(f.backendOwner),/BUSY/);assert.throws(()=>f.level.checkNativeSQLAdmission(f.sqlOwner,f.backendOwner,f.registry),/BUSY/);await assert.rejects(f.level.registerNativeNewMod(f.backendOwner,f.sqlOwner,f.registry,registrationBytes()),/REFUSED/);assert.throws(()=>f.level.prepareNativeTrackedRegistrationRelease(f.backendOwner,f.sqlOwner,f.registry),/BUSY/);gate.resolve();await writing;f.level.checkNativeSQLAdmission(f.sqlOwner,f.backendOwner,f.registry);assert.equal(f.level.getNativeBackendWriteStatus().activeIntents,0);
 });
 integration('ordinary writer during anchor transaction holds the operation before mutation',async t=>{
  const gate=deferred(),f=await createAnchorFixture(t,{beforeRun:sql=>sql==='BEGIN TRANSACTION'?gate.promise:undefined});const writing=f.write(null,anchorBytes());await tick();await assert.rejects(f.level.setItem(['ordinary'],'value'),/HOLD/);gate.resolve();await assert.rejects(writing,/HOLD/);assert.equal(f.committed.size,0);assert.equal(f.calls.some(c=>c.sql.startsWith('INSERT')),false);
 });
 integration('pre-COMMIT failure preserves null/undefined primary through rollback failure; COMMIT unknown never rolls back or retries',async t=>{
  for(const primary of [null,undefined]){const f=await createAnchorFixture(t,{beforeRun:sql=>{if(sql.startsWith('INSERT'))throw primary;if(sql==='ROLLBACK')throw Error('secondary')}});await f.write(null,anchorBytes()).then(()=>assert.fail('success'),e=>assert.equal(e,primary));assert.equal(f.calls.filter(c=>c.sql==='ROLLBACK').length,1);assert.equal(f.level.getNativeBackendWriteStatus().activeIntents,0);}
  const lost=Error('lost COMMIT reply'),g=await createAnchorFixture(t,{afterRun:sql=>{if(sql==='COMMIT')throw lost}});await assert.rejects(g.write(null,anchorBytes()),e=>e===lost);assert.equal(g.committed.get(ANCHOR_KEY),anchorBytes().toString());assert.equal(g.calls.some(c=>c.sql==='ROLLBACK'),false);await assert.rejects(g.write(null,anchorBytes()),/HOLD/);assert.equal(g.calls.filter(c=>c.sql==='COMMIT').length,1);
 });
 integration('BEGIN unknown, readback mismatch, method drift and swallowed reentrant write cannot grant an ACK',async t=>{
  const begin=await createAnchorFixture(t,{beforeRun:sql=>{if(sql==='BEGIN TRANSACTION')throw Error('begin')}});await assert.rejects(begin.write(null,anchorBytes()),/begin/);assert.equal(begin.calls.some(c=>c.sql==='ROLLBACK'),false);
  let reads=0;const back=await createAnchorFixture(t,{rows:(sql,rows)=>sql.includes('AS exact_key')&&++reads===2?[]:rows});await assert.rejects(back.write(null,anchorBytes()),/HOLD/);assert.equal(back.committed.has(ANCHOR_KEY),true);assert.equal(back.calls.some(c=>c.sql==='ROLLBACK'),false);
  let f;f=await createAnchorFixture(t,{beforeRead:async()=>{await assert.rejects(f.write(null,anchorBytes()),/HOLD/)}});await assert.rejects(f.write(null,anchorBytes()),/HOLD/);assert.equal(f.committed.size,0);
  let drift;drift=await createAnchorFixture(t,{afterRun:sql=>{if(sql==='BEGIN TRANSACTION')drift.backend.run=async()=>{throw Error('replacement')}}});await assert.rejects(drift.write(null,anchorBytes()),/HOLD/);assert.equal(drift.calls.some(c=>c.sql==='COMMIT'),false);
 });
 integration('successful anchor ACK leaves the SAME backend/sql reservation usable for actual registration',async t=>{
  const f=await createAnchorFixture(t);await f.write(null,anchorBytes());const registered=await f.level.registerNativeNewMod(f.backendOwner,f.sqlOwner,f.registry,registrationBytes());assert.equal(registered.commitObserved,true);assert.equal(f.committed.get(ANCHOR_KEY),anchorBytes().toString());assert.equal(f.committed.has('persistent###mods###game###new###id'),true);
 });

 integration('exact full75 predecessor exposes and overwrites the raw key while the new ordinary boundary refuses',async t=>{
  const f=await createAnchorFixture(t,{unreserved:true,seed:[[ANCHOR_KEY,anchorBytes().toString()]],ignoreFilter:true});
  const previous=execute(prepared(stages),'LevelPersist',{DuckDBSingleton:f.Singleton,nativeRegistrationHash:createHash,NativeRegistrationDecoder:TextDecoder,nativeRegistrationTypes,unknownToError:e=>e});const legacy=new previous(f.backend,'db');
  assert.equal(await legacy.getItem([ANCHOR_KEY]),anchorBytes().toString());assert.equal((await legacy.getAllKeys()).some(key=>key[0]===ANCHOR_KEY),true);assert.equal((await legacy.getPersistedHives()).includes(ANCHOR_KEY),true);assert.equal((await legacy.getAllKVs()).some(row=>row.key[0]===ANCHOR_KEY),true);
  await legacy.setItem([ANCHOR_KEY],'old ordinary overwrite');assert.equal(f.committed.get(ANCHOR_KEY),'old ordinary overwrite');const before=f.calls.length;await assert.rejects(f.level.setItem([ANCHOR_KEY],'new overwrite'),/HOLD/);assert.equal(f.calls.length,before);assert.equal(f.committed.get(ANCHOR_KEY),'old ordinary overwrite');
 });
 integration('unrelated ordinary roundtrips retain their legacy results and reader array getters never execute',async t=>{
  const f=await createAnchorFixture(t,{unreserved:true});await f.level.setItem(['persistent','one'],'first');assert.equal(await f.level.getItem(['persistent','one']),'first');await f.level.bulkSetItem([{key:['persistent','two'],value:'second'},{key:['settings','one'],value:'third'}]);assert.equal((await f.level.getAllKeys()).length,3);await f.level.removeItem(['persistent']);assert.equal(f.committed.size,1);await f.level.bulkRemoveItem([['settings']]);assert.equal(f.committed.size,0);await assert.rejects(f.level.getItem(['missing']),e=>e.name==='NotFoundError');
  let callbacks=0;const row=[true,anchorBytes().toString()];Object.defineProperty(row,'1',{get(){callbacks++;return anchorBytes().toString()}});const g=await createAnchorFixture(t,{rows:()=>[row]});await assert.rejects(g.read(),/HOLD/);assert.equal(callbacks,0);
 });

 integration('ordinary NULL-key corruption remains visible or erroneous instead of being filtered to healthy empty',async t=>{
  const f=await createAnchorFixture(t,{unreserved:true,seed:[[null,'corrupt']]});
  const previous=execute(prepared(stages),'LevelPersist',{DuckDBSingleton:f.Singleton,nativeRegistrationHash:createHash,NativeRegistrationDecoder:TextDecoder,nativeRegistrationTypes,unknownToError:e=>e}),legacy=new previous(f.backend,'db');
  await assert.rejects(legacy.getAllKeys(),e=>e.name==='TypeError');await assert.rejects(f.level.getAllKeys(),e=>e.name==='TypeError');
  await assert.rejects(legacy.getAllKVs(),e=>e.name==='TypeError');await assert.rejects(f.level.getAllKVs(),e=>e.name==='TypeError');assert.deepEqual(Array.from(await legacy.getPersistedHives()),[null]);assert.deepEqual(Array.from(await f.level.getPersistedHives()),[null]);
  assert.deepEqual(Array.from(await f.level.getAllKVs('persistent')),[]);
 });

 integration('UTF8 BOM input is rejected before BEGIN rather than silently normalized',async t=>{
  const f=await createAnchorFixture(t),bom=Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),anchorBytes()]);assert.throws(()=>f.snapshotNativeExecutorAnchor(bom),/NATIVE_EXECUTOR_ANCHOR_HOLD/);await assert.rejects(f.write(null,bom),/NATIVE_EXECUTOR_ANCHOR_HOLD/);assert.equal(f.calls.length,0);assert.equal(f.committed.size,0);
 });
 integration('persisted BOM anchor is corruption and cannot be returned as normalized canonical bytes',async t=>{
  const bom='\ufeff'+anchorBytes().toString('utf8'),f=await createAnchorFixture(t,{seed:[[ANCHOR_KEY,bom]]});await assert.rejects(f.read(),e=>e.name==='Error'&&e.message==='NATIVE_EXECUTOR_ANCHOR_HOLD');assert.equal(f.committed.get(ANCHOR_KEY),bom);assert.equal(f.level.getNativeBackendWriteStatus().phase,'held');
 });

 integration('v1 registration rejects BOM canonical bytes before BEGIN without consuming a SQL transaction',async t=>{
  const f=await createAnchorFixture(t),bom=Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),registrationBytes()]);assert.throws(()=>f.snapshotNativeNewModRegistration(bom),/NATIVE_REGISTRATION_REQUEST/);await assert.rejects(f.level.registerNativeNewMod(f.backendOwner,f.sqlOwner,f.registry,bom),/NATIVE_REGISTRATION_REQUEST/);assert.equal(f.calls.length,0);assert.equal(f.committed.size,0);
 });
 integration('v2 tracked registration rejects BOM canonical bytes before BEGIN and archive SQL reads',async t=>{
  const f=await createAnchorFixture(t),bom=Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),trackedBytes()]);assert.throws(()=>f.snapshotNativeTrackedModRegistration(bom),/NATIVE_TRACKED_REGISTRATION_REQUEST/);await assert.rejects(f.level.registerNativeTrackedMod(f.backendOwner,f.sqlOwner,f.registry,bom),/NATIVE_TRACKED_REGISTRATION_REQUEST/);assert.equal(f.calls.length,0);assert.equal(f.committed.size,0);
 });

 integration('driver-style VARCHAR BOM stripping cannot turn stored corrupt bytes into an accepted anchor',async t=>{
  const original='\ufeff'+anchorBytes().toString('utf8'),f=await createAnchorFixture(t,{seed:[[ANCHOR_KEY,original]],driverStripsBOM:true});await assert.rejects(f.read(),/NATIVE_EXECUTOR_ANCHOR_HOLD/);assert.equal(f.committed.get(ANCHOR_KEY),original);
 });
 integration('fixed HEX transport rejects malformed odd oversized and non-ASCII row values before decoding',async t=>{
  for(const value of ['', '0', 'GG', 'abcd', '00 '.repeat(5), 'A'.repeat(2050), null, 7, '\ufeff7B']){const f=await createAnchorFixture(t,{rows:()=>[[true,value]]});await assert.rejects(f.read(),e=>e.message==='NATIVE_EXECUTOR_ANCHOR_HOLD');}
 });

}
