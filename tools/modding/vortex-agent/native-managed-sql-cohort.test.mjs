import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {TextDecoder,types as nativeRegistrationTypes} from 'node:util';
import {execute,sqlTree,parsed,deferred,tick,prepared,stage,sha} from './native-query-source-admission.test.mjs';
const series=JSON.parse(fs.readFileSync(new URL('./native-source-series.json',import.meta.url),'utf8'));
const variant=process.env.SQL_POOL_VARIANT ?? 'candidate';
assert.ok(['baseline','candidate'].includes(variant));
const added=new Set(['native-sql-managed-cohort','native-backend-managed-cohort']);
const sources=new Map();
function source(name){
 if(!sources.has(name)){
  const file='src/main/src/store/'+name+'.ts';
  const rows=series.patches.filter(row=>row.path===file && (variant==='candidate'||!added.has(row.name)));
  assert(rows.length>0);
  const text=prepared(rows.map(row=>row.name));
  assert.equal(sha(text),rows.at(-1).outputSHA256);
  if(variant==='candidate')assert.equal(sha(text),series.files.find(row=>row.path===file).finalSHA256);
  sources.set(name,text);
 }
 return sources.get(name);
}
const skip=process.env.VORTEX_EXTENSION_ADMISSION_REPO?false:'Set VORTEX_EXTENSION_ADMISSION_REPO to the reviewed official cache';
/** Real Singleton + Level factory + QueryRegistry source. Only DuckDB driver/SQL
 * and getVortexPath are facades; no native module/import/app/database is opened. */
async function fixture(t,{count=2}={}) {
 const connections=[],calls=[];
 const driver={async connect(){const c={async run(sql,params){calls.push({c,sql,params});await c.beforeRun?.(sql,params);},async runAndReadAll(){return{getRows:()=>[],getRowObjectsJson:()=>[]}},getTableNames(){return[]},closeSync(){calls.push({c,sql:'CLOSE'})}};connections.push(c);return c;},closeSync(){}};
 const Registry=execute(source('QueryRegistry'),'QueryRegistry');
 const Singleton=execute(source('DuckDBSingleton'),'DuckDBSingleton',{QueryRegistry:Registry,DuckDBInstance:{create:async()=>driver}});
 const Level=execute(source('LevelPersist'),'LevelPersist',{DuckDBSingleton:Singleton,nativeRegistrationHash:createHash,NativeRegistrationDecoder:TextDecoder,nativeRegistrationTypes,getVortexPath:()=>'/OWN/UNUSED-EXTENSIONS',unknownToError:e=>e});
 const pool=Singleton.getInstance(),levels=[];
 if(count===0)await pool.initialize('/OWN/UNUSED-EXTENSIONS');
 for(let n=0;n<count;n++)levels.push(await Level.create('/OWN/NO-NATIVE-DB/'+n));
 const query=await pool.createConnection(),root=sqlTree(t),registry=new Registry(query);
 await registry.initialize(parsed(root),root);
 const selected=levels.at(-1),early=levels[0],backend=connections[count]; // bootstrap connection is index0
 const reserve=async()=>{const bo=await selected.reserveNativeBackendWrites();const so=selected.reserveNativeSQLAdmission(bo,registry);return{bo,so};};
 return{pool,Level,Registry,levels,selected,early,registry,query,connections,calls,backend,reserve};
}
test('managed cohort patches remain pinned source preparation without installation authority',()=>{
 for(const name of added){const {m,patch}=stage(name);assert.equal(sha(patch),m.patchSHA256);
  for(const field of ['installed','nativeAcceptanceVerified','installationPermit'])assert.equal(m[field],false);
  const row=series.patches.find(row=>row.name===name);assert.equal(row.outputSHA256,m.outputSHA256);
 }
});
test('public ordinary unregistered constructor preserves writes/raw getter without creating a Singleton',{skip},async()=>{
 let runs=0,lookups=0;class NoOrdinaryPool{static getInstance(){lookups++;throw Error('ordinary must not create global pool')}}
 const Level=execute(source('LevelPersist'),'LevelPersist',{DuckDBSingleton:NoOrdinaryPool,nativeRegistrationHash:createHash,NativeRegistrationDecoder:TextDecoder,nativeRegistrationTypes,unknownToError:e=>e});
 const connection={async run(sql,params){runs++;assert.match(sql,/^INSERT/);assert.equal(params[1],'value')}};
 const level=new Level(connection,'ordinary');await level.setItem(['own'],'value');assert.equal(level.connection,connection);
 assert.equal(runs,1);assert.equal(lookups,0);
});
test('existing one managed backend plus one query stays supported',{skip},async t=>{const f=await fixture(t,{count:1}),{bo,so}=await f.reserve();f.selected.checkNativeSQLAdmission(so,bo,f.registry);assert.equal(f.pool.getNativeSQLConnectionStatus().issuedConnections,2);});
test('Application two managed backends plus qualified query reserves the selected backend',{skip},async t=>{const f=await fixture(t),{bo,so}=await f.reserve();assert.equal(f.pool.getNativeSQLConnectionStatus().issuedConnections,3);f.selected.checkNativeSQLAdmission(so,bo,f.registry);assert.equal(f.pool.getNativeSQLConnectionStatus().phase,'reserved');});
test('all accepted sibling writers drain before SQL grant; neither fresh writer nor SQL pool mutation enters',{skip},async t=>{
 const f=await fixture(t),d=deferred();f.connections[1].beforeRun=sql=>sql.startsWith('INSERT')?d.promise:undefined;
 const writing=f.early.setItem(['ordinary'],'retained');await tick();let granted=false;
 const reserving=f.reserve().then(o=>{granted=true;return o;});await tick();assert.equal(granted,false);
 d.resolve();await writing;const{bo,so}=await reserving;f.selected.checkNativeSQLAdmission(so,bo,f.registry);
 const n=f.calls.length;await assert.rejects(f.early.setItem(['ordinary'],'blocked'),/HELD/);assert.equal(f.calls.length,n);assert.throws(()=>f.selected.checkNativeSQLAdmission(so,bo,f.registry));
});
test('foreign sibling owner checks refuse inertly while selected owner and pending drain survive',{skip},async t=>{
 const f=await fixture(t),d=deferred();f.connections[1].beforeRun=sql=>sql.startsWith('INSERT')?d.promise:undefined;
 const writing=f.early.setItem(['ordinary'],'accepted');await tick();const reserving=f.reserve();await tick();
 assert.throws(()=>f.early.checkNativeBackendWriteOwner({}),/REFUSED/);
 d.resolve();await writing;const{bo,so}=await reserving;
 f.selected.checkNativeSQLAdmission(so,bo,f.registry);
 for(const target of [f.early,f.selected])assert.throws(()=>target.checkNativeBackendWriteOwner({}),/REFUSED/);
 f.selected.checkNativeSQLAdmission(so,bo,f.registry);
});
test('unregistered direct attachment refuses even with legitimate selected/query actors',{skip},async t=>{const f=await fixture(t);await f.pool.attachDatabase('/OWN/UNKNOWN','unknown');await assert.rejects(f.reserve(),/HELD/);});
test('SINGLE unregistered direct attachment plus genuine query has NO native admission fallback',{skip},async t=>{
 const f=await fixture(t,{count:0}),raw=await f.pool.attachDatabase('/OWN/UNKNOWN-SINGLE','db');
 await raw.run('SELECT 1'); // Existing ordinary raw SQL still works; never native proof.
 assert.throws(()=>f.pool.reserveNativeSQLConnections(raw,'db',f.registry),/HELD/);
 assert.equal(f.pool.getNativeSQLConnectionStatus().phase,'held');
});
test('extra query is still unqualified; no arbitrary SQL actor is blessed by cardinality',{skip},async t=>{const f=await fixture(t);await f.pool.createConnection();await assert.rejects(f.reserve(),/HELD/);});
test('prior sibling raw exposure, failed write, open transaction and close deny admission',{skip},async t=>{
 for(const mode of ['raw','failed','transaction','close']) {const f=await fixture(t);
 if(mode==='raw')void f.early.connection;
 if(mode==='failed'){f.connections[1].beforeRun=()=>{throw null};await assert.rejects(f.early.setItem(['own'],'x'),e=>e===null);}
 if(mode==='transaction')await f.early.beginTransaction();
 if(mode==='close')await f.early.close();
 await assert.rejects(f.reserve(),/HELD/);
 if(mode==='transaction')await f.early.rollbackTransaction();
 }
});
test('writer attempted during accepted sibling drain holds forever, preserving its accepted completion',{skip},async t=>{
 const f=await fixture(t),d=deferred();f.connections[1].beforeRun=sql=>sql.startsWith('INSERT')?d.promise:undefined;
 const writing=f.early.setItem(['own'],'old');await tick();const reserving=f.reserve();const denied=assert.rejects(reserving,/HELD/);await tick();
 const n=f.calls.length;await assert.rejects(f.early.setItem(['new'],'new'),/HELD/);assert.equal(f.calls.length,n);
 d.resolve();await writing;await denied;await assert.rejects(f.reserve());
});
test('registry callback reentry cannot revive cohort held by sibling raw exposure',{skip},async t=>{
 const f=await fixture(t),base=f.Registry.prototype.checkNativeQueryOwner;
 f.Registry.prototype.checkNativeQueryOwner=function(...args){try{void f.early.connection}catch{}return base.apply(this,args)};
 await assert.rejects(f.reserve(),/HELD/);
});
test('prepared SQL release detects sibling drift before any opener',{skip},async t=>{
 const f=await fixture(t),{bo,so}=await f.reserve(),finish=f.pool.prepareNativeSQLRelease(so);const n=f.calls.length;
 await assert.rejects(f.early.bulkRemoveItem([['ordinary']]),/HELD/);assert.equal(f.calls.length,n);
 assert.throws(finish,/REFUSED|HELD/);assert.throws(()=>f.selected.checkNativeSQLAdmission(so,bo,f.registry));
});
test('query-first pool release opens sibling ordinary writes and rejects its stale finalizer',{skip},async t=>{
 const f=await fixture(t),{so}=await f.reserve();const finish=f.pool.prepareNativeSQLRelease(so);finish();
 // This lower-layer source test deliberately releases only the pool. Production
 // selected Level/Main release wraps this exact finalizer and clears selected state.
 await f.early.setItem(['ordinary'],'after');assert.throws(finish,/REFUSED/);
});
