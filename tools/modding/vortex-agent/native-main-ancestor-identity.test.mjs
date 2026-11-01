// Maintained graph source acceptance. Actual Main AST helpers; filesystem results are facades.
// No Main instance, SDK import, process, database, journal or real FS mutation.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {createHash} from 'node:crypto';
import {createRequire,stripTypeScriptTypes} from 'node:module';
import {types} from 'node:util';
import {assembleNativeSources,NATIVE_SOURCE_PATHS} from './native-source-series.mjs';
import {nativePromiseFixturesAvailable,nativePromiseFixtureReason} from './native-promise-source-fixture.mjs';
if(process.env.VORTEX_NATIVE_ANCESTOR_REQUIRED==='1')assert(nativePromiseFixturesAvailable,nativePromiseFixtureReason);
if(!nativePromiseFixturesAvailable){
  test('native Main ancestor source acceptance inputs',{skip:nativePromiseFixtureReason},()=>{});
}else{
const originalRoot=process.env.VORTEX_NATIVE_SOURCE_ROOT,dependencyRoot=process.env.VORTEX_CAPSULE_BUILD_SOURCE;
assert(path.isAbsolute(originalRoot)&&path.isAbsolute(dependencyRoot),'explicit absolute reviewed source inputs');
const sha=b=>createHash('sha256').update(b).digest('hex');
const input=Object.fromEntries(NATIVE_SOURCE_PATHS.map(file=>[file,new Uint8Array(fs.readFileSync(path.join(originalRoot,file)))]));
const assembled=assembleNativeSources(input);
assert.equal(assembled.receipt.patches.length,132);assert.equal(assembled.receipt.sources.length,26);
assert.equal(assembled.receipt.nativeAdmission,false);assert.equal(assembled.receipt.effectsAllowed,false);
const file='src/main/src/store/mainPersistence.ts',expected='0b7ccab43cd949aac9e13b19344254a7d00f6884eb39c4234d940a46849e7b7d';
assert.equal(assembled.receipt.sources.find(row=>row.path===file)?.finalSHA256,expected,'maintained final Main source');
const sourceRaw=assembled.sources[file];assert.equal(sha(sourceRaw),expected);
const require=createRequire(path.join(dependencyRoot,'package.json')),tsPath=require.resolve('typescript');
assert.equal(sha(fs.readFileSync(tsPath)),'569177652966bd528c319171c7dd22860dbf72bde116cbc4f644f1d02bb12e39');
const ts=require(tsPath),source=Buffer.from(sourceRaw).toString(),ast=ts.createSourceFile('actual-Main.ts',source,ts.ScriptTarget.Latest,true);
const wanted=new Set(['nativeStartupError','nativeStartupStamp','nativeStartupAncestry','nativeStartupSame']);
const selected=ast.statements.filter(n=>ts.isFunctionDeclaration(n)&&wanted.has(n.name?.text)
  ||ts.isVariableStatement(n)&&n.declarationList.declarations.some(d=>wanted.has(d.name.getText(ast))));
assert.equal(selected.length,4);
const code=stripTypeScriptTypes(selected.map(n=>n.getText(ast)).join('\n'),{mode:'transform'});
const win=path.win32,target=win.resolve('X:/fixture/own/journal');
const parents=['X:\\','X:\\fixture','X:\\fixture\\own'];
function fixture(){
  const nodes=new Map([...parents,target].map((name,i)=>[name,{dev:7n,ino:BigInt(100+i),size:0n,mtimeNs:10n,ctimeNs:20n,nlink:1n,dir:true,link:false}]));
  const failures=new Map(),seen=[];
  const io={lstatSync(name,options){assert.equal(options.bigint,true);const key=win.resolve(name);seen.push(key);
    if(failures.has(key))throw failures.get(key);
    const n=nodes.get(key);if(!n)throw Object.assign(new Error('own missing'),{code:'ENOENT'});
    return {...n,isDirectory:()=>n.dir,isSymbolicLink:()=>n.link};}};
  const context=vm.createContext({nativeStartupFS:io,nativeStartupTypes:types,path:win});
  vm.runInContext(code+'\nglobalThis.actual={read:nativeStartupAncestry,same:nativeStartupSame,stamp:nativeStartupStamp};',context);
  return{nodes,failures,seen,read:(missing=false)=>context.actual.read(target,missing),
    same:(a,b)=>context.actual.same(a.pins,b.pins),stamp:n=>context.actual.stamp(n),
    raw:(value,missing=false)=>context.actual.read(value,missing)};
}
function throwsSame(action,primary){let caught=false;try{action();}catch(error){caught=true;assert.equal(error,primary);}assert.equal(caught,true);}

test('actual ancestor helper tolerates unrelated shared-parent timestamps without accepting changed identity',()=>{
  const f=fixture(),before=f.read();for(const name of parents){const n=f.nodes.get(name);n.mtimeNs+=6000000n;n.ctimeNs+=6000000n;n.size=128n;n.nlink=2n;}
  const after=f.read();assert.equal(after.present,true);assert.doesNotThrow(()=>f.same(before,after));
});
test('missing journal keeps ordinary-parent identity stable across unrelated timestamp changes',()=>{
  const f=fixture();f.nodes.delete(target);const before=f.read(true);assert.equal(before.present,false);
  f.nodes.get(parents[2]).mtimeNs++;f.nodes.get(parents[2]).ctimeNs++;
  assert.equal(f.read(true).present,false);assert.doesNotThrow(()=>f.same(before,f.read(true)));
});
test('every parent inode or volume identity replacement remains a HOLD',()=>{
  for(const name of parents)for(const field of['ino','dev']){const f=fixture(),before=f.read();f.nodes.get(name)[field]++;assert.throws(()=>f.same(before,f.read()),/NATIVE_EXECUTOR_STARTUP_HOLD/);}
});
test('every existing component must remain an ordinary non-symlink directory',()=>{
  for(const name of[...parents,target])for(const field of['dir','link']){const f=fixture();f.nodes.get(name)[field]=field==='link';
    assert.throws(()=>f.read(true),/NATIVE_EXECUTOR_STARTUP_HOLD/);}
});
test('exact journal leaf retains all six generation fields',()=>{
  for(const field of['dev','ino','size','mtimeNs','ctimeNs','nlink']){const f=fixture(),before=f.read();f.nodes.get(target)[field]++;
    assert.throws(()=>f.same(before,f.read()),/NATIVE_EXECUTOR_STARTUP_HOLD/);}
});
test('unchanged full leaf stamp and all ordinary components remain visible',()=>{
  const f=fixture(),read=f.read();assert.equal(read.pins.get(target),'7:103:0:10:20:1');assert.equal(read.pins.size,4);
  assert.equal(JSON.stringify(f.seen),JSON.stringify([...parents,target]));assert.equal(f.stamp(f.nodes.get(target)),'7:103:0:10:20:1');
});
test('existing exact volume-root target also retains full stamp',()=>{
  const f=fixture(),before=f.raw('X:/');f.nodes.get('X:\\').mtimeNs++;assert.throws(()=>f.same(before,f.raw('X:/')),/NATIVE_EXECUTOR_STARTUP_HOLD/);
});
test('only own ordinary ENOENT with missingAllowed yields absence',()=>{
  const f=fixture(),primary=Object.assign(new Error('own absent'),{code:'ENOENT'});f.failures.set(target,primary);
  assert.equal(f.read(true).present,false);throwsSame(()=>f.read(false),primary);
});
test('EACCES is never treated as missing',()=>{
  for(const missing of[true,false]){const f=fixture(),primary=Object.assign(new Error('own inaccessible'),{code:'EACCES'});f.failures.set(target,primary);throwsSame(()=>f.read(missing),primary);}
});
test('null and undefined filesystem primaries stay exact',()=>{
  for(const primary of[null,undefined])for(const missing of[true,false]){const f=fixture();f.failures.set(target,primary);throwsSame(()=>f.read(missing),primary);}
});
test('code accessors and inherited ENOENT do not create absence or invoke getters',()=>{
  let gets=0;const accessor=Object.defineProperty({},'code',{get(){gets++;return'ENOENT';}});
  const inherited=Object.create({code:'ENOENT'});
  for(const primary of[accessor,inherited]){const f=fixture();f.failures.set(target,primary);throwsSame(()=>f.read(true),primary);}
  assert.equal(gets,0);
});
test('proxy filesystem errors are refused without proxy property traps',()=>{
  let traps=0;const primary=new Proxy({code:'ENOENT'},{get(){traps++;throw Error('trap');},getOwnPropertyDescriptor(){traps++;throw Error('trap');}});
  const f=fixture();f.failures.set(target,primary);throwsSame(()=>f.read(true),primary);assert.equal(traps,0);
});
test('appearing or disappearing journal cannot match an old ancestry observation',()=>{
  const f=fixture(),present=f.read(),node=f.nodes.get(target);f.nodes.delete(target);const absent=f.read(true);
  assert.equal(absent.present,false);assert.throws(()=>f.same(present,absent),/NATIVE_EXECUTOR_STARTUP_HOLD/);
  f.nodes.set(target,node);assert.throws(()=>f.same(absent,f.read()),/NATIVE_EXECUTOR_STARTUP_HOLD/);
});
test('newly appearing missing intermediate parent changes the observation census',()=>{
  const f=fixture(),node=f.nodes.get(parents[2]);f.nodes.delete(parents[2]);f.nodes.delete(target);const before=f.read(true);
  f.nodes.set(parents[2],node);const after=f.read(true);assert.equal(after.present,false);assert.throws(()=>f.same(before,after),/NATIVE_EXECUTOR_STARTUP_HOLD/);
});

}
