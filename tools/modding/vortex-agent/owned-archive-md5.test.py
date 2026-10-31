"""Own fresh fixtures only: held archive hash pair, not Vortex/installation proof."""
import hashlib
import importlib.util
import io
import os
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import patch
import zipfile

HERE = Path(__file__).absolute().parent
SCRATCH = HERE.parents[2]/'local-state/executor-pending-anchor/recovery/md5-tests'
def load(name, file):
    spec = importlib.util.spec_from_file_location(name, HERE/file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module
base = load('_md5_held_transfer', 'owned-file-transfer.py')
worker = load('_md5_owned_worker', 'owned-zip-worker.py')
BINDING = {'operationId': 'op_'+'1'*32, 'nativeJobId': 'exec_'+'2'*32,
           'requestSHA256': '3'*64, 'rendererGeneration': 'renderer_'+'4'*32}
PIN = {'schema': 'win-file-id128/1', 'volumeSerialNumber': '1', 'fileId': '2'}

class HashPairPortable(unittest.TestCase):
    def test_one_seek_same_chunks_and_one_eof_for_both_hashes(self):
        data = b'own-chunk\x00\xff'*(base.CHUNK_BYTES//5)
        source = io.BytesIO(data)
        calls, seeks = [], []
        def read(handle, size):
            self.assertIs(handle, source)
            value = source.read(size); calls.append((size, len(value))); return value
        with patch.object(base, '_seek', lambda h: (self.assertIs(h, source), seeks.append(h), source.seek(0))), patch.object(base, '_read', read):
            sha, md5 = base._hash_pair(source, len(data))
        self.assertEqual(sha, hashlib.sha256(data).hexdigest())
        self.assertEqual(md5, hashlib.md5(data).hexdigest())
        self.assertEqual(len(seeks), 1)
        self.assertEqual(sum(n for _, n in calls), len(data))
        self.assertEqual(calls[-1], (1, 0))
        self.assertTrue(all(n <= base.CHUNK_BYTES for n, _ in calls))

    def packet(self, staging=True):
        archive = {'parent': 'F:/OwnFixture/Archives', 'parentIdentity': PIN, 'leaf': 'own.zip',
                   'identity': PIN, 'bytes': 10, 'sha256': 'a'*64}
        if staging: archive['md5'] = 'b'*32
        value = {'schema': 'owned-zip-worker-start/2' if staging else 'owned-zip-worker-start/1',
                 'workerLifetime': 'worker_'+'5'*32, 'binding': BINDING, 'archive': archive,
                 'payload': {'own.txt': 'a'*64}, 'total': 1}
        if staging: value['destination'] = {'parent': 'F:/OwnFixture/Staging', 'parentIdentity': PIN, 'leaf': 'Own'}
        transport = worker.Transport(value['workerLifetime'], base)
        if staging:
            transport.prepare_seen = True
            transport.binding = dict(BINDING)
            transport.prepared_destination = dict(value['destination'])
        return transport, value

    def test_staging_requires_exact_lowercase_md5_while_scratch_keeps_six_fields(self):
        transport, packet = self.packet()
        transport.validate_start(packet)
        for value in [None, '', 'A'*32, 'b'*31, 'b'*32+'\n', 123, False]:
            transport, packet = self.packet();packet['archive']['md5'] = value
            with self.assertRaisesRegex(RuntimeError, 'ARCHIVE_REFUSED'):
                transport.validate_start(packet)
        transport, packet = self.packet(); del packet['archive']['md5']
        with self.assertRaisesRegex(RuntimeError, 'ARCHIVE_REFUSED'): transport.validate_start(packet)
        transport, packet = self.packet(False); transport.validate_start(packet)
        packet['archive']['md5'] = 'b'*32
        with self.assertRaisesRegex(RuntimeError, 'ARCHIVE_REFUSED'): transport.validate_start(packet)

    def test_worker_forwards_md5_and_acquires_before_any_zip_start(self):
        transport, packet = self.packet(); events = []
        pool = types.SimpleNamespace(owners=[])
        owner = types.SimpleNamespace(start=lambda: events.append('zip-start'))
        class Lease:
            def __init__(self, *args, **kwargs):
                events.append(('md5', kwargs)); self._pool = pool; pool.owners.append(self)
            def create_zip_extractor(self, *args): events.append('inert-factory'); return owner
            def acquire(self): events.append('acquire-pair'); raise RuntimeError('OWN_FIXTURE_MD5_HOLD')
        facade = types.SimpleNamespace(ArchiveTempLease=Lease, _root=base._root, _label=lambda value: PIN)
        guard = types.SimpleNamespace(_pool=pool, _lock=object(), _thread=object(), _root_handle=lambda p: 1,
            _open=lambda *args, **kwargs: (1, ('1:2', 0)), _observe_prepared_destination=lambda v: v)
        subject = worker.Worker(facade, guard, transport)
        subject.destination_mode = True; subject.binding = dict(BINDING)
        subject.prepared_destination = dict(packet['destination'])
        with self.assertRaisesRegex(RuntimeError, 'MD5_HOLD'): subject.start(packet, 'a'*64)
        self.assertEqual(events, [('md5', {'expected_md5': 'b'*32}), 'inert-factory', 'acquire-pair'])
        self.assertIsNotNone(subject.lease)

@unittest.skipUnless(os.name == 'nt' and os.environ.get('VORTEX_OWNED_MD5_TEST') == '1', 'Explicit own NTFS lease fixture opt-in')
class NativeHashPair(unittest.TestCase):
    def setUp(self):
        for p in [SCRATCH, *SCRATCH.parents]:
            try: stat = p.lstat()
            except FileNotFoundError: continue
            self.assertFalse(getattr(stat, 'st_file_attributes', 0) & 0x400)
        SCRATCH.mkdir(parents=True, exist_ok=True)
        self.root = Path(tempfile.mkdtemp(prefix='run-', dir=SCRATCH))
        self.archives = self.root/'archives'; self.temp = self.root/'temp'
        self.archives.mkdir(); self.temp.mkdir(); self.archive = self.archives/'own.zip'
        with zipfile.ZipFile(self.archive, 'w', compression=zipfile.ZIP_STORED) as z:
            z.writestr('own.bin', b'own-byte\x00\xff'*(base.CHUNK_BYTES//3))
        self.data = self.archive.read_bytes(); self.leases = []
        self.addCleanup(self.close_leases)
    def close_leases(self):
        for lease in reversed(self.leases): lease.close()
    def identity(self, p):
        stat = p.stat()
        return {'schema': base.IDENTITY_SCHEMA, 'volumeSerialNumber': str(stat.st_dev), 'fileId': str(stat.st_ino)}
    def lease(self, md5=True, sha=None, leaf='Extract'):
        kwargs = {} if md5 is None else {'expected_md5': hashlib.md5(self.data).hexdigest() if md5 is True else md5}
        lease = base.ArchiveTempLease(BINDING, str(self.archives), self.identity(self.archives), 'own.zip',
            self.identity(self.archive), len(self.data), sha or hashlib.sha256(self.data).hexdigest(),
            str(self.temp), self.identity(self.temp), leaf, **kwargs)
        self.leases.append(lease); return lease
    def test_valid_pair_reads_actual_original_handle_once_before_temp_creation(self):
        lease = self.lease(); read, seek = base._read, base._seek; reads, seeks = [], []
        def sample(handle, count):
            value = read(handle, count);reads.append((handle, count, len(value)));return value
        def position(handle): seeks.append(handle);return seek(handle)
        with patch.object(base, '_read', sample), patch.object(base, '_seek', position), patch.object(base, '_hash', side_effect=AssertionError('No separate SHA pass')):
            state = lease.acquire()
        self.assertTrue(state['acquired']);self.assertTrue((self.temp/'Extract').is_dir())
        self.assertEqual(seeks, [lease._archive_handle])
        self.assertTrue(all(h == lease._archive_handle for h, _, _ in reads))
        self.assertEqual(sum(n for _, _, n in reads), len(self.data));self.assertEqual(reads[-1][1:], (1, 0))
        self.assertFalse(state['effectsAllowed'])
    def test_wrong_md5_keeps_archive_custody_and_creates_no_extract(self):
        lease = self.lease('0'*32)
        with self.assertRaisesRegex(base.OwnedTransferError, 'ARCHIVE_MISMATCH'): lease.acquire()
        self.assertTrue(lease.status()['poisoned']);self.assertGreater(lease.status()['retainedHandles'], 0)
        self.assertFalse((self.temp/'Extract').exists())
        with self.assertRaises(OSError): self.archive.write_bytes(b'blocked')
        with self.assertRaises(base.OwnedTransferError): lease.acquire()
        lease.close();self.archive.write_bytes(b'allowed-after-close')
    def test_stale_sha_cannot_be_rescued_by_correct_md5(self):
        lease = self.lease(sha='0'*64)
        with self.assertRaisesRegex(base.OwnedTransferError, 'ARCHIVE_MISMATCH'): lease.acquire()
        self.assertTrue(lease.status()['poisoned']);self.assertFalse((self.temp/'Extract').exists())
    def test_legacy_sha_only_still_uses_original_hash_path(self):
        lease = self.lease(md5=None)
        with patch.object(base, '_hash', wraps=base._hash) as sha, patch.object(base, '_hash_pair', side_effect=AssertionError('Legacy needs no MD5')):
            lease.acquire()
        self.assertEqual(sha.call_count, 1)
    def test_invalid_md5_is_inert_constructor_refusal(self):
        for value in ['', 'A'*32, 'a'*31, 123, False]:
            with self.assertRaisesRegex(base.OwnedTransferError, 'INVALID_PROOF'): self.lease(value)
        self.assertFalse((self.temp/'Extract').exists())

if __name__ == '__main__': unittest.main()
