'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {createLocalInstallHostAdmission,normalizeAdditionalSources}=require('./local-install-host.cjs');
const sha=v=>crypto.createHash('sha256').update(v).digest('hex');
async function fixture(t){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'external-host-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const packagePath=path.join(root,'app.asar');await fs.writeFile(packagePath,'app');
 const target='F:\\reviewed\\config.json',body=Buffer.alloc(600000,97);let version=1,externalOpens=0,reads=0,reparse=false,race=false;
 const norm=p=>path.win32.normalize(p).toLowerCase(),external=p=>/^[a-z]:[\\/]/i.test(p)&&norm(p).startsWith('f:');
 const stat=p=>({dev:1n,ino:5n,size:BigInt(body.length),mtimeNs:BigInt(version),ctimeNs:BigInt(version),isFile:()=>norm(p)===norm(target),isSymbolicLink:()=>reparse&&norm(p)===norm('F:/reviewed')});
 const disk={...fs,lstat:async(p,o)=>external(p)?stat(p):fs.lstat(p,o),open:async(p,...args)=>{if(!external(p))return fs.open(p,...args);externalOpens++;let offset=0;return{stat:async()=>stat(p),read:async(buffer)=>{reads++;const n=Math.min(buffer.length,body.length-offset);body.copy(buffer,0,offset,offset+n);offset+=n;if(race)version++;return{bytesRead:n};},close:async()=>{}};}};
 const expected={appAsarSha256:sha('app'),dynamic:[],additionalSources:[{path:target,sha256:sha(body)}]};
 const make=()=>createLocalInstallHostAdmission({packagePath,expected,api:{getLoadedExtensions:()=>[]},fsImpl:disk});
 return{make,expected,target,body,get externalOpens(){return externalOpens;},get reads(){return reads;},drift:()=>version++,reparse:()=>reparse=true,race:()=>race=true};
}
test('additional sources use chunked hash, generation cache, and copied immutable binding',async t=>{
 const f=await fixture(t),admit=f.make();f.expected.additionalSources[0].sha256='b'.repeat(64);const first=await admit();assert.equal(first.sources.length,2);assert.equal(first.sources[1].sha256,sha(f.body));assert.ok(f.reads>=4);await admit();assert.equal(f.externalOpens,1);f.drift();await admit();assert.equal(f.externalOpens,2);
});
test('external bytes drift cannot reuse a successful cached proof',async t=>{const f=await fixture(t),admit=f.make();await admit();f.body[0]=98;f.drift();await assert.rejects(admit(),/SOURCE_HASH_MISMATCH/);});
test('external generation race during hashing refuses admission',async t=>{const f=await fixture(t);f.race();await assert.rejects(f.make()(),/SOURCE_CHANGED/);});
test('external source ancestor reparse refuses admission',async t=>{const f=await fixture(t);f.reparse();await assert.rejects(f.make()(),/REPARSE_PATH/);});
for(const value of [null,{},[{path:'relative',sha256:'a'.repeat(64)}],[{path:'//server/a',sha256:'a'.repeat(64)}],[{path:'F:/a/../b',sha256:'a'.repeat(64)}],[{path:'F:/a:ads',sha256:'a'.repeat(64)}],[{path:'F:/a',sha256:'bad'}],[{path:'F:/a',sha256:'a'.repeat(64),request:true}],[{path:'F:/a',sha256:'a'.repeat(64)},{path:'f:/A',sha256:'a'.repeat(64)}]])test('strict additional source input rejects '+JSON.stringify(value),()=>assert.throws(()=>normalizeAdditionalSources(value),/BINDING_INVALID/));
test('omitted legacy additional sources remain empty',()=>assert.deepEqual(normalizeAdditionalSources(undefined),[]));
