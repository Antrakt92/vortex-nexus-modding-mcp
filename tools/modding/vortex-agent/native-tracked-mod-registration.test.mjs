import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { TextDecoder, types as nativeRegistrationTypes } from 'node:util';
import { repo, stage, sha, prepared, execute, parsed, deferred, tick } from './native-query-source-admission.test.mjs';
import { registrationBackend } from './native-owned-mod-registration.test.mjs';

const stages = ['new-mod-conflict-query','backend-write-admission','native-backend-sql-admission','native-owned-mod-registration','native-tracked-mod-registration'];
export const trackedRequest = overrides => ({ schema:'native-tracked-mod-registration-request/2',
  operationId:'op_'+'1'.repeat(32),nativeJobId:'exec_'+'2'.repeat(32),requestSHA256:'3'.repeat(64),planId:'4'.repeat(64),
  gameId:'game',modId:'new',installationPath:'new',payloadSHA256:'5'.repeat(64),
  archive:{id:'archive',state:'finished',game:['game'],localPath:'own.zip',size:100,fileMD5:'6'.repeat(32),archiveSHA256:'7'.repeat(64)},...overrides });
export const trackedBytes = overrides => Buffer.from(JSON.stringify(trackedRequest(overrides)));
const base='persistent###downloads###files###archive';
export function downloadRows(archive=trackedRequest().archive) {
  return ['state','game','localPath','size','fileMD5'].map(key=>[base+'###'+key,JSON.stringify(archive[key])]);
}
export async function trackedBackend(t, options={}) {
  const f=await registrationBackend(t,{main:true}), committed=new Map(options.seed??downloadRows()),calls=[];
  let txn=null;
  f.backend.run=async(sql,params)=>{
    calls.push({sql,params:params?structuredClone(params):undefined});await options.before?.(sql,params);
    if(sql==='BEGIN TRANSACTION'){assert.equal(txn,null);txn=new Map(committed);}
    else if(sql.startsWith('INSERT INTO')){assert(txn);assert([10,16].includes(params.length));for(let n=0;n<params.length;n+=2)txn.set(params[n],params[n+1]);}
    else if(sql==='COMMIT'){assert(txn);committed.clear();for(const pair of txn)committed.set(...pair);txn=null;}
    else if(sql==='ROLLBACK')txn=null;
    await options.after?.(sql,params);
  };
  f.backend.runAndReadAll=async(sql,params)=>{
    calls.push({sql,params:structuredClone(params)});await options.read?.(sql,params);
    const data=txn??committed;
    let rows;
    if(sql.includes('SELECT 1 FROM keys'))rows=options.targetConflict?[[1]]:[];
    else if(sql.includes('CASE WHEN key IN')) {
      const allowed=new Set(params.slice(1));
      rows=[...data].filter(([key])=>key===base||key==='persistent###downloads'||key==='persistent###downloads###files'
        ||[...allowed].some(k=>key===k||key.startsWith(k+'###'))||key===base+'###installed'||key.startsWith(base+'###installed###'))
        .map(([key,value])=>[key,allowed.has(key)?value:null]).slice(0,8);
    } else if(sql.startsWith('SELECT DISTINCT CASE')) {
      rows=[...new Set([...data.keys()].filter(key=>key.startsWith('persistent###downloads###files###')).map(key=>key.split('###')[3]))].map(id=>[id]);
    } else if(sql.includes('length(key)<=512')) {
      rows=options.globalRows??[...data].filter(([key])=>{
        const p=key.split('###');
        return p[0]==='persistent'&&((p[1]==='mods'&&(p.length<=4||['archiveId','fileMD5'].includes(p[4])||(p[4]==='attributes'&&(p.length===5||p[5]==='fileMD5'))))
          ||(p[1]==='downloads'&&p[2]==='files'&&(p.length<=4||['fileMD5','localPath'].includes(p[4]))));
      }).slice(0,40001);
    } else {
      const wanted=new Set(params.slice(4));
      rows=[...data].filter(([key])=>key.startsWith('persistent###mods###game###new###')||wanted.has(key)
        ||key===base||key===base+'###installed'||key.startsWith(base+'###installed###'));
      rows=options.readback?.(rows)??rows;
    }
    return {getRows:()=>rows};
  };
  const compiled=execute(prepared(stages),'({LevelPersist,snapshotNativeNewModRegistration,snapshotNativeTrackedModRegistration})',{
    DuckDBSingleton:f.Singleton,nativeRegistrationHash:createHash,NativeRegistrationDecoder:TextDecoder,nativeRegistrationTypes,unknownToError:e=>e,
  });
  const level=new compiled.LevelPersist(f.backend,'db');
  const result={...f,...compiled,level,committed,calls,transaction:()=>txn};
  if(options.main)return result;
  const query=await f.pool.createConnection(),registry=new f.Registry(query);await registry.initialize(parsed(f.root),f.root);
  const backendOwner=await level.reserveNativeBackendWrites(),sqlOwner=level.reserveNativeSQLAdmission(backendOwner,registry);
  return {...result,registry,backendOwner,sqlOwner,
    register:bytes=>level.registerNativeTrackedMod(backendOwner,sqlOwner,registry,bytes??trackedBytes())};
}
const integration=(name,fn)=>test(name,{timeout:10000,skip:repo?false:'Set VORTEX_EXTENSION_ADMISSION_REPO'},fn);

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
test('tracked artifacts remain exact pinned prepared projection only',()=>{
  for(const name of ['native-tracked-mod-registration','native-main-tracked-mod-registration']){
    const{m,patch}=stage(name);assert.equal(sha(patch),m.patchSHA256);
    for(const key of ['installed','nativeAcceptanceVerified','installationPermit','powerLossPersistenceVerified','releaseSupported','trackedInstallComplete','archiveProofBindingVerified'])assert.equal(m[key],false);
  }
  const main=stage('native-main-tracked-mod-registration').m,level=stage('native-tracked-mod-registration').m;
  assert.equal(main.requiredCompanionPatchSHA256,level.patchSHA256);assert.equal(main.requiredCompanionOutputSHA256,level.outputSHA256);
});
integration('exact predecessor v1 cannot register a tracked archive descriptor',async t=>{
  const previous=await registrationBackend(t);
  assert.equal(typeof previous.level.registerNativeTrackedMod,'undefined');
  await assert.rejects(previous.register(trackedBytes()),/NATIVE_REGISTRATION_REQUEST/);
  assert.equal(previous.sqlCalls.length,0);
});
integration('actual v2 writes eight derived rows and preserves five source leaves, no fabricated download id',async t=>{
  const f=await trackedBackend(t),result=await f.register();
  assert.equal(result.schema,'native-tracked-mod-registration-observed/2');assert.equal(result.trackedAssociationVerified,true);
  for(const k of ['trackedInstallComplete','effectsAllowed','installationPermit','powerLossPersistenceVerified'])assert.equal(result[k],false);
  assert.equal(f.committed.size,13);assert.equal(f.committed.has(base+'###id'),false);
  assert.equal(f.committed.get(base+'###installed###gameId'),'"game"');assert.equal(f.committed.get(base+'###installed###modId'),'"new"');
  assert.equal(f.committed.get('persistent###mods###game###new###archiveId'),'"archive"');
  for(const pair of downloadRows())assert.equal(f.committed.get(pair[0]),pair[1]);
  const record=JSON.parse(result.recordJSON),marker=record.attributes.__nmtNativeRegistration;
  assert.equal(record.archiveId,'archive');assert.equal(marker.archiveSHA256,'7'.repeat(64));assert.equal(marker.payloadSHA256,'5'.repeat(64));
  assert.equal(marker.downloadProjectionSHA256,sha(JSON.stringify(trackedRequest().archive)));
  assert.equal(result.fullRecordSHA256,sha(result.recordJSON));
  assert.equal(result.recordSHA256,sha(JSON.stringify({id:'new',state:'installed',type:'',installationPath:'new',archiveId:'archive'})));
  assert.equal(f.calls[0].sql,'BEGIN TRANSACTION');assert(f.calls.findIndex(c=>c.sql.includes('CASE WHEN key IN'))<f.calls.findIndex(c=>c.sql.startsWith('INSERT')));
  await assert.rejects(f.register(),/REFUSED/);
});
integration('matching optional persisted download id is preserved; wrong id refuses',async t=>{
  const f=await trackedBackend(t,{seed:[...downloadRows(),[base+'###id','"archive"']]});await f.register();assert.equal(f.committed.size,14);
  const wrong=await trackedBackend(t,{seed:[...downloadRows(),[base+'###id','"other"']]});await assert.rejects(wrong.register(),/ARCHIVE_CONFLICT/);assert.equal(wrong.calls.some(c=>c.sql.startsWith('INSERT')),false);
});
integration('canonical v2 refuses wrong shape/extra fields/duplicates/whitespace without BEGIN',async t=>{
  const archive=trackedRequest().archive;
  const bad=[Buffer.from(' '+trackedBytes()),Buffer.from(trackedBytes().toString().replace('"size":100','"size":100,"size":100')),
    trackedBytes({archive:{...archive,extra:true}}),trackedBytes({archive:{...archive,game:['game','other']}}),
    trackedBytes({archive:{...archive,size:0}}),trackedBytes({archive:{...archive,localPath:'../own.zip'}}),
    trackedBytes({archive:{...archive,localPath:'NUL.zip'}}),trackedBytes({archive:{...archive,fileMD5:'bad'}}),
    trackedBytes({archive:{...archive,archiveSHA256:'bad'}}),trackedBytes({archive:{...archive,state:'paused'}}),
    Buffer.from([255]),trackedBytes({archiveId:'archive'})];
  for(const bytes of bad){const f=await trackedBackend(t);await assert.rejects(f.register(bytes));assert.equal(f.calls.length,0);}
});
integration('each mismatched or missing persisted source field refuses inside owned transaction',async t=>{
  for(const key of ['state','game','localPath','size','fileMD5'])for(const missing of [false,true]){
    const seed=downloadRows().filter(([p])=>!missing||p!==base+'###'+key).map(([p,v])=>[p,p===base+'###'+key&&!missing?'null':v]);
    const f=await trackedBackend(t,{seed});await assert.rejects(f.register(),/ARCHIVE_CONFLICT/);
    assert.equal(f.calls.filter(c=>c.sql==='ROLLBACK').length,1);assert.equal(f.calls.some(c=>c.sql.startsWith('INSERT')),false);
  }
});
integration('any installed marker and ancestor/blob or nested source representation refuses',async t=>{
  for(const [key,value] of [[base+'###installed','null'],[base+'###installed###modId','"old"'],[base,'{}'],
    ['persistent###downloads','{}'],['persistent###downloads###files','{}'],[base+'###game###0','"game"']]){
    const f=await trackedBackend(t,{seed:[...downloadRows(),[key,value]]});await assert.rejects(f.register(),/ARCHIVE_CONFLICT/);
    assert.equal(f.calls.some(c=>c.sql.startsWith('INSERT')),false);
  }
});
integration('global archive references/MD5 matches and duplicate filenames or hashes refuse',async t=>{
  for(const row of [ ['persistent###mods###other###old###archiveId','"archive"'],
    ['persistent###mods###other###old###attributes###fileMD5',JSON.stringify('6'.repeat(32))],
    ['persistent###mods###other###old###fileMD5',JSON.stringify('6'.repeat(32))],
    ['persistent###downloads###files###other###fileMD5',JSON.stringify('6'.repeat(32))],
    ['persistent###downloads###files###other###localPath','"OWN.ZIP"'],
    ['persistent###mods###other###old','{}'],['persistent###mods###other###old###attributes','{}'] ]){
    const f=await trackedBackend(t,{seed:[...downloadRows(),row]});await assert.rejects(f.register(),/ARCHIVE_CONFLICT/);
    assert.equal(f.calls.some(c=>c.sql.startsWith('INSERT')),false);
  }
});
integration('unrelated references and filenames continue while global projection bounds fail closed',async t=>{
  const f=await trackedBackend(t,{seed:[...downloadRows(),['persistent###mods###other###old###archiveId','"different"'],['persistent###downloads###files###other###localPath','"other.zip"'],['persistent###downloads###files###other###fileMD5',JSON.stringify('a'.repeat(32))]]});await f.register();
  const excessive=await trackedBackend(t,{globalRows:Array.from({length:40001},()=>['x','"y"'])});await assert.rejects(excessive.register(),/ARCHIVE_LIMIT/);
});
integration('incomplete or malformed global hash projections cannot prove no duplicate archive',async t=>{
  for(const row of [['persistent###downloads###files###other###localPath','"other.zip"'],
    ['persistent###downloads###files###other###state','"finished"'],
    ['persistent###mods###other###old###attributes###fileMD5','"bad"']]){
    const f=await trackedBackend(t,{seed:[...downloadRows(),row]});await assert.rejects(f.register(),/ARCHIVE_CONFLICT/);
    assert.equal(f.calls.some(c=>c.sql.startsWith('INSERT')),false);
  }
});
integration('target/profile absence remains mandatory before archive lookup',async t=>{
  const f=await trackedBackend(t,{targetConflict:true});await assert.rejects(f.register(),/REGISTRATION_CONFLICT/);
  assert.equal(f.calls.some(c=>c.sql.includes('CASE WHEN key IN')),false);
});
integration('request bytes detach before BEGIN; actual late source drift refuses',async t=>{
  const d=deferred(),f=await trackedBackend(t,{before:sql=>sql==='BEGIN TRANSACTION'?d.promise:undefined}),bytes=trackedBytes(),write=f.register(bytes);
  bytes.fill(0);f.committed.set(base+'###fileMD5',JSON.stringify('a'.repeat(32)));d.resolve();await assert.rejects(write,/ARCHIVE_CONFLICT/);
  const g=await trackedBackend(t),saved=trackedBytes(),write2=g.register(saved);saved.fill(0);assert.equal((await write2).requestSHA256,'3'.repeat(64));
});
integration('INSERT failure rolls back both associations and preserves Error/null/undefined primary',async t=>{
  for(const primary of [Error('write'),null,undefined]){
    const f=await trackedBackend(t,{after:sql=>{if(sql.startsWith('INSERT'))return Promise.reject(primary);}});
    await assert.rejects(f.register(),e=>e===primary);assert.deepEqual([...f.committed],downloadRows());
    assert.equal(f.level.getNativeBackendWriteStatus().nativeRegistrationTransaction,'rolled_back');
  }
});
integration('actual committed state with lost acknowledgement is held without rollback or replay',async t=>{
  const primary=Error('lost'),f=await trackedBackend(t,{after:sql=>{if(sql==='COMMIT')throw primary;}});
  await assert.rejects(f.register(),e=>e===primary);assert.equal(f.committed.size,13);
  assert.equal(f.level.getNativeBackendWriteStatus().nativeRegistrationTransaction,'unknown');
  assert.equal(f.calls.some(c=>c.sql==='ROLLBACK'),false);await assert.rejects(f.register(),/REFUSED/);
});
integration('readback must include exact eight writes plus unchanged source leaves',async t=>{
  for(const mutate of [rows=>rows.filter(([p])=>p!==base+'###installed###modId'),rows=>rows.map(([p,v])=>[p,p===base+'###size'?'101':v]),
    rows=>[...rows,[base+'###installed###extra','true']]]){
    const f=await trackedBackend(t,{readback:mutate});await assert.rejects(f.register(),/READBACK/);
    assert.equal(f.committed.size,13);assert.equal(f.calls.some(c=>c.sql==='ROLLBACK'),false);
  }
});
integration('concurrent ordinary writer poisons owned transaction and joins rollback; checker alone does not',async t=>{
  const d=deferred(),f=await trackedBackend(t,{read:sql=>sql.includes('CASE WHEN key IN')?d.promise:undefined}),write=f.register();
  await tick();f.level.checkNativeNewModRegistration(f.backendOwner,f.sqlOwner,f.registry);
  await assert.rejects(f.level.setItem(['own'],'"bad"'),/OWNS_CONNECTION/);d.resolve();await assert.rejects(write,/HELD/);
  assert.deepEqual([...f.committed],downloadRows());
});
}
