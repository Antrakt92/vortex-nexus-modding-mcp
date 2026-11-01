import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {buildNodeSDKBootstrap} from './native-sdk-node-bootstrap.mjs';

const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const tick=()=>new Promise(r=>setImmediate(r));
const standin=Buffer.from("process.stdout.write('OWN_STANDIN_READY\\n');process.stdin.on('data',b=>process.stdout.write('ECHO:'+b.toString()));process.stdin.on('end',()=>{process.stdout.write('DONE\\n');});");
function ownNode(t,built){
 const env={};if(process.env.SystemRoot!==undefined)env.SystemRoot=process.env.SystemRoot;
 const child=spawn(process.execPath,['-e',built.bootstrap],{windowsHide:true,env,stdio:['pipe','pipe','pipe']});
 let stdout='',stderr='',closed=false;const pipes={stdin:false,stdout:false,stderr:false};
 for(const name of Object.keys(pipes))child[name].on('close',()=>{pipes[name]=true;});
 child.stdin.on('error',()=>{});
 child.stdout.on('data',b=>{stdout+=b.toString();if(stdout.length>65536)child.kill();});
 child.stderr.on('data',b=>{stderr+=b.toString();if(stderr.length>65536)child.kill();});
 const terminal=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>{closed=true;resolve({code,signal,stdout,stderr,pipes:{...pipes}});});});
 const wait=async token=>{
  const until=Date.now()+4000;while(!stdout.includes(token)){if(closed)throw Error('Own standin closed before '+token+': '+stderr);if(Date.now()>=until)throw Error('Own standin wait timeout');await new Promise(r=>setTimeout(r,5));}
 };
 t.after(async()=>{
  if(!closed){child.stdin.end();await Promise.race([terminal,new Promise(r=>setTimeout(r,250))]);}
  if(!closed){child.kill();await Promise.race([terminal,new Promise((_,reject)=>setTimeout(()=>reject(Error('Own Node did not close')),2000))]);}
 });
 return{child,terminal,wait,text:()=>({stdout,stderr}),send:b=>child.stdin.write(b),end:b=>child.stdin.end(b)};
}
const options={timeout:10000};

test('trusted build bytes become immutable closed strings with both digests baked and no source in argv',()=>{
 const source=Buffer.from(standin),built=buildNodeSDKBootstrap(source);source.fill(0);
 assert(Object.isFrozen(built));assert.deepEqual(Object.keys(built),['bootstrap','envelope','codeSHA256']);assert.equal(built.codeSHA256,sha(standin));
 assert.equal(Buffer.byteLength(built.bootstrap)<=16384,true);const envelope=JSON.parse(built.envelope);assert.deepEqual(Object.keys(envelope),['schema','code']);assert.equal(envelope.schema,'native-sdk-node-capsule/1');assert.equal(envelope.code,standin.toString('base64'));
 assert(built.bootstrap.includes(sha(Buffer.from(built.envelope))));assert(built.bootstrap.includes(built.codeSHA256));assert(!built.bootstrap.includes(standin.toString()));assert(!built.bootstrap.includes(envelope.code));assert(!built.envelope.includes('\n'));
});

test('invalid byte carriers refuse without getter/proxy/coercion callbacks or shared backing',()=>{
 let reads=0;const getter=Buffer.from(standin);Object.defineProperty(getter,'byteLength',{get(){reads++;throw Error('must not read');}});
 const coercion=Buffer.from(standin);Object.defineProperty(coercion,Symbol.toPrimitive,{get(){reads++;throw Error('must not coerce');}});
 const proxy=new Proxy(Buffer.from(standin),{get(){reads++;throw Error('must not get');},getPrototypeOf(){reads++;throw Error('must not reflect');}});
 const custom=Buffer.from(standin);Object.setPrototypeOf(custom,{});
 const resizable=Buffer.from(new ArrayBuffer(16,{maxByteLength:32}));
 for(const input of [undefined,'code',new Uint8Array([1]),Buffer.alloc(0),Buffer.alloc(2097153),Buffer.from(new SharedArrayBuffer(32)),getter,coercion,proxy,custom,resizable,Buffer.from([255]),Buffer.from([239,187,191,49])])assert.throws(()=>buildNodeSDKBootstrap(input));
 assert.equal(reads,0);assert.throws(()=>buildNodeSDKBootstrap(Buffer.from('1'),true));
});

test('actual own Node waits for one complete LF envelope, then preserves all three pipes for normal controls',options,async t=>{
 const built=buildNodeSDKBootstrap(standin),f=ownNode(t,built),middle=Math.floor(built.envelope.length/2);
 f.send(built.envelope.slice(0,middle));await new Promise(r=>setTimeout(r,40));assert.equal(f.text().stdout,'');
 f.send(built.envelope.slice(middle)+'\n');await f.wait('OWN_STANDIN_READY\n');f.end('hello\n');const r=await f.terminal;
 assert.equal(r.code,0);assert.equal(r.signal,null);assert(r.stdout.includes('ECHO:hello\n'));assert(r.stdout.endsWith('DONE\n'));assert.equal(r.stderr,'');assert.deepEqual(r.pipes,{stdin:true,stdout:true,stderr:true});
});

test('byte-at-a-time header/frame fragmentation never evaluates before the final LF',options,async t=>{
 const built=buildNodeSDKBootstrap(Buffer.from("process.stdout.write('OWN_STANDIN_READY\\n');process.stdin.resume();")),f=ownNode(t,built);
 for(const ch of built.envelope)f.send(ch);await tick();assert.equal(f.text().stdout,'');f.send('\n');await f.wait('OWN_STANDIN_READY');f.end();assert.equal((await f.terminal).code,0);
});

test('same-chunk control tail refuses before any code or READY',options,async t=>{
 const built=buildNodeSDKBootstrap(standin),f=ownNode(t,built);f.end(built.envelope+'\nSTART\n');const r=await f.terminal;
 assert.equal(r.code,65);assert.equal(r.stdout,'');assert.equal(r.stderr,'Native SDK capsule refused.\n');assert.deepEqual(r.pipes,{stdin:true,stdout:true,stderr:true});
});

test('truncated EOF and controls in place of a capsule are finite pre-evaluation failures',options,async t=>{
 const built=buildNodeSDKBootstrap(standin);
 for(const frame of ['',built.envelope,built.envelope.slice(0,17),'START\n','{"command":"start"}\n']){
  const f=ownNode(t,built);f.end(frame);const r=await f.terminal;assert.equal(r.code,65);assert.equal(r.stdout,'');assert.equal(r.stderr,'Native SDK capsule refused.\n');
 }
});

test('wrong code/digest, noncanonical JSON/base64 and extra fields cannot authenticate an envelope',options,async t=>{
 const built=buildNodeSDKBootstrap(standin),value=JSON.parse(built.envelope);
 for(const frame of [JSON.stringify({...value,code:Buffer.from("throw Error('not admitted')").toString('base64')}),JSON.stringify({...value,code:value.code+' '}),JSON.stringify({...value,extra:true}),JSON.stringify({code:value.code,schema:value.schema}),' '+built.envelope,JSON.stringify(value,null,2)]){
  const f=ownNode(t,built);f.end(frame+'\n');const r=await f.terminal;assert.equal(r.code,65);assert.equal(r.stdout,'');assert.equal(r.stderr,'Native SDK capsule refused.\n');
 }
});

test('oversize input refuses without code evaluation or waiting for EOF',options,async t=>{
 const f=ownNode(t,buildNodeSDKBootstrap(standin));f.send(Buffer.alloc(4194305,65));const r=await f.terminal;assert.equal(r.code,65);assert.equal(r.stdout,'');assert.equal(r.stderr,'Native SDK capsule refused.\n');
});

test('fixed require admits SDK builtins and the compiler url alias but never resolves paths or packages',options,async t=>{
 const good=ownNode(t,buildNodeSDKBootstrap(Buffer.from("if(!require('node:fs')||!require('url'))throw Error('missing builtin');process.stdout.write('OWN_STANDIN_READY\\n');process.stdin.resume();")));
 good.send(buildNodeSDKBootstrap(Buffer.from("if(!require('node:fs')||!require('url'))throw Error('missing builtin');process.stdout.write('OWN_STANDIN_READY\\n');process.stdin.resume();")).envelope+'\n');await good.wait('OWN_STANDIN_READY');good.end();assert.equal((await good.terminal).code,0);
 for(const id of ['./not-admitted.cjs','C:/not-admitted.cjs','fs','node:module','some-package']){const built=buildNodeSDKBootstrap(Buffer.from(`require(${JSON.stringify(id)});process.stdout.write('unexpected');`)),f=ownNode(t,built);f.end(built.envelope+'\n');const r=await f.terminal;assert.equal(r.code,1);assert.equal(r.stdout,'');assert(r.stderr.includes('NATIVE_SDK_CAPSULE_REQUIRE_REFUSED'));assert(!r.stderr.includes('MODULE_NOT_FOUND'));}
});

test('runtime ESM import has no filesystem-loader callback',options,async t=>{
 const built=buildNodeSDKBootstrap(Buffer.from("import('node:fs').then(()=>process.stdout.write('unexpected'),e=>{process.stderr.write(e.code+'\\n');process.exitCode=66;});")),f=ownNode(t,built);f.end(built.envelope+'\n');const r=await f.terminal;assert.equal(r.code,66);assert.equal(r.stdout,'');assert(r.stderr.includes('ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING'));
});

test('runner syntax and primary runtime errors reach ordinary Node failure instead of capsule refusal',options,async t=>{
 for(const code of ["throw Error('OWN_RUNNER_PRIMARY');",'const = invalid;']){const built=buildNodeSDKBootstrap(Buffer.from(code)),f=ownNode(t,built);f.end(built.envelope+'\n');const r=await f.terminal;assert.equal(r.code,1);assert.equal(r.stdout,'');assert(!r.stderr.includes('Native SDK capsule refused.'));assert(r.stderr.includes(code.startsWith('throw')?'OWN_RUNNER_PRIMARY':'SyntaxError'));}
});

test('synthetic CJS diagnostics are fixed and no automatic control or START is emitted',options,async t=>{
 const code=Buffer.from("process.stdout.write(JSON.stringify({filename:__filename,directory:__dirname,paths:module.paths})+'\\n');process.stdin.resume();"),built=buildNodeSDKBootstrap(code),f=ownNode(t,built);f.end(built.envelope+'\n');const r=await f.terminal;assert.equal(r.code,0);assert.deepEqual(JSON.parse(r.stdout),{filename:'C:/__nmt_native_capsule__/relay.cjs',directory:'C:/__nmt_native_capsule__',paths:[]});assert.equal(r.stderr,'');
});

test('the exact two MiB code boundary authenticates without recursive-regexp stack failure',options,async t=>{
 const head=Buffer.from("process.stdout.write('OWN_STANDIN_READY\\n');process.stdin.resume();"),code=Buffer.concat([head,Buffer.alloc(2097152-head.length,32)]),built=buildNodeSDKBootstrap(code),f=ownNode(t,built);
 f.end(built.envelope+'\n');const r=await f.terminal;assert.equal(r.code,0);assert.equal(r.stdout,'OWN_STANDIN_READY\n');assert.equal(r.stderr,'');
});
