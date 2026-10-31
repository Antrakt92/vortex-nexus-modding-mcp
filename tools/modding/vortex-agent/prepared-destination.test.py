"""Own NTFS fixtures only; no Vortex or managed staging paths."""
import hashlib
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile

HERE = Path(__file__).absolute().parent
ROOT = HERE.parents[2]/'local-state/install-contract-20261031/prepared-destination-tests'
if os.name == 'nt':
    spec = importlib.util.spec_from_file_location('prepared_destination_custody', HERE/'owned-file-transfer.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)


@unittest.skipUnless(os.name == 'nt', 'Windows native handles required')
class PreparedDestinationTests(unittest.TestCase):
    def setUp(self):
        for path in [ROOT, *ROOT.parents]:
            if path.exists():
                self.assertFalse(path.lstat().st_file_attributes & 0x400)
        ROOT.mkdir(parents=True, exist_ok=True)
        self.root = Path(tempfile.mkdtemp(prefix='run-', dir=ROOT))
        self.stage, self.archives, self.temps = [self.root/name for name in ('stage', 'archives', 'temps')]
        for path in (self.stage, self.archives, self.temps):
            path.mkdir()
        class Guard(module._HandleCustody):
            def __init__(self):
                self._init_custody()
                self._closed = self._poisoned = False
            def status(self):
                return {'closed': self._closed, 'retainedHandles': len(self._handles)}
        self.Guard = Guard
        self.guard = Guard()
        self.owners = [self.guard]
        self.addCleanup(self.close_all)

    def close_all(self):
        for owner in reversed(self.owners):
            owner.close()

    def identity(self, path):
        stat = path.stat()
        return {'schema': module.IDENTITY_SCHEMA, 'volumeSerialNumber': str(stat.st_dev), 'fileId': str(stat.st_ino)}

    def source(self):
        data = b'own exact ZIP payload'
        archive = self.archives/'own.zip'
        with zipfile.ZipFile(archive, 'x') as output:
            output.writestr('payload.bin', data)
        raw = archive.read_bytes()
        binding = {'operationId': 'op_'+'1'*32, 'nativeJobId': 'exec_'+'2'*32,
                   'requestSHA256': '3'*64, 'rendererGeneration': 'renderer_'+'4'*32}
        lease = module.ArchiveTempLease(binding, str(self.archives), self.identity(self.archives),
            archive.name, self.identity(archive), len(raw), hashlib.sha256(raw).hexdigest(),
            str(self.temps), self.identity(self.temps), 'Extract')
        lease._pool.owners.remove(lease)
        lease._pool = self.guard._pool
        lease._pool.owners.append(lease)
        lease._lock, lease._thread = self.guard._lock, self.guard._thread
        self.owners.append(lease)
        decoder = lease.create_zip_extractor({'payload.bin': hashlib.sha256(data).hexdigest()}, len(data))
        lease.acquire()
        decoder.start()
        for _ in range(100):
            decoder.pump()
            if decoder.status()['completed']:
                break
        self.assertTrue(decoder.status()['completed'])
        decoder.close()
        return lease, data

    def test_prepare_is_read_only_and_holds_exact_parent(self):
        prepared = self.guard._prepare_destination(str(self.stage), 'Own')
        observation = self.guard._observe_prepared_destination(prepared)
        self.assertEqual(observation['parentIdentity'], self.identity(self.stage))
        self.assertEqual(observation['leaf'], 'Own')
        self.assertFalse((self.stage/'Own').exists())
        with self.assertRaises(PermissionError):
            self.stage.rename(self.root/'renamed')
        observation['parentIdentity']['fileId'] = '1'
        self.assertEqual(self.guard._observe_prepared_destination(prepared)['parentIdentity'], self.identity(self.stage))

    def test_borrow_uses_held_handle_without_reopening_parent(self):
        prepared = self.guard._prepare_destination(str(self.stage), 'Own')
        lease, data = self.source()
        with patch.object(module._HandleCustody, '_existing_root', side_effect=AssertionError('reopened parent')):
            child = lease.begin_transfer_prepared(self.guard, prepared)
        self.owners.append(child)
        proof = child.transfer('payload.bin', 'payload.bin', len(data), hashlib.sha256(data).hexdigest())
        self.assertEqual(proof['destinationIdentity'], self.identity(self.stage/'Own/payload.bin'))
        self.assertEqual(child.destination_observation()['directoryIdentity'], self.identity(self.stage/'Own'))
        self.assertEqual((self.stage/'Own/payload.bin').read_bytes(), data)
        with self.assertRaises(module.OwnedTransferError):
            lease.begin_transfer_prepared(self.guard, prepared)

    def test_existing_casefold_target_is_preserved(self):
        (self.stage/'oWN').mkdir()
        sentinel = self.stage/'oWN/sentinel'
        sentinel.write_bytes(b'keep')
        prepared = self.guard._prepare_destination(str(self.stage), 'Own')
        lease, _ = self.source()
        with self.assertRaisesRegex(module.OwnedTransferError, 'CREATE_REFUSED'):
            lease.begin_transfer_prepared(self.guard, prepared)
        if lease._borrow is not None:
            self.owners.append(lease._borrow)
        self.assertEqual(sentinel.read_bytes(), b'keep')
        self.assertEqual(list((self.stage/'oWN').iterdir()), [sentinel])

    def test_foreign_token_cannot_create_destination(self):
        prepared = self.guard._prepare_destination(str(self.stage), 'Own')
        lease, _ = self.source()
        foreign = self.Guard()
        self.owners.append(foreign)
        with self.assertRaises(module.OwnedTransferError):
            lease.begin_transfer_prepared(foreign, prepared)
        self.assertFalse((self.stage/'Own').exists())

    def test_closed_parent_or_repeated_prepare_refuses(self):
        prepared = self.guard._prepare_destination(str(self.stage), 'Own')
        lease, _ = self.source()
        self.guard.close()
        with self.assertRaises(module.OwnedTransferError):
            lease.begin_transfer_prepared(self.guard, prepared)
        self.assertFalse((self.stage/'Own').exists())


if __name__ == '__main__':
    unittest.main()
