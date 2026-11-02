"""Own ignored scratch only; no Vortex, game, staging or external filesystem tests."""
import ctypes
import hashlib
import importlib.util
import inspect
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

HERE = Path(__file__).absolute().parent
WORKSPACE = HERE.parents[2]
SANDBOX = WORKSPACE/'local-state/install-contract-20261031/owned-transfer-tests'
spec = importlib.util.spec_from_file_location('owned_file_transfer', HERE/'owned-file-transfer.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


@unittest.skipUnless(os.name == 'nt', 'Windows native handles required')
class OwnedFileTransferTests(unittest.TestCase):
    def setUp(self):
        # Preserve every run; no recursive or failure cleanup in this experiment.
        for ancestor in [SANDBOX, *SANDBOX.parents]:
            try:
                observed = ancestor.lstat()
            except FileNotFoundError:
                continue
            self.assertFalse(getattr(observed, 'st_file_attributes', 0) & 0x400)
        SANDBOX.mkdir(parents=True, exist_ok=True)
        self.root = Path(tempfile.mkdtemp(prefix='run-', dir=SANDBOX))
        self.source = self.root/'source'
        self.parent = self.root/'parent'
        self.source.mkdir()
        self.parent.mkdir()
        self.leases = []
        self.addCleanup(self.close_all)

    def close_all(self):
        for lease in reversed(self.leases):
            lease.close()

    def identity(self, path):
        observed = path.stat()
        return {'schema': module.IDENTITY_SCHEMA, 'volumeSerialNumber': str(observed.st_dev), 'fileId': str(observed.st_ino)}

    def lease(self, source=None, parent=None, leaf='Owned', source_pin=None, parent_pin=None):
        source, parent = source or self.source, parent or self.parent
        lease = module.OwnedFileTransfer(str(source), source_pin or self.identity(source), str(parent),
                                         parent_pin or self.identity(parent), leaf)
        self.leases.append(lease)
        return lease

    def payload(self, name='own.bin', data=b'own fixture\x00\xff'):
        file = self.source/name
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_bytes(data)
        return name, len(data), hashlib.sha256(data).hexdigest()

    def test_inert_constructor_and_native_identity_domain(self):
        lease = self.lease()
        self.assertEqual(lease.status()['retainedHandles'], 0)
        self.assertFalse((self.parent/'Owned').exists())
        state = lease.acquire()
        self.assertTrue(state['acquired'])
        self.assertFalse(state['effectsAllowed'])
        # Actual FILE_ID_INFO observations must equal independent Python3.14 stat.
        self.assertEqual(module._snapshot(lease._source_dirs[()], True)[0],
                         f'{self.source.stat().st_dev}:{self.source.stat().st_ino}')
        with self.assertRaisesRegex(module.OwnedTransferError, 'INVALID_IDENTITY'):
            self.lease(source_pin=f'{self.source.stat().st_dev}:{self.source.stat().st_ino}')

    def test_transfer_bytes_identity_chunking_and_close_release(self):
        source, size, digest = self.payload('nested/own.bin', b'x'*(module.CHUNK_BYTES+3))
        lease = self.lease()
        lease.acquire()
        result = lease.transfer(source, 'nested/copied.bin', size, digest)
        destination = self.parent/'Owned/nested/copied.bin'
        self.assertEqual(destination.read_bytes(), b'x'*size)
        self.assertEqual(result['destinationIdentity'], self.identity(destination))
        self.assertEqual(result['sourceIdentity'], self.identity(self.source/source))
        with self.assertRaises(OSError):
            destination.write_bytes(b'blocked')
        with self.assertRaises(OSError):
            destination.rename(destination.with_name('blocked.bin'))
        lease.close()
        destination.write_bytes(b'allowed after close')
        destination.rename(destination.with_name('closed.bin'))

    def test_wrong_root_pin_fails_before_destination_creation_and_retains_owner(self):
        bad = self.identity(self.source)
        bad['fileId'] = str(int(bad['fileId'])+987654321)
        lease = self.lease(source_pin=bad)
        with self.assertRaisesRegex(module.OwnedTransferError, 'ROOT_IDENTITY_MISMATCH') as error:
            lease.acquire()
        self.assertIs(error.exception.lease, lease)
        self.assertTrue(lease.status()['poisoned'])
        self.assertGreater(lease.status()['retainedHandles'], 0)
        self.assertFalse((self.parent/'Owned').exists())

    def test_empty_existing_target_and_case_alias_never_adopted(self):
        (self.parent/'Owned').mkdir()
        for leaf in ['Owned', 'owned']:
            lease = self.lease(leaf=leaf)
            with self.assertRaisesRegex(module.OwnedTransferError, 'CREATE_REFUSED'):
                lease.acquire()
        self.assertEqual(list((self.parent/'Owned').iterdir()), [])

    def test_source_hash_size_failure_holds_without_creating_destination_leaf(self):
        name, size, digest = self.payload()
        for wrong_size, wrong_hash in [(size+1, digest), (size, '0'*64)]:
            lease = self.lease(leaf='Owner'+str(wrong_size)+wrong_hash[:1])
            lease.acquire()
            with self.assertRaisesRegex(module.OwnedTransferError, 'SOURCE_MISMATCH'):
                lease.transfer(name, 'copy.bin', wrong_size, wrong_hash)
            self.assertFalse((self.parent/lease._leaf/'copy.bin').exists())
            self.assertTrue(lease.status()['poisoned'])
            with self.assertRaisesRegex(module.OwnedTransferError, 'HELD'):
                lease.transfer(name, 'another.bin', size, digest)

    def test_partial_write_failure_retains_partial_file_and_handles(self):
        name, size, digest = self.payload(data=b'bounded partial fixture')
        lease = self.lease()
        lease.acquire()
        original = module._write
        def partial(handle, data):
            original(handle, data[:1])
            raise OSError('private details must not escape')
        with patch.object(module, '_write', partial):
            with self.assertRaisesRegex(module.OwnedTransferError, '^OWNED_TRANSFER_IO_FAILED$') as error:
                lease.transfer(name, 'partial.bin', size, digest)
        self.assertIs(error.exception.lease, lease)
        destination = self.parent/'Owned/partial.bin'
        self.assertEqual(destination.read_bytes(), b'b')
        with self.assertRaises(OSError):
            destination.unlink()
        self.assertTrue(lease.status()['poisoned'])
        lease.close()
        self.assertEqual(destination.read_bytes(), b'b')

    def test_source_hardlink_alias_write_is_denied_while_borrowed(self):
        name, size, digest = self.payload()
        alias = self.source/'alias.bin'
        os.link(self.source/name, alias)
        lease = self.lease()
        lease.acquire()
        lease.transfer(name, 'copy.bin', size, digest)
        self.assertEqual(self.identity(alias), self.identity(self.source/name))
        with self.assertRaises(OSError):
            alias.write_bytes(b'blocked')
        lease.close()
        alias.write_bytes(b'allowed after close')

    def test_relative_aliases_existing_subdirectory_and_leaf_collisions_refuse(self):
        name, size, digest = self.payload()
        invalid = ['../x', 'a/../x', 'x.', 'x ', 'CON.txt', 'CONIN$', 'a:b', 'a\\b', 'SHORT~1', '/x']
        for n, destination in enumerate(invalid):
            lease = self.lease(leaf=f'Invalid{n}')
            lease.acquire()
            with self.assertRaises(module.OwnedTransferError):
                lease.transfer(name, destination, size, digest)
        lease = self.lease()
        lease.acquire()
        (self.parent/'Owned/Foreign').mkdir()
        with self.assertRaisesRegex(module.OwnedTransferError, 'CREATE_REFUSED'):
            lease.transfer(name, 'Foreign/copy.bin', size, digest)
        other = self.lease(leaf='Other')
        other.acquire()
        (self.parent/'Other/existing.bin').write_bytes(b'foreign')
        with self.assertRaisesRegex(module.OwnedTransferError, 'CREATE_REFUSED'):
            other.transfer(name, 'EXISTING.bin', size, digest)
        self.assertEqual((self.parent/'Other/existing.bin').read_bytes(), b'foreign')

    def test_root_junction_and_source_subdirectory_junction_are_refused(self):
        junction = self.root/'junction'
        code = "require('node:fs').symlinkSync(process.argv[1],process.argv[2],'junction')"
        subprocess.run(['node', '-e', code, str(self.source), str(junction)], check=True, capture_output=True, timeout=10)
        lease = self.lease(source=junction)
        with self.assertRaises(module.OwnedTransferError):
            lease.acquire()
        self.assertFalse((self.parent/'Owned').exists())
        target = self.source/'regular'
        target.mkdir()
        (target/'a.bin').write_bytes(b'x')
        nested = self.source/'linked'
        subprocess.run(['node', '-e', code, str(target), str(nested)], check=True, capture_output=True, timeout=10)
        second = self.lease(leaf='Second')
        second.acquire()
        with self.assertRaises(module.OwnedTransferError):
            second.transfer('linked/a.bin', 'copy.bin', 1, hashlib.sha256(b'x').hexdigest())
        self.assertFalse((self.parent/'Second/copy.bin').exists())

    def test_sibling_source_under_parent_is_allowed_but_final_overlap_refuses(self):
        source = self.parent/'Owner.installing'
        source.mkdir()
        (source/'a.bin').write_bytes(b'x')
        lease = self.lease(source=source, leaf='Owner')
        lease.acquire()
        lease.transfer('a.bin', 'a.bin', 1, hashlib.sha256(b'x').hexdigest())
        self.assertEqual((self.parent/'Owner/a.bin').read_bytes(), b'x')
        with self.assertRaisesRegex(module.OwnedTransferError, 'ROOT_OVERLAP'):
            self.lease(source=source, leaf='Owner.installing')
        with self.assertRaisesRegex(module.OwnedTransferError, 'ROOT_OVERLAP'):
            self.lease(source=self.parent)

    def test_preexisting_source_writer_and_parent_rename_are_denied(self):
        name, size, digest = self.payload()
        lease = self.lease()
        lease.acquire()
        with self.assertRaises(OSError):
            self.parent.rename(self.root/'renamed-parent')
        with (self.source/name).open('r+b'):
            with self.assertRaisesRegex(module.OwnedTransferError, 'OPEN_REFUSED'):
                lease.transfer(name, 'copy.bin', size, digest)
        self.assertFalse((self.parent/'Owned/copy.bin').exists())

    def test_nonlocal_drive_filesystem_and_nonwindows_refuse_before_root_creation(self):
        for function, fake in [('GetDriveTypeW', lambda *_: 4),
                               ('GetVolumeInformationByHandleW', lambda *_: False)]:
            lease = self.lease(leaf=function)
            with patch.object(module._K, function, fake):
                with self.assertRaisesRegex(module.OwnedTransferError, 'UNSUPPORTED_'):
                    lease.acquire()
            self.assertFalse((self.parent/function).exists())
        with patch.object(module.os, 'name', 'posix'):
            with self.assertRaisesRegex(module.OwnedTransferError, 'UNSUPPORTED_PLATFORM'):
                module.OwnedFileTransfer('', {}, '', {}, '')
        with patch.object(module, '_abi', lambda: False):
            with self.assertRaisesRegex(module.OwnedTransferError, 'UNSUPPORTED_ABI'):
                module.OwnedFileTransfer('', {}, '', {}, '')
        lease = self.lease(leaf='Mapped')
        def redirected(_name, buffer, _length):
            buffer.value = '\\??\\F:\\other'
            return len(buffer.value) + 1
        with patch.object(module._K, 'QueryDosDeviceW', redirected):
            with self.assertRaisesRegex(module.OwnedTransferError, 'UNSUPPORTED_DRIVE_MAPPING'):
                lease.acquire()
        self.assertFalse((self.parent/'Mapped').exists())

    def test_failed_close_retains_handle_and_never_claims_released(self):
        lease = self.lease()
        lease.acquire()
        before = lease.status()['retainedHandles']
        with patch.object(module._K, 'CloseHandle', lambda *_: False):
            with self.assertRaisesRegex(module.OwnedTransferError, 'CLOSE_FAILED'):
                lease.close()
        self.assertEqual(lease.status()['retainedHandles'], before)
        self.assertFalse(lease.status()['closed'])
        self.assertTrue(lease.status()['poisoned'])
        lease.close()
        self.assertEqual(lease.status()['retainedHandles'], 0)

    def test_nested_close_is_refused_without_double_close(self):
        lease = self.lease()
        entry = module._HandleEntry()
        entry.cell.value = 101
        lease._handles = [entry]
        calls = []
        def nested(handle):
            calls.append(handle)
            with self.assertRaisesRegex(module.OwnedTransferError, 'BUSY_OR_WRONG_THREAD'):
                lease.close()
            return True
        try:
            with patch.object(module._K, 'CloseHandle', nested):
                self.assertTrue(lease.close()['closed'])
            self.assertEqual(calls, [101])
        finally:
            lease._handles = []  # Synthetic handles never reach the actual API.

    def test_interrupted_close_removes_known_closed_entries_and_never_retries_uncertain(self):
        lease = self.lease()
        lease._handles = [module._HandleEntry() for _ in range(3)]
        for entry, value in zip(lease._handles, [101, 102, 103]):
            entry.cell.value = value
        calls = []
        def interrupted(handle):
            calls.append(handle)
            if handle == 102:
                raise KeyboardInterrupt()
            return True
        try:
            with patch.object(module._K, 'CloseHandle', interrupted):
                with self.assertRaises(KeyboardInterrupt):
                    lease.close()
                self.assertEqual([entry.cell.value for entry in lease._handles], [101, 102])
                with self.assertRaisesRegex(module.OwnedTransferError, 'CLOSE_FAILED'):
                    lease.close()
                self.assertEqual([entry.cell.value for entry in lease._handles], [102])
            self.assertEqual(calls, [103, 102, 101])
            self.assertTrue(lease.status()['closeUncertain'])
            self.assertFalse(lease.status()['closed'])
        finally:
            lease._handles = []

    def test_interrupted_transfer_poison_retains_partial_output(self):
        name, size, digest = self.payload()
        lease = self.lease()
        lease.acquire()
        original = module._write
        def interrupted(handle, data):
            original(handle, data[:1])
            raise KeyboardInterrupt()
        with patch.object(module, '_write', interrupted):
            with self.assertRaises(KeyboardInterrupt) as error:
                lease.transfer(name, 'partial.bin', size, digest)
        self.assertIs(error.exception.lease, lease)
        self.assertTrue(lease.status()['poisoned'])
        self.assertEqual((self.parent/'Owned/partial.bin').read_bytes(), b'o')

    def test_interrupt_after_native_close_cannot_retry_reused_raw_handle(self):
        lease = self.lease()
        entry = module._HandleEntry()
        entry.cell.value = 101
        lease._handles = [entry]
        lines, start = inspect.getsourcelines(module.OwnedFileTransfer._release_handle)
        target = start + next(n for n, line in enumerate(lines) if 'if success:' in line)
        calls = []
        def trace(frame, event, _arg):
            if frame.f_code is module.OwnedFileTransfer._release_handle.__code__ and event == 'line' and frame.f_lineno == target:
                raise KeyboardInterrupt()
            return trace
        try:
            with patch.object(module._K, 'CloseHandle', lambda raw: calls.append(raw) or True):
                previous = sys.gettrace()
                try:
                    sys.settrace(trace)
                    with self.assertRaises(KeyboardInterrupt):
                        lease.close()
                finally:
                    sys.settrace(previous)
                self.assertTrue(lease.status()['poisoned'])
                self.assertTrue(lease.status()['closeUncertain'])
                with self.assertRaisesRegex(module.OwnedTransferError, 'CLOSE_FAILED'):
                    lease.close()
            self.assertEqual(calls, [101])
        finally:
            lease._handles = []

    def test_interrupt_after_kernel_create_retains_output_cell_and_new_directory(self):
        lease = self.lease()
        original = module._N.NtCreateFile
        def interrupted(*args):
            result = original(*args)
            if args[7] == 2 and result >= 0:
                raise KeyboardInterrupt()
            return result
        with patch.object(module._N, 'NtCreateFile', interrupted):
            with self.assertRaises(KeyboardInterrupt) as error:
                lease.acquire()
        self.assertIs(error.exception.lease, lease)
        self.assertTrue(lease.status()['poisoned'])
        destination = self.parent/'Owned'
        self.assertTrue(destination.exists())
        self.assertIsNotNone(lease._handles[-1].cell.value)
        with self.assertRaises(OSError):
            destination.rename(self.parent/'blocked')
        lease.close()
        destination.rename(self.parent/'after-close')

    def test_interrupt_during_new_file_information_retains_created_file(self):
        name, size, digest = self.payload()
        lease = self.lease()
        lease.acquire()
        original = module._snapshot
        def interrupted(handle, directory):
            observed = original(handle, directory)
            if not directory and observed[1] == 0:
                raise KeyboardInterrupt()
            return observed
        with patch.object(module, '_snapshot', interrupted):
            with self.assertRaises(KeyboardInterrupt) as error:
                lease.transfer(name, 'empty-partial.bin', size, digest)
        self.assertIs(error.exception.lease, lease)
        self.assertTrue(lease.status()['poisoned'])
        destination = self.parent/'Owned/empty-partial.bin'
        self.assertEqual(destination.stat().st_size, 0)
        with self.assertRaises(OSError):
            destination.unlink()

    def test_destination_hardlink_appearance_before_readback_holds(self):
        name, size, digest = self.payload()
        lease = self.lease()
        lease.acquire()
        original = module._write
        def alias_after_write(handle, data):
            original(handle, data)
            os.link(self.parent/'Owned/copy.bin', self.parent/'Owned/alias.bin')
        with patch.object(module, '_write', alias_after_write):
            with self.assertRaisesRegex(module.OwnedTransferError, 'DESTINATION_MISMATCH'):
                lease.transfer(name, 'copy.bin', size, digest)
        self.assertTrue(lease.status()['poisoned'])
        self.assertEqual(self.identity(self.parent/'Owned/copy.bin'), self.identity(self.parent/'Owned/alias.bin'))
        with self.assertRaises(OSError):
            (self.parent/'Owned/alias.bin').write_bytes(b'blocked')

    def test_thread_and_reentrant_close_cannot_release_an_active_copy(self):
        name, size, digest = self.payload()
        lease = self.lease()
        lease.acquire()
        errors = []
        thread = threading.Thread(target=lambda: self._cross_thread(lease, errors))
        thread.start()
        thread.join(timeout=2)
        self.assertFalse(thread.is_alive())
        self.assertEqual(errors, ['OWNED_TRANSFER_BUSY_OR_WRONG_THREAD'])
        original = module._write
        def reentrant(handle, data):
            with self.assertRaisesRegex(module.OwnedTransferError, 'BUSY_OR_WRONG_THREAD'):
                lease.close()
            original(handle, data)
        with patch.object(module, '_write', reentrant):
            lease.transfer(name, 'copy.bin', size, digest)
        self.assertFalse(lease.status()['closed'])

    def _cross_thread(self, lease, errors):
        try:
            lease.close()
        except module.OwnedTransferError as error:
            errors.append(str(error))

    def test_multiple_files_zero_length_and_aggregate_limit_boundaries(self):
        name, size, digest = self.payload()
        empty, zero, empty_digest = self.payload('empty.bin', b'')
        lease = self.lease()
        lease.acquire()
        lease.transfer(name, 'a.bin', size, digest)
        lease.transfer(empty, 'empty.bin', zero, empty_digest)
        self.assertEqual(lease.status()['attemptedFiles'], 2)
        self.assertEqual((self.parent/'Owned/empty.bin').stat().st_size, 0)
        with patch.object(module, 'MAX_FILES', 2):
            with self.assertRaisesRegex(module.OwnedTransferError, 'LIMIT'):
                lease.transfer(name, 'b.bin', size, digest)
        budget = self.lease(leaf='Budget')
        budget.acquire()
        with patch.object(module, 'MAX_TOTAL_BYTES', size):
            budget.transfer(name, 'fits.bin', size, digest)
            with self.assertRaisesRegex(module.OwnedTransferError, 'LIMIT'):
                budget.transfer(name, 'exceeds.bin', size, digest)
        self.assertFalse((self.parent/'Budget/exceeds.bin').exists())
        handles = self.lease(leaf='Handles')
        handles.acquire()
        with patch.object(module, 'MAX_HANDLES', handles.status()['retainedHandles']):
            with self.assertRaisesRegex(module.OwnedTransferError, 'HANDLE_LIMIT'):
                handles.transfer(name, 'exceeds.bin', size, digest)
        self.assertFalse((self.parent/'Handles/exceeds.bin').exists())


    def test_archive_observer_native_identity_and_no_outputs(self):
        import msvcrt
        data = b'own archive observation fixture\n'
        self.payload('own.zip', data)
        file = self.source/'own.zip'
        before = file.stat()
        observation = module.OwnedArchiveObservation(str(self.source), file.name, len(data),
                        hashlib.sha256(data).hexdigest(), hashlib.md5(data).hexdigest())
        self.leases.append(observation)
        with patch.object(module, '_write', side_effect=AssertionError('observer attempted write')):
            result = observation.observe()
        self.assertEqual(set(result), {'parent', 'parentIdentity', 'leaf', 'identity', 'bytes', 'sha256'})
        # Explicit FileIdInfo on an independent read FD, never stat as identity authority.
        with file.open('rb') as stream:
            info = module._Identity()
            self.assertTrue(module._K.GetFileInformationByHandleEx(
                msvcrt.get_osfhandle(stream.fileno()), 18, ctypes.byref(info), ctypes.sizeof(info)))
            identity = {'schema': module.IDENTITY_SCHEMA, 'volumeSerialNumber': str(info.volume),
                        'fileId': str(int.from_bytes(bytes(info.file), 'little'))}
        self.assertEqual(result['identity'], identity)
        self.assertEqual(result['sha256'], hashlib.sha256(data).hexdigest())
        self.assertEqual(result['bytes'], len(data))
        self.assertTrue(observation.status()['closed'])
        self.assertEqual(observation.status()['retainedHandles'], 0)
        after = file.stat()
        self.assertEqual((before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns),
                         (after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns))
        self.assertEqual(file.read_bytes(), data)
        self.assertEqual({p.name for p in self.root.iterdir()}, {'source', 'parent'})
        self.assertEqual({p.name for p in self.source.iterdir()}, {'own.zip'})
        self.assertEqual(list(self.parent.iterdir()), [])

    def test_archive_observer_native_hardlink_refuses_before_hash(self):
        self.payload('own.zip', b'own archive fixture')
        file = self.source/'own.zip'
        alias = self.source/'alias.zip'
        os.link(file, alias)
        data = file.read_bytes()
        observation = module.OwnedArchiveObservation(str(self.source), file.name, len(data),
                        hashlib.sha256(data).hexdigest(), hashlib.md5(data).hexdigest())
        self.leases.append(observation)
        with patch.object(module, '_hash_pair', side_effect=AssertionError('hardlink was read')):
            with self.assertRaisesRegex(module.OwnedTransferError, 'ARCHIVE_MISMATCH'):
                observation.observe()
        self.assertTrue(observation.status()['closed'])
        self.assertEqual(observation.status()['retainedHandles'], 0)
        self.assertEqual({p.name for p in self.source.iterdir()}, {'own.zip', 'alias.zip'})
        self.assertEqual(file.read_bytes(), data)
        self.assertEqual(alias.read_bytes(), data)
        self.assertEqual(list(self.parent.iterdir()), [])


class OwnedArchiveObservationModelTests(unittest.TestCase):
    """Actual observer algorithm; native handle/hash boundaries are explicit models.

    No filesystem fixture, process, destination or Windows API is exercised here.
    The inherited custody lock/close loop and primary-error handling are real.
    """
    def setUp(self):
        self.events = []
        self.snapshots = {'parent': ('123:456', 0, 1, 7, 8, 16),
                          'archive': ('123:18446744073709551620', 3, 1, 9, 10, 128)}
        self.hashes = (hashlib.sha256(b'zip').hexdigest(), hashlib.md5(b'zip').hexdigest())
        self.hash_error = self.close_error = None
        self.mutate = None
        owner = self

        class Model(module.OwnedArchiveObservation):
            def _root_handle(inner, value):
                owner.events.append(('root', value))
                inner._handles.extend(['drive', 'parent'])
                return 'parent'

            def _open(inner, parent, leaf, directory, create=False, writable=False):
                owner.events.append(('open', parent, leaf, directory, create, writable))
                inner._handles.append('archive')
                return 'archive', owner.snapshots['archive']

            def _release_handle(inner, handle):
                owner.events.append(('close', handle))
                if owner.close_error is not None:
                    raise owner.close_error
                inner._handles.remove(handle)
                return True

        self.Model = Model
        self.stack = []
        for patcher in (patch.object(module.os, 'name', 'nt'), patch.object(module, '_abi', return_value=True),
                        patch.object(module, '_snapshot', side_effect=self.snapshot),
                        patch.object(module, '_hash_pair', side_effect=self.hash_pair)):
            patcher.start()
            self.addCleanup(patcher.stop)

    def snapshot(self, handle, directory):
        self.events.append(('snapshot', handle, directory))
        return self.snapshots[handle]

    def hash_pair(self, handle, size):
        self.events.append(('hash', handle, size))
        if self.mutate is not None:
            self.mutate()
        if self.hash_error is not None:
            raise self.hash_error
        return self.hashes

    def owner(self, **options):
        arguments = dict(parent='c:/Downloads', leaf='own.zip', expected_size=3,
                         expected_sha256=self.hashes[0], expected_md5=self.hashes[1])
        arguments.update(options)
        return self.Model(**arguments)

    def test_constructor_inert_and_closed_six_field_native_snapshot(self):
        observation = self.owner()
        self.assertEqual(self.events, [])
        result = observation.observe()
        self.assertEqual(list(result), ['parent', 'parentIdentity', 'leaf', 'identity', 'bytes', 'sha256'])
        self.assertEqual(result['parent'], 'C:\\Downloads')
        self.assertEqual(result['identity'], {'schema': 'win-file-id128/1', 'volumeSerialNumber': '123',
                                              'fileId': '18446744073709551620'})
        self.assertEqual(result['parentIdentity']['fileId'], '456')
        self.assertEqual(result['sha256'], self.hashes[0])
        self.assertEqual(observation.status(), {'closed': True, 'poisoned': False,
                                               'retainedHandles': 0, 'observationOnly': True})
        self.assertEqual([x for x in self.events if x[0] == 'open'],
                         [('open', 'parent', 'own.zip', False, False, False)])
        self.assertEqual([x for x in self.events if x[0] == 'hash'], [('hash', 'archive', 3)])
        self.assertEqual(self.events[-3:], [('close', 'archive'), ('close', 'parent'), ('close', 'drive')])

    def test_invalid_closed_inputs_before_any_open(self):
        for options in ({'expected_size': 0}, {'expected_size': True}, {'expected_size': 64*1024*1024+1},
                        {'expected_sha256': 'A'*64}, {'expected_md5': None}, {'expected_md5': '0'*31},
                        {'leaf': '../own.zip'}, {'parent': '\\\\server\\share'}, {'parent': 'C:/a/../b'}):
            with self.subTest(options=options), self.assertRaises(module.OwnedTransferError):
                self.owner(**options)
        self.assertEqual(self.events, [])

    def test_size_or_multiple_links_refused_before_hash(self):
        for size, links in ((0, 1), (4, 1), (3, 2), (3, 0)):
            with self.subTest(size=size, links=links):
                self.events.clear()
                self.snapshots['archive'] = ('123:789', size, links, 9, 10, 128)
                observation = self.owner()
                with self.assertRaisesRegex(module.OwnedTransferError, 'ARCHIVE_MISMATCH'):
                    observation.observe()
                self.assertFalse(any(x[0] == 'hash' for x in self.events))
                self.assertTrue(observation.status()['closed'])

    def test_either_digest_mismatch_refused_and_all_handles_closed(self):
        for index in (0, 1):
            good = self.hashes
            observation = self.owner()
            changed = list(good)
            changed[index] = '0'*len(good[index])
            self.hashes = tuple(changed)
            with self.assertRaisesRegex(module.OwnedTransferError, 'ARCHIVE_MISMATCH'):
                observation.observe()
            self.assertTrue(observation.status()['closed'])
            self.hashes = good

    def test_every_leaf_generation_field_and_parent_generation_are_rechecked(self):
        for handle, fields in (('archive', range(6)), ('parent', range(6))):
            for field in fields:
                with self.subTest(handle=handle, field=field):
                    before = dict(self.snapshots)
                    def mutate():
                        row = list(self.snapshots[handle])
                        row[field] = '123:999' if field == 0 else row[field] + 1
                        self.snapshots[handle] = tuple(row)
                    self.mutate = mutate
                    observation = self.owner()
                    with self.assertRaisesRegex(module.OwnedTransferError, 'ARCHIVE_CHANGED'):
                        observation.observe()
                    self.assertTrue(observation.status()['closed'])
                    self.snapshots = before

    def test_unsafe_parent_or_leaf_native_refusal_never_hashes(self):
        for method in ('_root_handle', '_open'):
            observation = self.owner()
            primary = module.OwnedTransferError('UNSAFE_OBJECT')
            with patch.object(observation, method, side_effect=primary):
                with self.assertRaises(module.OwnedTransferError) as caught:
                    observation.observe()
            self.assertIs(caught.exception, primary)
            self.assertIs(primary.lease, observation)
            self.assertFalse(any(x[0] == 'hash' for x in self.events))

    def test_partial_open_retains_cell_then_raises_before_return(self):
        observation = self.owner()
        primary = module.OwnedTransferError('OPEN_REFUSED')
        def partial_open(parent, leaf, directory, create=False, writable=False):
            self.events.append(('partial-open', parent, leaf, directory, create, writable))
            observation._handles.append('partial-archive')
            raise primary
        with patch.object(observation, '_open', side_effect=partial_open):
            with self.assertRaises(module.OwnedTransferError) as caught:
                observation.observe()
        self.assertIs(caught.exception, primary)
        self.assertIs(primary.lease, observation)
        self.assertFalse(any(event[0] == 'hash' for event in self.events))
        self.assertEqual([event for event in self.events if event[0] == 'close'],
                         [('close', 'partial-archive'), ('close', 'parent'), ('close', 'drive')])
        self.assertEqual(observation.status(), {'closed': True, 'poisoned': True,
                                               'retainedHandles': 0, 'observationOnly': True})

    def test_read_primary_survives_close_failure_and_owner_retains_handles(self):
        observation = self.owner()
        primary = module.OwnedTransferError('READ_FAILED')
        self.hash_error, self.close_error = primary, OSError('close model')
        with self.assertRaises(module.OwnedTransferError) as caught:
            observation.observe()
        self.assertIs(caught.exception, primary)
        self.assertIs(primary.lease, observation)
        self.assertFalse(observation.status()['closed'])
        self.assertEqual(observation.status()['retainedHandles'], 3)
        self.assertEqual([x for x in self.events if x[0] == 'close'], [('close', 'archive')])
        self.assertIsNotNone(observation._close_failure)

    def test_standalone_close_failure_never_returns_snapshot(self):
        observation = self.owner()
        self.close_error = OSError('close model')
        with self.assertRaisesRegex(module.OwnedTransferError, 'CLOSE_UNCERTAIN') as caught:
            observation.observe()
        self.assertIs(caught.exception.lease, observation)
        self.assertTrue(observation.status()['poisoned'])
        self.assertFalse(observation.status()['closed'])

    def test_raw_io_error_is_sanitized_but_not_replaced_by_close(self):
        observation = self.owner()
        self.hash_error, self.close_error = OSError('private path model'), OSError('cleanup model')
        with self.assertRaisesRegex(module.OwnedTransferError, '^OWNED_TRANSFER_IO_FAILED$') as caught:
            observation.observe()
        self.assertIs(caught.exception.lease, observation)

    def test_interrupt_identity_survives_close_failure(self):
        observation = self.owner()
        primary = KeyboardInterrupt()
        self.hash_error, self.close_error = primary, OSError('cleanup model')
        with self.assertRaises(KeyboardInterrupt) as caught:
            observation.observe()
        self.assertIs(caught.exception, primary)
        self.assertIs(primary.lease, observation)

    def test_one_shot_even_after_success_or_failure(self):
        for fail in (False, True):
            observation = self.owner()
            self.hash_error = module.OwnedTransferError('READ_FAILED') if fail else None
            if fail:
                with self.assertRaises(module.OwnedTransferError):
                    observation.observe()
            else:
                observation.observe()
            count = len(self.events)
            with self.assertRaises(module.OwnedTransferError):
                observation.observe()
            self.assertEqual(len(self.events), count)

    def test_reentry_cannot_reopen_or_create(self):
        observation = self.owner()
        def reenter():
            with self.assertRaisesRegex(module.OwnedTransferError, 'BUSY_OR_WRONG_THREAD'):
                observation.observe()
        self.mutate = reenter
        observation.observe()
        self.assertEqual(len([x for x in self.events if x[0] == 'root']), 1)



class OwnedArchiveHandleCellModelTests(unittest.TestCase):
    """Actual _open/_release_handle/observe; ctypes/native functions are models."""
    def setUp(self):
        class Unicode(ctypes.Structure):
            _fields_ = [('Length', ctypes.c_ushort), ('MaximumLength', ctypes.c_ushort),
                        ('Buffer', ctypes.c_wchar_p)]
        class Attributes(ctypes.Structure):
            _fields_ = [('Length', ctypes.c_uint32), ('RootDirectory', ctypes.c_void_p),
                        ('ObjectName', ctypes.POINTER(Unicode)), ('Attributes', ctypes.c_uint32),
                        ('SecurityDescriptor', ctypes.c_void_p), ('SecurityQualityOfService', ctypes.c_void_p)]
        class Status(ctypes.Structure):
            _fields_ = [('Information', ctypes.c_size_t)]
        class Entry:
            def __init__(self):
                self.cell, self.phase = ctypes.c_void_p(), 'pending'
        class Native:
            pass
        self.open_fault = None
        self.fill = True
        self.code = 0
        self.information = 1
        self.close_fault = None
        self.close_ok = True
        self.calls = []
        self.native, self.kernel = Native(), Native()
        self.native.NtCreateFile = self.open_native
        self.kernel.CloseHandle = self.close_native
        for name, value in (('_Unicode', Unicode), ('_Attributes', Attributes), ('_Status', Status),
                            ('_HandleEntry', Entry), ('_N', self.native), ('_K', self.kernel)):
            patcher = patch.object(module, name, value, create=True)
            patcher.start()
            self.addCleanup(patcher.stop)
        for patcher in (patch.object(module.os, 'name', 'nt'), patch.object(module, '_abi', return_value=True),
                        patch.object(module, '_snapshot', side_effect=self.snapshot),
                        patch.object(module, '_hash_pair', return_value=('a'*64, 'b'*32))):
            patcher.start()
            self.addCleanup(patcher.stop)

    def snapshot(self, handle, directory):
        return ('123:' + str(handle), 0 if directory else 3, 1, 1, 2, 16 if directory else 128)

    def open_native(self, cell, access, attrs, status, allocation, attributes, sharing, disposition,
                    options, extra, length):
        self.calls.append(('open', sharing, disposition))
        self.assertEqual(self.owner._handles[-1].phase, 'open-uncertain')
        if self.fill:
            cell._obj.value = 77 + len(self.owner._handles)
        if self.open_fault is not None:
            raise self.open_fault
        status._obj.Information = self.information
        return self.code

    def close_native(self, handle):
        self.calls.append(('close', handle))
        if self.close_fault is not None:
            raise self.close_fault
        return self.close_ok

    def new_owner(self):
        # Use the actual _open on a modeled existing root, not a fake handle list.
        class Observer(module.OwnedArchiveObservation):
            def _root_handle(inner, path):
                return inner._open(None, 'modeled-root', True, create=False)[0]
        self.owner = Observer('C:/Downloads', 'own.zip', 3, 'a'*64, 'b'*32)
        return self.owner

    def test_native_raise_without_cell_remains_open_uncertain(self):
        owner = self.new_owner()
        primary = module.OwnedTransferError('OPEN_MODEL_FAILED')
        self.fill, self.open_fault = False, primary
        with self.assertRaises(module.OwnedTransferError) as caught:
            owner.observe()
        self.assertIs(caught.exception, primary)
        self.assertIs(primary.lease, owner)
        self.assertEqual(len(owner._handles), 1)
        self.assertEqual(owner._handles[0].phase, 'open-uncertain')
        self.assertIsNone(owner._handles[0].cell.value)
        self.assertFalse(owner.status()['closed'])
        self.assertIsNotNone(owner._close_failure)
        self.assertEqual([call for call in self.calls if call[0] == 'close'], [])
        with self.assertRaisesRegex(module.OwnedTransferError, 'CLOSE_FAILED'):
            owner.close()
        self.assertEqual(len(owner._handles), 1)

    def test_native_raise_after_cell_is_owned_and_closed_once(self):
        owner = self.new_owner()
        primary = module.OwnedTransferError('OPEN_MODEL_FAILED')
        self.open_fault = primary
        with self.assertRaises(module.OwnedTransferError) as caught:
            owner.observe()
        self.assertIs(caught.exception, primary)
        self.assertEqual([call for call in self.calls if call[0] == 'close'], [('close', 78)])
        self.assertTrue(owner.status()['closed'])
        owner.close()
        self.assertEqual([call for call in self.calls if call[0] == 'close'], [('close', 78)])

    def test_known_failure_without_handle_is_known_closed(self):
        owner = self.new_owner()
        self.fill, self.code = False, -1
        with self.assertRaisesRegex(module.OwnedTransferError, 'OPEN_REFUSED'):
            owner.observe()
        self.assertTrue(owner.status()['closed'])
        self.assertEqual(owner._handles, [])
        self.assertIsNone(owner._close_failure)
        self.assertFalse(any(call[0] == 'close' for call in self.calls))

    def test_known_failure_with_handle_is_closed(self):
        owner = self.new_owner()
        self.code = -1
        with self.assertRaisesRegex(module.OwnedTransferError, 'OPEN_REFUSED'):
            owner.observe()
        self.assertTrue(owner.status()['closed'])
        self.assertEqual(self.calls[-1], ('close', 78))

    def test_close_raise_retains_close_uncertain_and_never_retries(self):
        owner = self.new_owner()
        primary = module.OwnedTransferError('OPEN_MODEL_FAILED')
        self.open_fault, self.close_fault = primary, OSError('close model')
        with self.assertRaises(module.OwnedTransferError) as caught:
            owner.observe()
        self.assertIs(caught.exception, primary)
        entry = owner._handles[0]
        self.assertEqual(entry.phase, 'close-uncertain')
        self.close_fault = None
        # Even an invalidated cell cannot erase a previous uncertain close.
        entry.cell.value = None
        with self.assertRaisesRegex(module.OwnedTransferError, 'CLOSE_FAILED'):
            owner.close()
        self.assertIn(entry, owner._handles)
        self.assertEqual([call for call in self.calls if call[0] == 'close'], [('close', 78)])

    def test_known_close_false_retains_open_without_automatic_retry(self):
        owner = self.new_owner()
        primary = module.OwnedTransferError('OPEN_MODEL_FAILED')
        self.open_fault, self.close_ok = primary, False
        with self.assertRaises(module.OwnedTransferError) as caught:
            owner.observe()
        self.assertIs(caught.exception, primary)
        self.assertEqual(owner._handles[0].phase, 'open')
        self.assertFalse(owner.status()['closed'])
        self.assertEqual([call for call in self.calls if call[0] == 'close'], [('close', 78)])

    def test_success_uses_actual_cells_reverse_close_and_noncreate_access(self):
        owner = self.new_owner()
        result = owner.observe()
        self.assertEqual(result['identity']['fileId'], '79')
        self.assertEqual(self.calls, [('open', 3, 1), ('open', 1, 1), ('close', 79), ('close', 78)])
        self.assertTrue(owner.status()['closed'])



if __name__ == '__main__':
    unittest.main()
