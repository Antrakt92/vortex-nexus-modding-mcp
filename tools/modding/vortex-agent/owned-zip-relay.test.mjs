// Opt-in own Node -> Python acceptance; never installed Vortex or game paths.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import childProcess, { spawnSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import job from './install-job-contract.cjs';
import dispatch from './native-dispatch-contract.cjs';
import { createOwnedZipRelay, RELAY_NODE, RELAY_SOURCE_NAMES, validateRelaySDKStatus, validateRelayCopyProof, parseRelayOutput, validateRelayProofEnvelope, relayCopyProofBytes, validateRelayPreparedReceipt, copyRelayAnchor } from './owned-zip-relay-client.mjs';
import terminal from './child-terminal-observer.cjs';
import { createNativeExecutorJournal } from './native-executor-journal.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url)), TASK = path.resolve(HERE, '../../../local-state/owned-zip-relay-tests');
const ENABLED = process.platform === 'win32' && process.arch === 'x64' && process.env.VORTEX_OWNED_ZIP_RELAY_TEST === '1';
const ownTest = (n, f) => test(n, {
    skip: !ENABLED, timeout: 45000
}, f), sha = b => crypto.createHash('sha256').update(b).digest('hex'), nonce = () => crypto.randomBytes(16).toString('hex');
const FIXTURE = `import sys,json,pathlib,hashlib,zipfile
r=pathlib.Path(sys.argv[1]);r.mkdir(parents=True,exist_ok=False)
for n in ['archives','model-game','model-stage']:(r/n).mkdir()
data=b'own relay fixed fixture bytes '*4096
p=r/'archives/own.zip'
with zipfile.ZipFile(p,'x',compression=zipfile.ZIP_STORED,allowZip64=False)as z:z.writestr('payload.bin',data)
def identity(p):
 s=p.stat();return {'schema':'win-file-id128/1','volumeSerialNumber':str(s.st_dev),'fileId':str(s.st_ino)}
raw=p.read_bytes();print(json.dumps({'archive':{'parent':str(p.parent),'parentIdentity':identity(p.parent),'leaf':p.name,'identity':identity(p),'bytes':len(raw),'sha256':hashlib.sha256(raw).hexdigest()},'payload':{'payload.bin':hashlib.sha256(data).hexdigest()},'total':len(data),'md5':hashlib.md5(raw).hexdigest()}))`;
function fixture() {
    fs.mkdirSync(TASK, {
        recursive: true
    });
    const root = path.join(TASK, 'run-' + nonce()), p = spawnSync('C:/Python314/python.exe', ['-I', '-S', '-B', '-c', FIXTURE, root], {
        encoding: 'utf8', windowsHide: true, timeout: 10000, maxBuffer: 32768
    });
    assert.equal(p.status, 0, p.stderr);
    const value = JSON.parse(p.stdout), roots = {
        gamePath: path.join(root, 'model-game'), stagingPath: path.join(root, 'model-stage'), downloadPath: path.join(root, 'archives')
    }, filesystemIds = Object.fromEntries(Object.entries(roots).map(([k, p]) => {
        const s = fs.statSync(p, {
            bigint: true
        });
        return [k, `${s.dev}:${s.ino}`];
    })), evidence = sha('own relay fixture no host admission');
    const plan = {
        schema: 'install-job-plan/1', family: 'tracked-new-disabled', contractId: job.CONTRACT_ID, context: {
            gameId: 'cyberpunk2077', profileId: 'relay-fixture', ...roots, filesystemIds
        }, package: {
            downloadId: 'fixture-own', fileName: 'own.zip', expectedModId: 'own', expectedType: '', bytes: value.archive.bytes, sha256: value.archive.sha256, md5: value.md5, expectedUncompressedBytes: value.total, payload: value.payload
        }, evidence: {
            buildSHA256: evidence, sourceSHA256: evidence, nativeAdmissionSHA256: evidence
        }, options: {
            enabled: false, deploy: false
        }
    }, request = {
        schema: 'native-dispatch-request/1', contractId: dispatch.CONTRACT_ID, operationId: 'op_' + nonce(), nativeJobId: 'exec_' + nonce(), planId: job.installPlanId(plan), managerScope: 'manager-relay-fixture-1', rendererGeneration: 'renderer_' + nonce(), admissionSHA256: evidence, plan
    };
    process.env.NEXUS_WORKSPACE = path.join(root, 'runtime');
    return {
        root, value, request, bytes: Buffer.from(JSON.stringify(request)), archive: Buffer.from(JSON.stringify(value.archive))
    };
}
// Failure-only fixture retirement. No production kill API; exact retained Node
// child reference plus kernel creation/image and direct-child provenance only.
const PROCESS_HELPER = String.raw `import ctypes as C,json,sys,pathlib
from ctypes import wintypes as W
K=C.WinDLL('kernel32',use_last_error=True)
class FT(C.Structure):_fields_=[('lo',W.DWORD),('hi',W.DWORD)]
class PE(C.Structure):_fields_=[('size',W.DWORD),('usage',W.DWORD),('pid',W.DWORD),('heap',C.c_size_t),('module',W.DWORD),('threads',W.DWORD),('parent',W.DWORD),('priority',W.LONG),('flags',W.DWORD),('exe',W.WCHAR*260)]
assert C.sizeof(PE)==568
K.OpenProcess.argtypes=[W.DWORD,W.BOOL,W.DWORD];K.OpenProcess.restype=W.HANDLE
K.GetProcessTimes.argtypes=[W.HANDLE,C.POINTER(FT),C.POINTER(FT),C.POINTER(FT),C.POINTER(FT)];K.GetProcessTimes.restype=W.BOOL
K.QueryFullProcessImageNameW.argtypes=[W.HANDLE,W.DWORD,W.LPWSTR,C.POINTER(W.DWORD)];K.QueryFullProcessImageNameW.restype=W.BOOL
K.GetProcessId.argtypes=[W.HANDLE];K.GetProcessId.restype=W.DWORD
K.WaitForSingleObject.argtypes=[W.HANDLE,W.DWORD];K.WaitForSingleObject.restype=W.DWORD
K.TerminateProcess.argtypes=[W.HANDLE,W.UINT];K.TerminateProcess.restype=W.BOOL
K.CloseHandle.argtypes=[W.HANDLE];K.CloseHandle.restype=W.BOOL
K.CreateToolhelp32Snapshot.argtypes=[W.DWORD,W.DWORD];K.CreateToolhelp32Snapshot.restype=W.HANDLE
K.Process32FirstW.argtypes=[W.HANDLE,C.POINTER(PE)];K.Process32FirstW.restype=W.BOOL
K.Process32NextW.argtypes=[W.HANDLE,C.POINTER(PE)];K.Process32NextW.restype=W.BOOL
mode,pid=sys.argv[1],int(sys.argv[2]);held=[]
def inspected(pid,terminate=False):
 h=K.OpenProcess(0x1000|0x100000|(1 if terminate else 0),False,pid)
 assert h;held.append(h);assert K.GetProcessId(h)==pid
 a,b,c,d=FT(),FT(),FT(),FT();assert K.GetProcessTimes(h,C.byref(a),C.byref(b),C.byref(c),C.byref(d))
 buf=C.create_unicode_buffer(32768);n=W.DWORD(len(buf));assert K.QueryFullProcessImageNameW(h,0,buf,C.byref(n))
 return h,str((a.hi<<32)|a.lo),buf.value.replace(chr(92),'/').lower()
def opened(pid,image,terminate=False):
 h,ctime,actual=inspected(pid,terminate);assert actual==image.lower()
 return h,ctime

try:
 node,created=opened(pid,'C:/Program Files/nodejs/node.exe',mode=='retire')
 if mode=='capture':print(json.dumps({'pid':pid,'creationTime':created}))
 else:
  assert mode=='retire'and created==sys.argv[3]
  root=pathlib.Path(sys.argv[4]).absolute();task=pathlib.Path(sys.argv[5]).absolute();assert root.parent==task and root.name.startswith('run-')
  assert (root/'archives/own.zip').is_file()and(root/'model-game').is_dir()and(root/'model-stage').is_dir()
  snapshot=K.CreateToolhelp32Snapshot(2,0);assert snapshot not in(None,C.c_void_p(-1).value)
  children=[]
  try:
   entry=PE();entry.size=C.sizeof(PE);ok=K.Process32FirstW(snapshot,C.byref(entry))
   while ok:
    if entry.parent==pid:children.append((entry.pid,entry.exe))
    ok=K.Process32NextW(snapshot,C.byref(entry))
  finally:assert K.CloseHandle(snapshot)
  assert len(children)<=32;targets=[];ignored=[]
  for child,name in children:
   if name.lower()!='python.exe':
    ignored.append({'pid':child,'name':name,'reason':'NOT_EXPECTED_PYTHON'});continue
   observed,ctime,image=inspected(child)
   if image!='c:/python314/python.exe' or int(ctime)<int(created):
    ignored.append({'pid':child,'name':name,'reason':'IMAGE_OR_CREATION_MISMATCH'});continue
   assert len(targets)==0
   h,retained=opened(child,'C:/Python314/python.exe',True);assert retained==ctime
   targets.append((child,h,ctime))
  targets.append((pid,node,created))
  rows=[]
  for target,h,ctime in targets:
   assert K.WaitForSingleObject(h,0)==258
   assert K.TerminateProcess(h,73);assert K.WaitForSingleObject(h,10000)==0
   rows.append({'pid':target,'creationTime':ctime,'terminalWait':0})
  print(json.dumps({'targets':rows,'ignoredChildren':ignored,'normalRelease':False,'nativeInstallAccepted':False,'canReplay':False,'quiescenceIndependentlyVerified':False}))
finally:
 for h in held:assert K.CloseHandle(h)
`;
const children = new Map();
if (ENABLED) {
    const original = childProcess.spawn;
    childProcess.spawn = function (file, args, options) {
        const child = original(file, args, options);
        if (file === RELAY_NODE) {
            const r = spawnSync('C:/Python314/python.exe', ['-I', '-S', '-B', '-c', PROCESS_HELPER, 'capture', String(child.pid)], {
                encoding: 'utf8', windowsHide: true, timeout: 5000, maxBuffer: 8192
            });
            children.set(child.pid, {
                child, identity: r.status === 0 ? JSON.parse(r.stdout) : null, captureError: r.stderr
            });
        }
        return child;
    };
    syncBuiltinESMExports();
}
function owned(t, input, make = createOwnedZipRelay) {
    const relay = make(input.bytes, input.archive);
    t.after(async () => {
        const s = relay.status();
        if (s.relayTerminal?.childResourcesClosed)
            return;
        if (!s.startSent) {
            await relay.retireInert();
            return;
        }
        try {
            const bounded = p => Promise.race([p, new Promise((_, reject) => {
                    const timer = setTimeout(() => reject(Error('CLEANUP_TIMEOUT')), 3000);
                    timer.unref();
                })]);
            if (!s.cancelAttempted && !s.releaseAttempted)
                await bounded(relay.cancel());
            if (!relay.status().releaseAttempted)
                await bounded(relay.release());
            await bounded(relay.waitFor('closed', 5000));
        }
        catch (error) {
            const statusBeforeRetirement = relay.status();
            const record = children.get(statusBeforeRetirement.relayPid);
            assert.ok(record?.identity, 'Exact fixture Node identity unavailable; preserve and report');
            const result = spawnSync('C:/Python314/python.exe', ['-I', '-S', '-B', '-c', PROCESS_HELPER, 'retire', String(record.child.pid), record.identity.creationTime, input.root, TASK], {
                encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 32768
            });
            assert.equal(result.status, 0, result.stderr);
            const retired = JSON.parse(result.stdout);
            await relay.waitFor('closed', 5000);
            fs.writeFileSync(path.join(input.root, 'FAILED-RETIREMENT.json'), JSON.stringify({
                errorCode: relay.status().errorCode, statusBeforeRetirement, retired, normalRelease: false, unknownIntentPreserved: true
            }, null, 2) + '\n', {
                flag: 'wx'
            });
            throw error;
        }
    });
    return relay;
}
function ownFixtureAnchor(input) {
    const root = path.join(input.root, 'runtime/local-state/vortex-agent-build/native-install-executor');
    fs.mkdirSync(path.dirname(root), {
        recursive: true
    });
    fs.mkdirSync(root);
    const inventory = createNativeExecutorJournal({
        root
    }).inventory();
    assert.equal(inventory.complete, true);
    assert.equal(inventory.records.length, 0);
    return Buffer.from(JSON.stringify({
        schema: 'native-executor-anchor/1', rootId: inventory.observedRootId, inventorySHA256: inventory.observedInventorySHA256
    }));
}
function unknownJournal(input, sdk) {
    const journal = createNativeExecutorJournal({
        root: path.join(input.root, 'runtime/local-state/vortex-agent-build/native-install-executor')
    });
    const observed = journal.read(input.request.operationId, sdk.binding.requestSHA256, input.request.nativeJobId, sdk.packetSHA256);
    assert.equal(observed.dispatchState, 'unknown');
    assert.equal(observed.reconcileRequired, true);
    assert.equal(observed.canReplay, false);
    assert.equal(observed.effectsAllowed, false);
    return observed;
}
async function capture(fn, hook) {
    const original = childProcess.spawn;
    let child, args;
    childProcess.spawn = function (file, argv, opts) {
        assert.equal(file, RELAY_NODE);
        assert.deepEqual(argv, [path.join(path.dirname(argv[0]), 'owned-zip-relay-runner.mjs')]);
        child = original(file, argv, opts);
        args = {
            file, argv, opts
        };
        hook?.(child, args);
        return child;
    };
    syncBuiltinESMExports();
    try {
        return await fn(() => child, () => args);
    }
    finally {
        childProcess.spawn = original;
        syncBuiltinESMExports();
    }
}
function physicallyClosed(child, observer) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(Error('OWN_RELAY_TERMINAL_TIMEOUT')), 5000);
        const check = () => setImmediate(() => {
            const s = observer.read();
            if (s.childResourcesClosed) {
                clearTimeout(timer);
                resolve(s);
            }
        });
        for (const e of [child, child.stdin, child.stdout, child.stderr])
            e.on('close', check);
        check();
    });
}
test('fixture-only retirement helper validates exact live own Node identity and rejects wrong creation time', {
    skip: process.platform !== 'win32' || process.env.VORTEX_OWNED_ZIP_RELAY_HELPER_TEST !== '1', timeout: 20000
}, async () => {
    fs.mkdirSync(TASK, {
        recursive: true
    });
    const root = path.join(TASK, 'run-' + nonce());
    fs.mkdirSync(root);
    for (const name of ['archives', 'model-game', 'model-stage'])
        fs.mkdirSync(path.join(root, name));
    fs.writeFileSync(path.join(root, 'archives/own.zip'), 'own helper-only fixture', {
        flag: 'wx'
    });
    const child = childProcess.spawn(RELAY_NODE, ['-e', 'setInterval(()=>{},1000)'], {
        windowsHide: true, env: {
            SystemRoot: process.env.SystemRoot
        }, stdio: ['pipe', 'pipe', 'pipe']
    });
    const observer = terminal.observeChildTerminal(child, matrixBinding);
    const invoke = (mode, created) => spawnSync('C:/Python314/python.exe', ['-I', '-S', '-B', '-c', PROCESS_HELPER, mode, String(child.pid), ...(created ? [created, root, TASK] : [])], {
        encoding: 'utf8', windowsHide: true, timeout: 10000, maxBuffer: 8192
    });
    try {
        const capture = invoke('capture');
        assert.equal(capture.status, 0, capture.stderr);
        const identity = JSON.parse(capture.stdout);
        assert.equal(identity.pid, child.pid);
        const wrong = invoke('retire', String(BigInt(identity.creationTime) + 1n));
        assert.notEqual(wrong.status, 0);
        assert.equal(child.exitCode, null);
        const done = physicallyClosed(child, observer), result = invoke('retire', identity.creationTime);
        assert.equal(result.status, 0, result.stderr);
        const rows = JSON.parse(result.stdout);
        assert.deepEqual(rows.targets.map(v => v.pid), [child.pid]);
        assert.equal((await done).childResourcesClosed, true);
        fs.writeFileSync(path.join(root, 'HELPER-RESULT.json'), JSON.stringify({
            identity, retired: rows, wrongCreationRefused: true
        }, null, 2) + '\n', {
            flag: 'wx'
        });
    }
    finally {
        if (!observer.read().childResourcesClosed) {
            const done = physicallyClosed(child, observer);
            child.kill('SIGTERM');
            await done;
        }
    }
});
test('closed mode and typed request API refuse without process or caller options', () => {
    assert.throws(() => createOwnedZipRelay(Buffer.from('{}'), Buffer.from('{}'), 'exec'), /MODE/);
    assert.throws(() => createOwnedZipRelay({}, Buffer.from('{}')), /REQUEST/);
    assert.throws(() => createOwnedZipRelay(Buffer.from('{}'), Buffer.from('{}')), /NATIVE_DISPATCH/);
    assert.equal(RELAY_SOURCE_NAMES.length, 14);
    assert.equal(new Set(RELAY_SOURCE_NAMES).size, 14);
});
// Execute the actual SDK status producer, with owned data-only captured variables.
const sdkSource = fs.readFileSync(path.join(HERE, 'owned-zip-worker-client.mjs'), 'utf8');
const sdkStatusBody = sdkSource.slice(sdkSource.indexOf('  function status() {'), sdkSource.indexOf('\n  function wake()', sdkSource.indexOf('  function status() {')));
// Bound extraction to the real function, not neighboring source helpers.
const sdkStatusFunction = sdkStatusBody.slice(0, sdkStatusBody.indexOf('\n  }') + 4);
const produceSDKStatus = new Function('v', `const {binding,packetSHA256,ready,child,startAttempted,startSent,handoffAttempted,cancelAttempted,releaseAttempted,childClosed,last,destination,terminal,firstError,stderrBytes,inertAbortAttempted=false}=v;return (${sdkStatusFunction})();`);
const matrixBinding = {
    operationId: 'op_' + '1'.repeat(32), nativeJobId: 'exec_' + '2'.repeat(32), requestSHA256: '3'.repeat(64), rendererGeneration: 'renderer_' + '4'.repeat(32)
};
const id = n => ({
    schema: 'win-file-id128/1', volumeSerialNumber: '1', fileId: String(n)
});
function matrixStatus(mode, phase) {
    const binding = matrixBinding, packetSHA256 = '5'.repeat(64), workerLifetime = 'worker_' + '6'.repeat(32);
    const observed = {
        schema: 'child-terminal-observation/1', binding, spawnObserved: true, exitObserved: phase === 'released', closeObserved: phase === 'released', childErrorObserved: false, childErrorCode: null, exitCode: phase === 'released' ? 0 : null, exitSignal: null, closeCode: phase === 'released' ? 0 : null, closeSignal: null, pipes: Object.fromEntries(['stdin', 'stdout', 'stderr'].map(k => [k, {
                closeObserved: phase === 'released', errorObserved: false, errorCode: null
            }])), childResourcesClosed: phase === 'released', held: false, reasonCode: null, outcome: phase === 'released' ? 'exited' : 'pending', exitSucceeded: phase === 'released', nativeInstallAccepted: false, persistenceVerified: false, descendantsVerified: false
    };
    const destination = mode === 'staging' ? {
        parent: path.resolve('own-matrix-stage'), leaf: 'own', parentIdentity: id(1), directoryIdentity: id(2)
    } : null;
    const copyProof = mode === 'staging' && ['copied', 'released'].includes(phase) ? {
        identity: id(3), bytes: 1000, sha256: '7'.repeat(64), files: 1, totalBytes: 7
    } : null;
    const zipStatus = {
        backend: 'zip', startAttempted: true, started: true, completed: ['extracted', 'copying', 'copied', 'released'].includes(phase), cancelled: phase === 'cancelled', poisoned: phase === 'held', closed: phase !== 'extracting', errorCode: null, binding, createdFiles: 1, verifiedFiles: 1, writtenBytes: 7, effectsAllowed: false, nativeInstallAccepted: false, persistenceVerified: false
    };
    const last = {
        schema: mode === 'staging' ? 'owned-zip-worker-status/2' : 'owned-zip-worker-status/1', workerLifetime, binding, packetSHA256, sequence: 1, phase, zipStatus, copiedFiles: phase === 'copied' ? 1 : 0, workRoot: path.resolve('own-matrix-work'), errorCode: null, effectsAllowed: false, nativeInstallAccepted: false, persistenceVerified: false, ...(mode === 'staging' ? {
            destination, copyProof
        } : {})
    };
    return produceSDKStatus({
        binding, packetSHA256, ready: {
            workerLifetime, creationTime: '134000000000000000'
        }, child: {
            pid: 123, exitCode: phase === 'released' ? 0 : null, signalCode: null
        }, startAttempted: true, startSent: true, handoffAttempted: ['copying', 'copied', 'released'].includes(phase), cancelAttempted: phase === 'cancelled', releaseAttempted: phase === 'released', childClosed: phase === 'released', last, destination, terminal: {
            read: () => observed
        }, firstError: null, stderrBytes: 0
    });
}
function matrixProof() {
    const sdk = matrixStatus('staging', 'copied'), request = {
        plan: {
            package: {
                payload: {
                    'payload.bin': '8'.repeat(64)
                }, expectedUncompressedBytes: 7
            }
        }
    };
    const proof = {
        schema: 'owned-zip-copy-proof/1', workerLifetime: sdk.workerLifetime, binding: matrixBinding, packetSHA256: sdk.packetSHA256, destination: sdk.destination, files: [{
                path: 'payload.bin', bytes: 7, sha256: '8'.repeat(64), sourceIdentity: id(4), destinationIdentity: id(5)
            }], copiedFiles: 1, totalBytes: 7, effectsAllowed: false, nativeInstallAccepted: false, persistenceVerified: false
    };
    const raw = relayCopyProofBytes(proof);
    sdk.copyProof.bytes = raw.length;
    sdk.copyProof.sha256 = sha(raw);
    return {
        sdk, request, proof
    };
}
function sortedJSON(value) {
    return JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
}
function portableRequest() {
    const evidence = '9'.repeat(64), roots = {
        gamePath: path.resolve('own-game'), stagingPath: path.resolve('own-stage'), downloadPath: path.resolve('own-archives')
    };
    const plan = {
        schema: 'install-job-plan/1', family: 'tracked-new-disabled', contractId: job.CONTRACT_ID, context: {
            gameId: 'cyberpunk2077', profileId: 'fixture', ...roots, filesystemIds: {
                gamePath: '1:2', stagingPath: '1:3', downloadPath: '1:4'
            }
        }, package: {
            downloadId: 'own-archive', fileName: 'own.zip', expectedModId: 'own', expectedType: '', bytes: 100, sha256: evidence, md5: 'a'.repeat(32), expectedUncompressedBytes: 7, payload: {
                'payload.bin': evidence
            }
        }, evidence: {
            buildSHA256: evidence, sourceSHA256: evidence, nativeAdmissionSHA256: evidence
        }, options: {
            enabled: false, deploy: false
        }
    };
    return {
        schema: 'native-dispatch-request/1', contractId: dispatch.CONTRACT_ID, operationId: matrixBinding.operationId, nativeJobId: matrixBinding.nativeJobId, planId: job.installPlanId(plan), managerScope: 'manager-relay-fixture-1', rendererGeneration: matrixBinding.rendererGeneration, admissionSHA256: evidence, plan
    };
}
test('staging identifier intersection refuses reserved casefold IDs before Node effects', () => {
    for (const field of ['downloadId'])
        for (const value of ['Constructor', 'PROTOTYPE', 'constructor']) {
            const request = portableRequest();
            request.plan.package[field] = value;
            request.planId = job.installPlanId(request.plan);
            assert.throws(() => createOwnedZipRelay(Buffer.from(JSON.stringify(request)), Buffer.from('{}'), 'staging'), /STAGING_ID/);
        }
    const invalid = portableRequest();
    invalid.plan.package.expectedModId = 'Constructor';
    invalid.plan.package.fileName = 'Constructor.zip';
    assert.throws(() => createOwnedZipRelay(Buffer.from(JSON.stringify(invalid)), Buffer.from('{}'), 'staging'), /INSTALL_JOB|NATIVE_DISPATCH/);
    const request = portableRequest();
    assert.doesNotThrow(() => createOwnedZipRelay(Buffer.from(JSON.stringify(request)), Buffer.from('{}'), 'staging'));
});
test('explicit pre-START anchor and compact receipt are closed and bound without a permit boolean', () => {
    const anchor = {
        schema: 'native-executor-anchor/1', rootId: '0:123', inventorySHA256: 'a'.repeat(64)
    }, bytes = Buffer.from(JSON.stringify(anchor));
    assert.deepEqual(copyRelayAnchor(bytes), bytes);
    for (const bad of [Buffer.from('{}'), Buffer.from(JSON.stringify({
            ...anchor, permit: true
        })), Buffer.from(JSON.stringify({
            rootId: anchor.rootId, schema: anchor.schema, inventorySHA256: anchor.inventorySHA256
        })), Buffer.from(JSON.stringify({
            ...anchor, rootId: 'bad'
        })), Buffer.alloc(1025)])
        assert.throws(() => copyRelayAnchor(bad), /ANCHOR|REQUEST|STRICT_JSON/);
    const t = {
        schema: 'native-executor-pending-transition/1', rootId: anchor.rootId, previousInventorySHA256: anchor.inventorySHA256, inventorySHA256: 'b'.repeat(64), operationId: matrixBinding.operationId, nativeJobId: matrixBinding.nativeJobId, requestSHA256: matrixBinding.requestSHA256, packetSHA256: 'c'.repeat(64), workerLifetime: 'worker_' + 'd'.repeat(32)
    }, receipt = {
        schema: 'owned-zip-worker-prepared/1', binding: matrixBinding, workerLifetime: t.workerLifetime, workerPid: 123, creationTime: '134000000000000000', packetSHA256: t.packetSHA256, transition: t
    };
    validateRelayPreparedReceipt(receipt, matrixBinding, anchor);
    for (const change of [v => v.transition.previousInventorySHA256 = 'e'.repeat(64), v => v.transition.rootId = '0:124', v => v.packetSHA256 = 'f'.repeat(64), v => v.permit = true]) {
        const bad = structuredClone(receipt);
        change(bad);
        assert.throws(() => validateRelayPreparedReceipt(bad, matrixBinding, anchor), /PREPARED_MISMATCH/);
    }
});
test('managed relay refuses auto-start and invalid anchors before any Node effect', async () => {
    const request = portableRequest(), relay = createOwnedZipRelay(Buffer.from(JSON.stringify(request)), Buffer.from('{}'), 'staging');
    await assert.rejects(relay.start(), /STAGING_PREPARE_REQUIRED/);
    await assert.rejects(relay.startPrepared(), /START_PREPARED_REFUSED/);
    await assert.rejects(relay.prepare(Buffer.from('{}')), /INVALID_ANCHOR/);
    assert.equal(relay.status().relayPid, null);
    assert.equal(relay.status().startSent, false);
});
test('actual SDK status() projection accepts both closed worker schemas and every lifecycle phase', () => {
    for (const mode of ['scratch', 'staging'])
        for (const phase of ['extracting', 'extracted', 'copying', 'copied', 'cancelled', 'held', 'released']) {
            const status = matrixStatus(mode, phase);
            assert.doesNotThrow(() => validateRelaySDKStatus(status, matrixBinding, mode), mode + ':' + phase);
            assert.doesNotThrow(() => validateRelaySDKStatus(JSON.parse(sortedJSON(status)), matrixBinding, mode));
            const extra = structuredClone(status);
            extra.worker.extra = true;
            assert.throws(() => validateRelaySDKStatus(extra, matrixBinding, mode), /SDK_STATUS/);
            const bad = structuredClone(status);
            bad.worker.schema = mode === 'staging' ? 'owned-zip-worker-status/1' : 'owned-zip-worker-status/2';
            assert.throws(() => validateRelaySDKStatus(bad, matrixBinding, mode), /SDK_STATUS/);
        }
    const ready = produceSDKStatus({
        binding: matrixBinding, packetSHA256: null, ready: null, child: null, startAttempted: false, startSent: false, handoffAttempted: false, cancelAttempted: false, releaseAttempted: false, childClosed: false, last: null, destination: null, terminal: null, firstError: null, stderrBytes: 0
    });
    assert.doesNotThrow(() => validateRelaySDKStatus(ready, matrixBinding));
});
test('actual relay proofLive source refuses Node exit before pipe close and all custody-loss states', () => {
    const source = fs.readFileSync(path.join(HERE, 'owned-zip-relay-client.mjs'), 'utf8');
    const start = source.indexOf('    function proofLive() {'), end = source.indexOf('    function invalidateProof()', start);
    assert.ok(start > 0 && end > start);
    const evaluate = new Function('observation', 'sdk', `const mode='staging',firstError=null,cancelAttempted=false,releaseAttempted=false,closed=false,last={sdk},observer=observation===null?null:{read:()=>observation};return (${source.slice(start, end)})();`);
    const sdk = matrixStatus('staging', 'copied'), live = {
        spawnObserved: true, exitObserved: false, closeObserved: false, childErrorObserved: false, held: false, childResourcesClosed: false
    };
    assert.equal(evaluate(live, sdk), true);
    for (const flag of ['exitObserved', 'closeObserved', 'childErrorObserved', 'held', 'childResourcesClosed'])
        assert.equal(evaluate({
            ...live, [flag]: true
        }, sdk), false, flag);
    assert.equal(evaluate({
        ...live, spawnObserved: false
    }, sdk), false);
    assert.equal(evaluate(null, sdk), false);
});
test('actual runner command permits failed cancelled release only and preserves the original error', async () => {
    const source = fs.readFileSync(path.join(HERE, 'owned-zip-relay-runner.mjs'), 'utf8'), start = source.indexOf('async function command(v) {'), end = source.indexOf('function receive(raw)', start);
    assert.ok(start > 0 && end > start);
    const execute = new Function('input', 'validateRelaySDKStatus', `return (async()=>{const binding=input.binding,lifetime='relay_'+ 'a'.repeat(32),mode='staging',initialSources={},equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b),readRelaySourceClosure=()=>({}),exact=(v,k)=>Object.keys(v).length===k.length&&k.every(n=>Object.hasOwn(v,n)),need=(v,c)=>{if(!v)throw Error(c)},terminal={copyChildBinding:v=>v};let controllerEOF=input.eof??false,protocolBroken=input.broken??false,failed='ORIGINAL_COPY_FAILURE',cancelled=input.cancelled??true,releasing=false,released=false,started=true,handoff=false,proofAttempted=false,called=0,published=0;const sdkStatus=()=>input.current,owner={status:sdkStatus,release:async()=>{called++;return input.terminal},cancel:async()=>{}},publish=()=>{published++},maybeExit=()=>{},emit=()=>{};await (${source.slice(start, end)})({schema:'owned-zip-relay-control/1',relayLifetime:lifetime,binding,command:input.command??'release',...(input.command==='copyProof'?{nonce:'b'.repeat(32)}:{})});return{called,published,released,failed};})();`);
    const current = matrixStatus('staging', 'cancelled'), ended = matrixStatus('staging', 'released');
    assert.deepEqual(await execute({
        binding: matrixBinding, current, terminal: ended
    }, validateRelaySDKStatus), {
        called: 1, published: 1, released: true, failed: 'ORIGINAL_COPY_FAILURE'
    });
    for (const change of [{
            cancelled: false
        }, {
            current: matrixStatus('staging', 'held')
        }, {
            current: matrixStatus('staging', 'extracting')
        }, {
            current: {
                ...current, cancelAttempted: false
            }
        }, {
            eof: true
        }, {
            broken: true
        }, {
            command: 'handoff'
        }, {
            command: 'copyProof'
        }])
        await assert.rejects(execute({
            binding: matrixBinding, current, terminal: ended, ...change
        }, validateRelaySDKStatus), /CONTROLLER_EOF|HANDOFF|COPY_PROOF/);
});
test('full proof transport accepts Python sorted-key JSON and refuses malformed or stale closed proofs', () => {
    const { sdk, request, proof } = matrixProof();
    const unicode = structuredClone(proof);
    unicode.destination.parent = 'C:/own-\u00e9\u{1f600}\x7f';
    assert.ok(relayCopyProofBytes(unicode).toString('ascii').includes('C:/own-\\u00e9\\ud83d\\ude00\\u007f'));
    const frame = {
        schema: 'owned-zip-relay-copy-proof/1', relayLifetime: 'relay_' + 'a'.repeat(32), binding: matrixBinding, startSHA256: 'b'.repeat(64), sequence: 2, nonce: 'c'.repeat(32), proof
    };
    for (const change of [v => v.nonce = 'd'.repeat(32), v => v.sequence = 1, v => v.binding.operationId = 'op_' + 'e'.repeat(32), v => v.startSHA256 = 'f'.repeat(64), v => v.extra = true]) {
        const bad = structuredClone(frame);
        change(bad);
        assert.throws(() => validateRelayProofEnvelope(bad, frame.relayLifetime, matrixBinding, frame.startSHA256, 1, frame.nonce), /COPY_PROOF_MISMATCH/);
    }
    assert.doesNotThrow(() => validateRelayProofEnvelope(frame, frame.relayLifetime, matrixBinding, frame.startSHA256, 1, frame.nonce));
    const parsed = parseRelayOutput(Buffer.from(sortedJSON(frame)));
    assert.doesNotThrow(() => validateRelayCopyProof(parsed.proof, sdk, request, matrixBinding));
    for (const change of [p => p.files[0].sha256 = '0'.repeat(64), p => p.totalBytes++, p => p.binding.operationId = 'op_' + 'f'.repeat(32), p => p.files[0].destinationIdentity = null, p => p.files[0].destinationIdentity.fileId = '555', p => p.extra = true, p => p.destination.directoryIdentity.fileId = '99']) {
        const p = structuredClone(proof);
        change(p);
        assert.throws(() => validateRelayCopyProof(p, sdk, request, matrixBinding), /COPY_PROOF/);
    }
    for (const change of [s => s.workerTerminal.exitObserved = true, s => s.workerTerminal.held = true, s => s.phase = 'released']) {
        const v = structuredClone(sdk);
        change(v);
        assert.throws(() => validateRelayCopyProof(proof, v, request, matrixBinding), /COPY_PROOF/);
    }
    assert.throws(() => parseRelayOutput(Buffer.alloc(4 * 1024 * 1024 + 16385, 32)), /FRAME_LIMIT/);
    assert.throws(() => parseRelayOutput(Buffer.from('{"schema":"x","schema":"y"}')), /STRICT_JSON/);
    assert.throws(() => parseRelayOutput(Buffer.from([0xff])), /STRICT_JSON/);
    assert.throws(() => parseRelayOutput(Buffer.from(JSON.stringify({
        schema: 'owned-zip-relay-status/1', x: 'x'.repeat(65536)
    }))), /FRAME_LIMIT/);
    assert.throws(() => parseRelayOutput(Buffer.from('{"schema":"owned-zip-relay-copy-proof/1","x":' + '['.repeat(30) + '0' + ']'.repeat(30) + '}')), /STRICT_JSON/);
});
test('retained actual Python CopyProof.json validates with its sorted producer key order', {
    skip: !process.env.VORTEX_OWNED_ZIP_RELAY_PROOF
}, () => {
    const raw = fs.readFileSync(process.env.VORTEX_OWNED_ZIP_RELAY_PROOF);
    const proof = JSON.parse(raw);
    assert.equal(proof.schema, 'owned-zip-copy-proof/1');
    assert.deepEqual(relayCopyProofBytes(proof), raw);
    assert.equal(sha(relayCopyProofBytes(proof)), sha(raw));
    const sdk = {
        phase: 'copied', copyProof: {
            files: proof.copiedFiles, totalBytes: proof.totalBytes, bytes: raw.length, sha256: sha(raw)
        }, workerLifetime: proof.workerLifetime, packetSHA256: proof.packetSHA256, destination: proof.destination, workerTerminal: {
            exitObserved: false, childResourcesClosed: false, held: false
        }
    };
    const request = {
        plan: {
            package: {
                payload: Object.fromEntries(proof.files.map(r => [r.path, r.sha256])), expectedUncompressedBytes: proof.totalBytes
            }
        }
    };
    validateRelayCopyProof(proof, sdk, request, proof.binding);
    const wrongFileID = structuredClone(proof);
    wrongFileID.files[0].destinationIdentity.fileId = String(BigInt(wrongFileID.files[0].destinationIdentity.fileId) + 1n);
    assert.throws(() => validateRelayCopyProof(wrongFileID, sdk, request, proof.binding), /COPY_PROOF_DIGEST_MISMATCH/);
    const frame = {
        schema: 'owned-zip-relay-copy-proof/1', relayLifetime: 'relay_' + 'a'.repeat(32), binding: structuredClone(proof.binding), startSHA256: 'b'.repeat(64), sequence: 2, nonce: 'c'.repeat(32), proof
    };
    const parsed = parseRelayOutput(Buffer.from(JSON.stringify(frame)));
    validateRelayProofEnvelope(parsed, frame.relayLifetime, proof.binding, frame.startSHA256, 1, frame.nonce);
    validateRelayCopyProof(parsed.proof, sdk, request, proof.binding);
});
ownTest('actual fixed Node -> Python scratch handoff and release observe BOTH process terminal boundaries', async (t) => capture(async (current) => {
    const input = fixture(), relay = owned(t, input);
    await relay.start();
    await relay.waitFor('extracted', 15000);
    const extracted = relay.status();
    assert.ok(extracted.sdk.workerPid > 0);
    assert.notEqual(extracted.sdk.workerPid, extracted.relayPid);
    assert.match(extracted.sdk.workerLifetime, /^worker_/);
    assert.equal(extracted.sdk.workerTerminal.childResourcesClosed, false);
    await relay.handoff();
    const copied = relay.status();
    const target = path.join(copied.sdk.worker.workRoot, 'Final/payload.bin');
    assert.equal(sha(fs.readFileSync(target)), input.value.payload['payload.bin']);
    const released = await relay.release();
    assert.equal(released.phase, 'released');
    assert.equal(released.sdk.childClosed, true);
    assert.equal(released.sdk.workerTerminal.childResourcesClosed, true);
    assert.equal(released.sdk.workerTerminal.exitSucceeded, true);
    assert.equal(released.relayTerminal.childResourcesClosed, true);
    assert.equal(released.relayTerminal.exitSucceeded, true);
    assert.equal(current().pid, released.relayPid);
    for (const key of ['stdin', 'stdout', 'stderr'])
        assert.equal(released.relayTerminal.pipes[key].closeObserved, true);
    assert.equal(released.nativeInstallAccepted, false);
    fs.writeFileSync(path.join(input.root, 'RESULT.json'), JSON.stringify(released, null, 2) + '\n', {
        flag: 'wx'
    });
}));
ownTest('explicit cancel is sticky/idempotent and release joins actual worker then relay', async (t) => {
    const input = fixture(), relay = owned(t, input);
    await relay.start();
    await relay.waitFor('extracted', 15000);
    const a = relay.cancel(), b = relay.cancel();
    await Promise.all([a, b]);
    assert.equal(relay.status().phase, 'cancelled');
    assert.throws(() => relay.handoff(), /HANDOFF_REFUSED/);
    const result = await relay.release();
    assert.equal(result.sdk.workerTerminal.childResourcesClosed, true);
    assert.equal(result.relayTerminal.childResourcesClosed, true);
});
ownTest('cancel before ready never sends START or starts a Python worker', async (t) => {
    const input = fixture(), relay = owned(t, input);
    const start = relay.start();
    await relay.cancel();
    await assert.rejects(start, /CANCELLED_BEFORE_START/);
    const result = relay.status();
    assert.equal(result.startSent, false);
    assert.equal(result.sdk, null);
    assert.equal(result.relayTerminal.childResourcesClosed, true);
});
ownTest('Node loader environment cannot inherit NODE_OPTIONS or NODE_PATH', async (t) => capture(async (_current, args) => {
    const input = fixture(), oldOptions = process.env.NODE_OPTIONS, oldPath = process.env.NODE_PATH;
    let relay;
    try {
        process.env.NODE_OPTIONS = '--require NONEXISTENT_MUST_NOT_LOAD';
        process.env.NODE_PATH = 'UNTRUSTED_MUST_NOT_LOAD';
        relay = owned(t, input);
        await relay.start();
        assert.equal(args().opts.env.NODE_OPTIONS, undefined);
        assert.equal(args().opts.env.NODE_PATH, undefined);
        assert.equal(args().opts.env.NEXUS_WORKSPACE, process.env.NEXUS_WORKSPACE);
    }
    finally {
        if (oldOptions === undefined)
            delete process.env.NODE_OPTIONS;
        else
            process.env.NODE_OPTIONS = oldOptions;
        if (oldPath === undefined)
            delete process.env.NODE_PATH;
        else
            process.env.NODE_PATH = oldPath;
    }
    await relay.waitFor('extracted', 15000);
    await relay.release();
}));
ownTest('changed physical SDK closure after spawn refuses before START and permits only inert exact-child retirement', async (t) => {
    const input = fixture(), clone = path.join(input.root, 'clone'), modules = path.join(clone, 'tools/modding/vortex-agent');
    fs.mkdirSync(modules, {
        recursive: true
    });
    for (const name of RELAY_SOURCE_NAMES)
        fs.copyFileSync(path.join(HERE, name), path.join(modules, name));
    const imported = await import(pathToFileURL(path.join(modules, 'owned-zip-relay-client.mjs')).href);
    let relay;
    await capture(async () => {
        relay = owned(t, input, imported.createOwnedZipRelay);
        await assert.rejects(relay.start(), /READY_MISMATCH|SOURCE_CHANGED/);
        assert.equal(relay.status().startSent, false);
        const retired = await relay.retireInert();
        assert.equal(retired.relayTerminal.childResourcesClosed, true);
    }, () => fs.appendFileSync(path.join(modules, 'owned-zip-extractor.py'), '\n# own controlled source drift\n'));
});
ownTest('controller EOF before START holds the exact inert Node process without SDK/Python effects', async () => {
    const input = fixture(), binding = {
        operationId: input.request.operationId, nativeJobId: input.request.nativeJobId, requestSHA256: dispatch.dispatchRequestDigest(input.bytes), rendererGeneration: input.request.rendererGeneration
    }, child = childProcess.spawn(RELAY_NODE, [path.join(HERE, 'owned-zip-relay-runner.mjs')], {
        cwd: HERE, env: {
            SystemRoot: process.env.SystemRoot, NEXUS_WORKSPACE: process.env.NEXUS_WORKSPACE
        }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']
    }), observer = terminal.observeChildTerminal(child, binding);
    child.stderr.on('data', () => {
    });
    let buf = '';
    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(Error('READY_TIMEOUT')), 5000);
        child.stdout.on('data', b => {
            buf += b.toString('utf8');
            if (buf.includes('\n')) {
                const ready = JSON.parse(buf.slice(0, buf.indexOf('\n')));
                assert.equal(ready.schema, 'owned-zip-relay-ready/1');
                clearTimeout(timer);
                resolve();
            }
        });
        child.on('error', reject);
    });
    child.stdin.end();
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(observer.read().childResourcesClosed, false);
    assert.equal(child.exitCode, null);
    const done = physicallyClosed(child, observer);
    assert.equal(child.kill('SIGTERM'), true);
    const closed = await done;
    assert.equal(closed.childResourcesClosed, true);
    assert.equal(fs.existsSync(path.join(process.env.NEXUS_WORKSPACE, 'local-state/vortex-agent-build/native-install-executor/operations', input.request.operationId)), false);
});
ownTest('actual staging relay copies into ONLY the declared fresh model staging leaf and preserves proof metadata', async (t) => {
    const input = fixture(), relay = owned(t, input, (a, b) => createOwnedZipRelay(a, b, 'staging'));
    await relay.prepare(ownFixtureAnchor(input));
    await relay.startPrepared();
    await relay.waitFor('extracted', 15000);
    await relay.handoff();
    const copied = relay.status();
    assert.equal(copied.sdk.destination.parent, input.request.plan.context.stagingPath);
    assert.equal(copied.sdk.destination.leaf, 'own');
    assert.equal(copied.sdk.copyProof.files, 1);
    const full = await relay.copyProof();
    assert.equal(full.files[0].sha256, input.value.payload['payload.bin']);
    assert.equal(full.files[0].path, 'payload.bin');
    const cached = await relay.copyProof();
    assert.deepEqual(cached, full);
    full.files[0].path = 'mutated';
    assert.equal((await relay.copyProof()).files[0].path, 'payload.bin');
    assert.equal(copied.sdk.copyProof.totalBytes, input.value.total);
    assert.match(copied.sdk.copyProof.sha256, /^[a-f0-9]{64}$/);
    assert.equal(sha(fs.readFileSync(path.join(input.request.plan.context.stagingPath, 'own/payload.bin'))), input.value.payload['payload.bin']);
    const done = await relay.release();
    assert.equal(done.sdk.workerTerminal.childResourcesClosed, true);
    assert.equal(done.relayTerminal.childResourcesClosed, true);
});
ownTest('active controller EOF cancels and retains archive custody until exact fixture retirement', async (t) => capture(async (current) => {
    const input = fixture(), relay = owned(t, input);
    await relay.start();
    await relay.waitFor('extracted', 15000);
    const intent = path.join(input.root, 'runtime/local-state/vortex-agent-build/native-install-executor/operations', input.request.operationId, 'intent.json');
    assert.ok(fs.existsSync(intent));
    const intentBytes = fs.readFileSync(intent);
    current().stdin.end();
    await relay.waitFor('held', 5000);
    await new Promise((resolve, reject) => {
        const deadline = Date.now() + 5000;
        function check() {
            if (relay.status().sdk?.phase === 'cancelled') {
                resolve();
                return;
            }
            if (Date.now() >= deadline) {
                reject(Error('EOF_CANCEL_TIMEOUT'));
                return;
            }
            setTimeout(check, 20);
        }
        check();
    });
    const held = relay.status();
    assert.equal(held.phase, 'held');
    assert.equal(held.errorCode, 'CONTROLLER_EOF');
    assert.equal(held.releaseAttempted, false);
    assert.equal(held.sdk.childClosed, false);
    assert.equal(held.sdk.workerTerminal.childResourcesClosed, false);
    assert.equal(held.relayTerminal.childResourcesClosed, false);
    const archivePath = path.join(input.request.plan.context.downloadPath, input.value.archive.leaf);
    const fenced = spawnSync('C:/Python314/python.exe', ['-I', '-S', '-B', '-c', "import sys\ntry:\n f=open(sys.argv[1],'r+b')\nexcept PermissionError:\n print('WRITE_DENIED')\nelse:\n f.close();raise RuntimeError('ARCHIVE_NOT_FENCED')", archivePath], {
        encoding: 'utf8', windowsHide: true, timeout: 5000, maxBuffer: 8192
    });
    assert.equal(fenced.status, 0, fenced.stderr);
    assert.equal(fenced.stdout.trim(), 'WRITE_DENIED');
    assert.throws(() => relay.handoff(), /HANDOFF_REFUSED/);
    assert.throws(() => relay.copyProof(), /COPY_PROOF_UNAVAILABLE/);
    const record = children.get(held.relayPid);
    assert.ok(record?.identity);
    const result = spawnSync('C:/Python314/python.exe', ['-I', '-S', '-B', '-c', PROCESS_HELPER, 'retire', String(record.child.pid), record.identity.creationTime, input.root, TASK], {
        encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 32768
    });
    assert.equal(result.status, 0, result.stderr);
    const retired = JSON.parse(result.stdout);
    assert.equal(retired.targets.length, 2);
    assert.deepEqual(new Set(retired.targets.map(row => row.pid)), new Set([held.relayPid, held.sdk.workerPid]));
    await relay.waitFor('closed', 5000);
    assert.deepEqual(fs.readFileSync(intent), intentBytes);
    unknownJournal(input, held.sdk);
    assert.equal(fs.existsSync(path.join(input.request.plan.context.stagingPath, 'own')), false);
    fs.writeFileSync(path.join(input.root, 'ACTIVE-EOF-RESULT.json'), JSON.stringify({
        held, retired, intentSHA256: sha(intentBytes), unknownIntentPreserved: true, normalRelease: false, canReplay: false, nativeInstallAccepted: false
    }, null, 2) + '\n', {
        flag: 'wx'
    });
}));
ownTest('casefold handoff failure preserves keeper and permits explicit cancelled release with original error', async (t) => {
    const input = fixture(), existing = path.join(input.request.plan.context.stagingPath, 'OWN');
    fs.mkdirSync(existing);
    const keeper = path.join(existing, 'keeper.txt');
    fs.writeFileSync(keeper, 'own exact preexisting keeper', {
        flag: 'wx'
    });
    const bytes = fs.readFileSync(keeper);
    const relay = owned(t, input, (a, b) => createOwnedZipRelay(a, b, 'staging'));
    await relay.prepare(ownFixtureAnchor(input));
    await relay.startPrepared();
    await relay.waitFor('extracted', 15000);
    await assert.rejects(relay.handoff());
    await relay.cancel();
    const cancelled = relay.status();
    assert.equal(cancelled.phase, 'cancelled');
    assert.ok(cancelled.errorCode);
    assert.equal(cancelled.sdk.cancelAttempted, true);
    assert.deepEqual(fs.readFileSync(keeper), bytes);
    assert.deepEqual(fs.readdirSync(existing), ['keeper.txt']);
    const release = relay.release();
    const done = await Promise.race([release, new Promise((_, reject) => {
            const timer = setTimeout(() => reject(Error('CANCELLED_RELEASE_TIMEOUT')), 1500);
            timer.unref();
        })]);
    assert.equal(done.phase, 'released');
    assert.equal(done.errorCode, cancelled.errorCode);
    assert.equal(done.sdk.workerTerminal.childResourcesClosed, true);
    assert.equal(done.relayTerminal.childResourcesClosed, true);
    assert.deepEqual(fs.readFileSync(keeper), bytes);
    assert.deepEqual(fs.readdirSync(existing), ['keeper.txt']);
    const journal = unknownJournal(input, done.sdk);
    fs.writeFileSync(path.join(input.root, 'CANCELLED-RELEASE-RESULT.json'), JSON.stringify({
        cancelled, done, journal, keeperSHA256: sha(bytes), normalExtractionSuccess: false, nativeInstallAccepted: false
    }, null, 2) + '\n', {
        flag: 'wx'
    });
});
ownTest('explicit relay prepare cannot send Python START until a separate fixture main-anchor ACK', async (t) => {
    const input = fixture(), relay = owned(t, input, (a, b) => createOwnedZipRelay(a, b, 'staging')), anchor = ownFixtureAnchor(input), receipt = await relay.prepare(anchor), work = path.resolve(HERE, '../../../local-state/owned-zip-worker-work', input.request.operationId);
    assert.equal(receipt.schema, 'owned-zip-worker-prepared/1');
    assert.equal(relay.status().sdk.startSent, false);
    assert.equal(fs.existsSync(work), false);
    assert.equal(fs.existsSync(path.join(input.request.plan.context.stagingPath, 'own')), false);
    unknownJournal(input, receipt);
    await assert.rejects(relay.prepare(anchor), /START_REFUSED/);
    let acknowledge;
    const ack = new Promise(resolve => {
        acknowledge = resolve;
    }), starting = (async () => {
        await ack;
        return relay.startPrepared();
    })();
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(relay.status().sdk.startSent, false);
    assert.equal(fs.existsSync(work), false);
    fs.writeFileSync(path.join(input.root, 'OWN-MAIN-PENDING-ACK.json'), JSON.stringify(receipt.transition) + '\n', {
        flag: 'wx'
    });
    acknowledge();
    await starting;
    await relay.waitFor('extracted', 15000);
    await assert.rejects(relay.startPrepared(), /START_PREPARED_REFUSED/);
    await relay.handoff();
    await relay.copyProof();
    await relay.release();
});
ownTest('explicit prepared relay cancel joins inert Python and preserves unknown intent without output', async (t) => {
    const input = fixture(), relay = owned(t, input, (a, b) => createOwnedZipRelay(a, b, 'staging'));
    await relay.prepare(ownFixtureAnchor(input));
    await relay.cancel();
    await assert.rejects(relay.startPrepared(), /START_PREPARED_REFUSED/);
    const done = await relay.release();
    assert.equal(done.sdk.startSent, false);
    assert.equal(done.sdk.workerTerminal.childResourcesClosed, true);
    assert.equal(done.relayTerminal.childResourcesClosed, true);
    assert.equal(fs.existsSync(path.resolve(HERE, '../../../local-state/owned-zip-worker-work', input.request.operationId)), false);
    unknownJournal(input, done.sdk);
});
ownTest('prepared controller EOF aborts only inert Python while relay and unknown journal remain held', async (t) => capture(async (current) => {
    const input = fixture(), relay = owned(t, input, (a, b) => createOwnedZipRelay(a, b, 'staging'));
    await relay.prepare(ownFixtureAnchor(input));
    current().stdin.end();
    await relay.waitFor('held', 5000);
    await new Promise((resolve, reject) => {
        const deadline = Date.now() + 5000;
        function check() {
            if (relay.status().sdk?.workerTerminal?.childResourcesClosed) {
                resolve();
                return;
            }
            if (Date.now() >= deadline) {
                reject(Error('PREPARED_EOF_ABORT_TIMEOUT'));
                return;
            }
            setTimeout(check, 20);
        }
        check();
    });
    const held = relay.status();
    assert.equal(held.sdk.startSent, false);
    assert.equal(held.sdk.workerTerminal.exitSucceeded, true);
    assert.equal(held.relayTerminal.childResourcesClosed, false);
    assert.equal(held.phase, 'held');
    assert.equal(held.errorCode, 'CONTROLLER_EOF');
    assert.equal(fs.existsSync(path.resolve(HERE, '../../../local-state/owned-zip-worker-work', input.request.operationId)), false);
    await assert.rejects(relay.startPrepared(), /START_PREPARED_REFUSED/);
    const record = children.get(held.relayPid);
    assert.ok(record?.identity);
    const result = spawnSync('C:/Python314/python.exe', ['-I', '-S', '-B', '-c', PROCESS_HELPER, 'retire', String(record.child.pid), record.identity.creationTime, input.root, TASK], {
        encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 32768
    });
    assert.equal(result.status, 0, result.stderr);
    const retired = JSON.parse(result.stdout);
    assert.deepEqual(retired.targets.map(row => row.pid), [held.relayPid]);
    await relay.waitFor('closed', 5000);
    const journal = unknownJournal(input, held.sdk);
    fs.writeFileSync(path.join(input.root, 'PREPARED-EOF-RESULT.json'), JSON.stringify({
        held, retired, journal, normalRelease: false, canReplay: false
    }, null, 2) + '\n', {
        flag: 'wx'
    });
}));
