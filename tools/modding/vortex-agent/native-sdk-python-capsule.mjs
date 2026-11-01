// Build-time only: fixed reviewed Python source adaptation. No native worker start.
import crypto from 'node:crypto';
import path from 'node:path';
import {readCapturedNativeSDKSource} from './native-sdk-capture.mjs';

const NAMES = Object.freeze(['owned-zip-worker.py', 'owned-file-transfer.py', 'owned-zip-extractor.py']);
const MAX_ENVELOPE = 2 * 1024 * 1024;
// Adapter review boundary: changed raw source requires a new explicit adaptation review.
const ORIGINAL_SHA256 = Object.freeze({
  'owned-zip-worker.py':'1b823200dc386f2681e887624631a794e55143d6db25f94a0b67d075b9ad298a',
  'owned-file-transfer.py':'8224875c23d45b14ea7607f1d28f982304f791f853e4aa193317b5ef5f10e9ee',
  'owned-zip-extractor.py':'0b2bb825d95f928262afa570724d5ebac04257db119375f2f3ce0c8c2bf5ed59',
});
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const need = (ok, code) => { if (!ok) throw Error('NATIVE_SDK_PYTHON_CAPSULE_' + code); };
function once(source, before, after) {
  need(source.split(before).length === 2, 'SOURCE_SHAPE');
  return source.replace(before, after);
}
function workspace(value) {
  need(typeof value === 'string' && value.length > 0 && value.length <= 4096
    && value === value.trim() && !/[\x00-\x1f\\]/.test(value)
    && /^(?:[A-Za-z]:\/|\/\/[^/]+\/[^/]+(?:\/|$))/.test(value)
    && !value.startsWith('//?/') && !value.startsWith('//./')
    && !value.split('/').some(v => v === '.' || v === '..')
    && path.win32.resolve(value).replaceAll('\\', '/') === value, 'WORKSPACE');
  return value;
}
function transformed(name, raw) {
  const decoded = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(raw);
  need(Buffer.from(decoded).equals(raw) && !decoded.startsWith('\uFEFF'), 'SOURCE_ENCODING');
  let s = decoded.replaceAll('\r\n', '\n');
  if (name === 'owned-zip-worker.py') {
    s = once(s, "HERE = Path(__file__).absolute().parent\nROOT = HERE.parents[2]\nWORK_BASE = ROOT/'local-state/owned-zip-worker-work'",
      "ROOT = Path(_CAPSULE_WORKSPACE)\nWORK_BASE = ROOT/'local-state/owned-zip-worker-work'");
    s = once(s, "    spec = importlib.util.spec_from_file_location('_owned_zip_worker_custody', HERE/'owned-file-transfer.py')\n    base = importlib.util.module_from_spec(spec)\n    spec.loader.exec_module(base)", '    base = _CAPSULE_CUSTODY');
    s = once(s, '    sources = {name: seal(HERE/name, 512*1024) for name in SOURCE_NAMES}',
      '    sources = dict(_CAPSULE_SOURCE_SHA256)');
    s = once(s, 'import importlib.util\n', '');
  } else if (name === 'owned-file-transfer.py') {
    s = once(s, "    def create_extractor(self):\n        \"\"\"Inert one-shot factory; start() separately requires acquired custody.\"\"\"\n        global _EXTRACTOR_FACTORY\n        with self._operation():\n            _need(not self._extractor_attempted and not self._borrow_attempted, 'EXTRACTOR_ALREADY_ATTEMPTED')\n            self._extractor_attempted = True\n            try:\n                if _EXTRACTOR_FACTORY is None:\n                    source = Path(__file__).absolute().with_name('owned-extractor-process.py')\n                    for path in (source, *source.parents):\n                        _need(not path.lstat().st_file_attributes & 0x400, 'UNSAFE_EXTRACTOR_SOURCE')\n                    spec = importlib.util.spec_from_file_location('_owned_extractor_process_fixed', source)\n                    module = importlib.util.module_from_spec(spec)\n                    spec.loader.exec_module(module)\n                    _EXTRACTOR_FACTORY = module._bind(_HandleCustody, ArchiveTempLease, _snapshot, _hash, OwnedTransferError)\n                owner = _EXTRACTOR_FACTORY(self)\n                self._extractor = owner  # Published BEFORE any process-owner kernel effects.\n                return owner\n            except BaseException as error:\n                self._poisoned = True\n                error.lease = self\n                error.owner = self._extractor\n                raise\n\n",
      "    def create_extractor(self):\n        with self._operation():\n            self._extractor_attempted = True\n            self._poisoned = True\n            raise OwnedTransferError('CAPSULE_PROCESS_BACKEND_REFUSED', self)\n\n");
    s = once(s, "                if _ZIP_EXTRACTOR_FACTORY is None:\n                    source = Path(__file__).absolute().with_name('owned-zip-extractor.py')\n                    for path in (source, *source.parents):\n                        _need(not path.lstat().st_file_attributes & 0x400, 'UNSAFE_EXTRACTOR_SOURCE')\n                    spec = importlib.util.spec_from_file_location('_owned_zip_extractor_fixed', source)\n                    module = importlib.util.module_from_spec(spec)\n                    spec.loader.exec_module(module)\n                    _ZIP_EXTRACTOR_FACTORY = module._bind(ArchiveTempLease, _snapshot, _hash, _seek_at,\n                                                          _read, _write, _relative, OwnedTransferError)\n",
      "                _need(_ZIP_EXTRACTOR_FACTORY is not None, 'CAPSULE_ZIP_FACTORY_MISSING')\n");
    s = once(s, 'import importlib.util\n', '');
  }
  need(!s.includes('spec_from_file_location') && !s.includes('Path(__file__)'), 'SOURCE_PATH');
  return Buffer.from(s, 'utf8');
}
function bootstrap(envelopeSHA256) {
  return `import os, sys, json, hashlib, base64, types, threading
EXPECTED = '${envelopeSHA256}'
MAX_FRAME = ${MAX_ENVELOPE}
NAMES = ('owned-zip-worker.py', 'owned-file-transfer.py', 'owned-zip-extractor.py')
receive_lock = threading.Lock()
receive_phase = 'reading'
def receive_expired():
    global receive_phase
    with receive_lock:
        if receive_phase == 'reading':
            receive_phase = 'refused'
            os._exit(65)
receive_timer = threading.Timer(10.0, receive_expired)
receive_timer.daemon = True
receive_timer.start()
def require(value):
    if not value:
        raise RuntimeError('NATIVE_SDK_PYTHON_CAPSULE_REFUSED')
def load():
    global receive_phase
    data = bytearray()
    while True:
        chunk = os.read(0, min(65536, MAX_FRAME + 1 - len(data)))
        require(bool(chunk))
        data.extend(chunk)
        require(len(data) <= MAX_FRAME)
        at = data.find(10)
        if at >= 0:
            require(at == len(data)-1 and at > 0)
            break
    raw = bytes(data[:-1])
    require(hashlib.sha256(raw).hexdigest() == EXPECTED)
    packet = json.loads(raw.decode('utf-8'))
    require(type(packet) is dict and set(packet) == {'schema','workspaceRoot','sources'})
    require(packet['schema'] == 'native-sdk-python-capsule/1')
    require(type(packet['workspaceRoot']) is str)
    require(type(packet['sources']) is dict and set(packet['sources']) == set(NAMES))
    sources, digests = {}, {}
    for name in NAMES:
        row = packet['sources'][name]
        require(type(row) is dict and set(row) == {'bytes','sha256'})
        require(type(row['bytes']) is str and type(row['sha256']) is str)
        code = base64.b64decode(row['bytes'], validate=True)
        require(0 < len(code) <= 524288 and base64.b64encode(code).decode('ascii') == row['bytes'])
        require(hashlib.sha256(code).hexdigest() == row['sha256'])
        code.decode('utf-8', errors='strict')
        sources[name], digests[name] = code, row['sha256']
    # No queued START/control/EOF may be hidden after the source envelope.
    blocking = os.get_blocking(0)
    try:
        os.set_blocking(0, False)
        try:
            tail = os.read(0, 1)
        except BlockingIOError:
            tail = None
        require(tail is None)
    finally:
        os.set_blocking(0, blocking)
    # Reject any invalid source before the first module body is evaluated.
    compiled = {name: compile(sources[name], '<native-sdk-capsule/' + name + '>', 'exec') for name in NAMES}
    # The receive deadline may never retire an executing SDK or its custody.
    with receive_lock:
        require(receive_phase == 'reading')
        receive_phase = 'executing'
        receive_timer.cancel()
    modules = {}
    for name in NAMES:
        m = types.ModuleType('_native_sdk_' + name.replace('-', '_').replace('.', '_'))
        m.__file__ = '<native-sdk-capsule/' + name + '>'
        modules[name] = m
    custody, extractor, worker = (modules[n] for n in ('owned-file-transfer.py','owned-zip-extractor.py','owned-zip-worker.py'))
    exec(compiled['owned-file-transfer.py'], custody.__dict__)
    exec(compiled['owned-zip-extractor.py'], extractor.__dict__)
    custody._ZIP_EXTRACTOR_FACTORY = extractor._bind(custody.ArchiveTempLease, custody._snapshot, custody._hash,
        custody._seek_at, custody._read, custody._write, custody._relative, custody.OwnedTransferError)
    worker.__dict__.update(_CAPSULE_WORKSPACE=packet['workspaceRoot'], _CAPSULE_CUSTODY=custody,
        _CAPSULE_SOURCE_SHA256=digests)
    exec(compiled['owned-zip-worker.py'], worker.__dict__)
    sys.argv = ['<native-sdk-capsule/owned-zip-worker.py>']
    worker.main()
try:
    load()
except BaseException:
    sys.stderr.write('NATIVE_SDK_PYTHON_CAPSULE_REFUSED\\n')
    sys.exit(1)
`;
}

/** Trusted build input only; source paths are never reopened. */
export function buildPythonSDKCapsule(capture, workspaceRoot) {
  need(arguments.length === 2, 'ARGUMENTS');
  const root = workspace(workspaceRoot);
  const sources = {}, originalSHA256 = {}, executionSHA256 = {};
  for (const name of NAMES) {
    const raw = readCapturedNativeSDKSource(capture, name);
    originalSHA256[name] = sha(raw);
    need(originalSHA256[name] === ORIGINAL_SHA256[name], 'SOURCE_REVIEW');
    const code = transformed(name, raw);
    need(code.length > 0 && code.length <= 512*1024, 'SOURCE_LIMIT');
    executionSHA256[name] = sha(code);
    sources[name] = {bytes: code.toString('base64'), sha256: executionSHA256[name]};
  }
  const envelope = JSON.stringify({schema:'native-sdk-python-capsule/1', workspaceRoot:root, sources});
  need(Buffer.byteLength(envelope)+1 <= MAX_ENVELOPE, 'ENVELOPE_LIMIT');
  const code = bootstrap(sha(envelope));
  need(Buffer.byteLength(code) <= 16*1024, 'BOOTSTRAP_LIMIT');
  return Object.freeze({bootstrap:code, envelope,
    executionSHA256:Object.freeze(executionSHA256), originalSHA256:Object.freeze(originalSHA256)});
}
