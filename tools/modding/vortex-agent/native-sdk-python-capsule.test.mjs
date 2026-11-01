import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {spawn, spawnSync} from 'node:child_process';
import {captureNativeSDKSources, NATIVE_SDK_SOURCE_NAMES} from './native-sdk-capture.mjs';
import {buildPythonSDKCapsule} from './native-sdk-python-capsule.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PYTHON = process.env.NATIVE_SDK_CAPSULE_TEST_PYTHON || 'C:/Python314/python.exe';
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const names = ['owned-zip-worker.py','owned-file-transfer.py','owned-zip-extractor.py'];
function fixture(t, modify = (_, b) => b) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'python-capsule-build-'));
  t.after(() => fs.rmSync(root,{recursive:true,force:true}));
  const pins = {}, raw = {};
  for (const n of NATIVE_SDK_SOURCE_NAMES) {
    const b = modify(n, n.endsWith('.py') ? fs.readFileSync(path.join(HERE,n)) : Buffer.from('// inert capture-only JS\n'));
    raw[n] = b; pins[n] = sha(b); fs.writeFileSync(path.join(root,n),b);
  }
  return {root, raw, capture:captureNativeSDKSources(root,pins)};
}
function packet(t) { const f=fixture(t);return {...f, built:buildPythonSDKCapsule(f.capture,'C:/OwnedCapsule')}; }
function python(script,input) {
  const result=spawnSync(PYTHON,['-I','-S','-B','-c',script],{input,encoding:'utf8',timeout:5000,maxBuffer:3*1024*1024});
  assert.ifError(result.error);return result;
}
function runOpen(script, input) {
  return new Promise((resolve,reject)=>{
    const child=spawn(PYTHON,['-I','-S','-B','-c',script],{stdio:['pipe','pipe','pipe'],windowsHide:true});
    let out='',err=''; const timer=setTimeout(()=>{child.kill();reject(Error('inert capsule test timeout'));},5000);
    child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);
    child.on('error',e=>{clearTimeout(timer);reject(e);});child.stdin.on('error',()=>{});
    child.on('close',code=>{clearTimeout(timer);resolve({status:code,stdout:out,stderr:err});});
    child.stdin.write(input);
  });
}

test('branded capture creates bounded frozen exact three-source capsule from retained bytes',t=>{
  const {root,raw,built,capture}=packet(t);
  assert(Object.isFrozen(built));assert(Object.isFrozen(built.executionSHA256));assert(Object.isFrozen(built.originalSHA256));
  assert.deepEqual(Object.keys(built),['bootstrap','envelope','executionSHA256','originalSHA256']);
  const e=JSON.parse(built.envelope);
  assert.deepEqual(Object.keys(e),['schema','workspaceRoot','sources']);assert.deepEqual(Object.keys(e.sources),names);
  assert.equal(e.workspaceRoot,'C:/OwnedCapsule');assert(Buffer.byteLength(built.envelope)+1<=2*1024*1024);
  assert(Buffer.byteLength(built.bootstrap)<=16*1024);
  assert(built.bootstrap.includes(sha(built.envelope)));
  for(const n of names){const code=Buffer.from(e.sources[n].bytes,'base64');assert.equal(sha(code),built.executionSHA256[n]);assert.equal(sha(raw[n]),built.originalSHA256[n]);assert(!code.includes(13));}
  fs.renameSync(root,root+'-removed');t.after(()=>fs.rmSync(root+'-removed',{recursive:true,force:true}));
  assert.deepEqual(buildPythonSDKCapsule(capture,'C:/OwnedCapsule'),built);
});

test('foreign capture and noncanonical workspace reject before any source getter or filesystem effects',t=>{
  const f=fixture(t);let called=0;
  for(const c of [{},Object.create(f.capture),new Proxy(f.capture,{get(){called++;throw Error();}})])
    assert.throws(()=>buildPythonSDKCapsule(c,'C:/OwnedCapsule'),/CAPTURE/);
  for(const root of ['',null,'relative','C:\\OwnedCapsule',' C:/OwnedCapsule','C:/a/../b','//?/C:/a','//./a/b','C:/a\n'])
    assert.throws(()=>buildPythonSDKCapsule(f.capture,root),/WORKSPACE/);
  assert.equal(called,0);assert.throws(()=>buildPythonSDKCapsule(f.capture,'C:/OwnedCapsule',true),/ARGUMENTS/);
});

test('known source edits fail closed rather than guessing loader replacements',t=>{
  const f=fixture(t,(n,b)=>n==='owned-zip-worker.py'?Buffer.from(b.toString().replace('HERE = Path(__file__).absolute().parent','HERE = Path.cwd()')):b);
  assert.throws(()=>buildPythonSDKCapsule(f.capture,'C:/OwnedCapsule'),/SOURCE_REVIEW/);
});

test('valid branded capture with raw edits outside replacement blocks requires adapter review',t=>{
  const f=fixture(t,(n,b)=>n==='owned-zip-extractor.py'?Buffer.concat([b,Buffer.from('\n# new source guard requires review\n')]):b);
  assert.throws(()=>buildPythonSDKCapsule(f.capture,'C:/OwnedCapsule'),/SOURCE_REVIEW/);
});

test('generated real Python AST keeps physical custody/runtime checks and contains no code path loader',t=>{
  const {built}=packet(t);
  const result=python(`import ast,json,sys
p=json.loads(sys.stdin.read());import base64
s={n:base64.b64decode(v['bytes']).decode() for n,v in p['sources'].items()}
a={n:ast.parse(v) for n,v in s.items()}
w=s['owned-zip-worker.py'];c=s['owned-file-transfer.py']
assert 'Path(__file__)' not in w+c and 'spec_from_file_location' not in w+c
assert 'seal(Path(sys.executable)' in w and 'seal(Path(core.value)' in w
assert "zlib.__spec__.origin == 'built-in'" in w
assert "ROOT = Path(_CAPSULE_WORKSPACE)" in w
assert "sources = dict(_CAPSULE_SOURCE_SHA256)" in w
assert "CAPSULE_PROCESS_BACKEND_REFUSED" in c and 'owned-extractor-process.py' not in c
assert "_ZIP_EXTRACTOR_FACTORY(self, expected_payload, expected_total)" in c
assert "class ArchiveTempLease" in c
print('actual-source AST and custody invariants verified')`,built.envelope);
  assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/verified/);
});

test('bootstrap AST precompiles every verified module before any exec',t=>{
  const {built}=packet(t);
  const r=python(`import ast,sys
m=ast.parse(sys.stdin.read()); f=next(n for n in m.body if isinstance(n,ast.FunctionDef) and n.name=='load')
compiled=next(i for i,n in enumerate(f.body) if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='compiled' for t in n.targets))
assert isinstance(f.body[compiled].value,ast.DictComp)
execs=[i for i,n in enumerate(f.body) if any(isinstance(c,ast.Call) and isinstance(c.func,ast.Name) and c.func.id=='exec' for c in ast.walk(n))]
assert len(execs)==3 and min(execs)>compiled
assert all(isinstance(f.body[i].value.args[0],ast.Subscript) and f.body[i].value.args[0].value.id=='compiled' for i in execs)
print('all-three compile before exec verified')`,built.bootstrap);
  assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/verified/);
});

test('late module syntax error prevents even the first custody module body from evaluating',async t=>{
  const {built}=packet(t);const e=JSON.parse(built.envelope);
  // Test-only malformed source envelope, re-bound to this test bootstrap hash.
  const c=Buffer.from("print('MODULE_EVALUATED')\n"+Buffer.from(e.sources['owned-file-transfer.py'].bytes,'base64').toString());
  const w=Buffer.from('def syntax_error(\n');
  for(const [name,bytes] of [['owned-file-transfer.py',c],['owned-zip-worker.py',w]])
    e.sources[name]={bytes:bytes.toString('base64'),sha256:sha(bytes)};
  const envelope=JSON.stringify(e), script=built.bootstrap.replace(sha(built.envelope),sha(envelope));
  const r=await runOpen(script,envelope+'\n');
  assert.equal(r.status,1);assert.equal(r.stdout,'');assert.match(r.stderr,/REFUSED/);
});

test('bootstrap refuses malformed/hash/tail/EOF/oversize frames before any real modules execute',t=>{
  const {built}=packet(t);
  for(const input of ['', '{bad}\n',built.envelope.slice(0,-1)+' \n',built.envelope+'\nCONTROL\n',built.envelope, 'x'.repeat(2*1024*1024+1)+'\n']) {
    const r=python(built.bootstrap,input);assert.equal(r.status,1);assert.match(r.stderr,/NATIVE_SDK_PYTHON_CAPSULE_REFUSED/);assert.equal(r.stdout,'');
  }
});

test('valid source frame with controller EOF refuses before module execution',t=>{
  const {built}=packet(t);const r=python(built.bootstrap,built.envelope+'\n');
  assert.equal(r.status,1);assert.match(r.stderr,/REFUSED/);
});

test('fixed receive-only deadline closes an open partial envelope before SDK execution',async t=>{
  const {built}=packet(t);
  // Test-only literal clock shortening; production remains exactly ten seconds.
  assert.equal(built.bootstrap.split('threading.Timer(10.0, receive_expired)').length,2);
  const script=built.bootstrap.replace('threading.Timer(10.0, receive_expired)','threading.Timer(0.15, receive_expired)');
  const r=await runOpen(script,'{"schema":');
  assert.equal(r.status,65);assert.equal(r.stdout,'');assert.equal(r.stderr,'');
});

test('positive bootstrap source-execution facade binds same three modules once, no worker or WinDLL calls',async t=>{
  const {built}=packet(t);
  // Test-only kernel facade: production source/bytes are unchanged. No native worker main.
  const facade=`import ctypes
class F:
    def __call__(self,*a,**kw): raise AssertionError('native function was invoked')
class DLL:
    def __getattr__(self,n):
        f=F();setattr(self,n,f);return f
ctypes.WinDLL=lambda *a,**kw:DLL()
`;
  let script=built.bootstrap.replace('import os, sys, json, hashlib, base64, types, threading\n','import os, sys, json, hashlib, base64, types, threading\n'+facade);
  assert.notEqual(script,built.bootstrap);
  // Test-only shortened receive clock + deliberately slow module execution.
  script=script.replace('threading.Timer(10.0, receive_expired)','threading.Timer(0.3, receive_expired)');
  script=script.replace("    exec(compiled['owned-file-transfer.py'], custody.__dict__)","    __import__('time').sleep(0.6)\n    exec(compiled['owned-file-transfer.py'], custody.__dict__)");
  const replacement=`require(worker._CAPSULE_CUSTODY is custody)
    require(worker.ROOT.as_posix() == 'C:/OwnedCapsule')
    require(worker.WORK_BASE.as_posix() == 'C:/OwnedCapsule/local-state/owned-zip-worker-work')
    require(worker._CAPSULE_SOURCE_SHA256 == digests and len(sys.argv)==1)
    require(any(cell.cell_contents is custody.ArchiveTempLease for cell in custody._ZIP_EXTRACTOR_FACTORY.__init__.__closure__))
    require(worker.__file__.startswith('<native-sdk-capsule/'))
    print('three-module same-class facade verified')`;
  assert.equal(script.split('    worker.main()').length,2);script=script.replace('worker.main()',replacement);
  script=script.replace('except BaseException:\n    sys.stderr.write', 'except BaseException:\n    import traceback; traceback.print_exc()\n    sys.stderr.write');
  const result=await runOpen(script,built.envelope+'\n');
  assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/same-class facade verified/);
});
