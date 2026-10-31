"""Internal Windows handle-owned copying; no CLI, installer, deletion or retry API.

Create an inert OwnedFileTransfer, call acquire() once, then transfer() and close().
Failures poison the lease and retain handles/partial output until explicit close.
Root pins use explicitly tagged win-file-id128/1 volume64:file128 identities,
never untagged Python/Node dev:ino strings. This is not a hostile-process sandbox:
siblings, memory mappings, privileged actors, persistence, extractor termination
and integration with Vortex are outside this component's guarantee.
Only fixed local NTFS is admitted. Drive mapping/ACL changes by hostile actors
are not a security boundary; handles do not fence arbitrary directory contents.
Only the explicitly checked Windows x64 ctypes ABI is supported.
The destination namespace becomes visible at acquire(), before copying completes;
this is not atomic publication of a complete payload. New hardlink aliases and
renaming separately opened alias names can remain possible while the canonical
archive name and bytes are held; no cleanup/adoption is authorized after close.
"""
import ctypes as C
from ctypes import wintypes as W
from contextlib import contextmanager
import hashlib
import importlib.util
from pathlib import Path
import ntpath
import os
import re
import threading

MAX_FILES = 4096
MAX_TOTAL_BYTES = 256 * 1024 * 1024
MAX_FILE_BYTES = MAX_TOTAL_BYTES
MAX_HANDLES = 16384
CHUNK_BYTES = 65536
IDENTITY_SCHEMA = 'win-file-id128/1'
_EXTRACTOR_FACTORY = None
_ZIP_EXTRACTOR_FACTORY = None


class OwnedTransferError(Exception):
    def __init__(self, code, lease=None):
        super().__init__('OWNED_TRANSFER_' + code)
        self.lease = lease


def _need(ok, code):
    if not ok:
        raise OwnedTransferError(code)


def _component(value):
    _need(type(value) is str and 0 < len(value) <= 255 and value.isascii()
          and not re.search(r'[<>:"/\\|?*~\x00-\x1f\x7f]', value)
          and value not in ('.', '..') and not value.endswith(('.', ' '))
          and not re.match(r'^(con|prn|aux|nul|conin\$|conout\$|com[1-9]|lpt[1-9])(?:\.|$)', value, re.I),
          'INVALID_COMPONENT')
    return value


def _root(value):
    _need(type(value) is str and len(value) <= 512 and re.match(r'^[A-Za-z]:[\\/]', value), 'INVALID_ROOT')
    value = value.replace('/', '\\')
    parts = value[3:].split('\\') if len(value) > 3 else []
    _need(len(parts) <= 32, 'LIMIT')
    for part in parts:
        _component(part)
    return value[:1].upper() + value[1:]


def _relative(value):
    _need(type(value) is str and 0 < len(value) <= 512 and '\\' not in value, 'INVALID_RELATIVE')
    parts = value.split('/')
    _need(len(parts) <= 32, 'LIMIT')
    return tuple(_component(part) for part in parts)


def _identity(value):
    _need(type(value) is dict and set(value) == {'schema', 'volumeSerialNumber', 'fileId'}
          and value['schema'] == IDENTITY_SCHEMA, 'INVALID_IDENTITY')
    for key, maximum in (('volumeSerialNumber', 2**64 - 1), ('fileId', 2**128 - 1)):
        item = value[key]
        _need(type(item) is str and re.fullmatch(r'[1-9][0-9]{0,38}', item) and int(item) <= maximum, 'INVALID_IDENTITY')
    return value['volumeSerialNumber'] + ':' + value['fileId']


def _label(value):
    volume, file = value.split(':')
    return {'schema': IDENTITY_SCHEMA, 'volumeSerialNumber': volume, 'fileId': file}


if os.name == 'nt':
    class _Unicode(C.Structure):
        _fields_ = [('Length', W.USHORT), ('MaximumLength', W.USHORT), ('Buffer', W.LPWSTR)]

    class _Attributes(C.Structure):
        _fields_ = [('Length', W.ULONG), ('RootDirectory', W.HANDLE), ('ObjectName', C.POINTER(_Unicode)),
                    ('Attributes', W.ULONG), ('SecurityDescriptor', C.c_void_p), ('SecurityQualityOfService', C.c_void_p)]

    class _Status(C.Structure):
        _fields_ = [('StatusOrPointer', C.c_void_p), ('Information', C.c_size_t)]

    class _Identity(C.Structure):
        _fields_ = [('volume', C.c_ulonglong), ('file', W.BYTE * 16)]

    class _Basic(C.Structure):
        _fields_ = [('created', C.c_longlong), ('accessed', C.c_longlong), ('written', C.c_longlong),
                    ('changed', C.c_longlong), ('attributes', W.DWORD)]

    class _Standard(C.Structure):
        _fields_ = [('allocation', C.c_longlong), ('size', C.c_longlong), ('links', W.DWORD),
                    ('deletePending', W.BYTE), ('directory', W.BYTE)]

    class _HandleEntry:
        def __init__(self):
            self.cell = W.HANDLE()
            self.phase = 'pending'

    _K = C.WinDLL('kernel32', use_last_error=True)
    _N = C.WinDLL('ntdll')
    _N.NtCreateFile.argtypes = [C.POINTER(W.HANDLE), W.DWORD, C.POINTER(_Attributes), C.POINTER(_Status),
                               C.c_void_p, W.ULONG, W.ULONG, W.ULONG, W.ULONG, C.c_void_p, W.ULONG]
    _N.NtCreateFile.restype = C.c_long
    _K.GetFileInformationByHandleEx.argtypes = [W.HANDLE, C.c_int, C.c_void_p, W.DWORD]
    _K.GetFileInformationByHandleEx.restype = W.BOOL
    _K.CloseHandle.argtypes = [W.HANDLE]
    _K.CloseHandle.restype = W.BOOL
    _K.GetDriveTypeW.argtypes = [W.LPCWSTR]
    _K.GetDriveTypeW.restype = W.UINT
    _K.QueryDosDeviceW.argtypes = [W.LPCWSTR, W.LPWSTR, W.DWORD]
    _K.QueryDosDeviceW.restype = W.DWORD
    _K.GetVolumeInformationByHandleW.argtypes = [W.HANDLE, W.LPWSTR, W.DWORD, C.c_void_p,
                                               C.c_void_p, C.c_void_p, W.LPWSTR, W.DWORD]
    _K.GetVolumeInformationByHandleW.restype = W.BOOL
    _K.ReadFile.argtypes = [W.HANDLE, C.c_void_p, W.DWORD, C.POINTER(W.DWORD), C.c_void_p]
    _K.ReadFile.restype = W.BOOL
    _K.WriteFile.argtypes = [W.HANDLE, C.c_void_p, W.DWORD, C.POINTER(W.DWORD), C.c_void_p]
    _K.WriteFile.restype = W.BOOL
    _K.SetFilePointerEx.argtypes = [W.HANDLE, C.c_longlong, C.c_void_p, W.DWORD]
    _K.SetFilePointerEx.restype = W.BOOL


def _snapshot(handle, directory):
    values = []
    for kind, structure in ((18, _Identity), (0, _Basic), (1, _Standard)):
        value = structure()
        _need(_K.GetFileInformationByHandleEx(handle, kind, C.byref(value), C.sizeof(value)), 'INFORMATION_FAILED')
        values.append(value)
    ident, basic, standard = values
    inode = int.from_bytes(bytes(ident.file), 'little')
    _need(ident.volume > 0 and inode > 0 and bool(standard.directory) == directory
          and not basic.attributes & 0x400 and not standard.deletePending and standard.links > 0, 'UNSAFE_OBJECT')
    return (f'{ident.volume}:{inode}', standard.size, standard.links, basic.written, basic.changed, basic.attributes)


def _abi():
    return all(C.sizeof(kind) == size for kind, size in
               ((C.c_void_p, 8), (C.c_long, 4), (_Unicode, 16), (_Attributes, 48),
                (_Status, 16), (_Identity, 24), (_Basic, 40), (_Standard, 24)))


def _seek_at(handle, offset):
    _need(type(offset) is int and 0 <= offset <= MAX_TOTAL_BYTES, 'INVALID_OFFSET')
    _need(_K.SetFilePointerEx(handle, offset, None, 0), 'SEEK_FAILED')


def _seek(handle):
    _seek_at(handle, 0)


def _read(handle, limit):
    _need(0 < limit <= CHUNK_BYTES, 'LIMIT')
    buffer, used = C.create_string_buffer(limit), W.DWORD()
    _need(_K.ReadFile(handle, buffer, limit, C.byref(used), None), 'READ_FAILED')
    _need(used.value <= limit, 'READ_FAILED')
    return buffer.raw[:used.value]


def _write(handle, data):
    _need(0 < len(data) <= CHUNK_BYTES, 'LIMIT')
    buffer, used = C.create_string_buffer(data), W.DWORD()
    _need(_K.WriteFile(handle, buffer, len(data), C.byref(used), None) and used.value == len(data), 'WRITE_FAILED')


def _hash(handle, size):
    _seek(handle)
    result, remaining = hashlib.sha256(), size
    while remaining:
        data = _read(handle, min(remaining, CHUNK_BYTES))
        _need(data, 'SIZE_MISMATCH')
        result.update(data)
        remaining -= len(data)
    _need(not _read(handle, 1), 'SIZE_MISMATCH')
    return result.hexdigest()


def _hash_pair(handle, size):
    """One held-handle pass; MD5 is association evidence, never authentication."""
    _seek(handle)
    sha256, md5, remaining = hashlib.sha256(), hashlib.md5(), size
    while remaining:
        data = _read(handle, min(remaining, CHUNK_BYTES))
        _need(data, 'SIZE_MISMATCH')
        sha256.update(data)
        md5.update(data)
        remaining -= len(data)
    _need(not _read(handle, 1), 'SIZE_MISMATCH')
    return sha256.hexdigest(), md5.hexdigest()


class _HandlePool:
    def __init__(self):
        self.lock = threading.Lock()
        self.thread = threading.get_ident()
        self.owners = []


class _PreparedDestination:
    __slots__ = ('owner', 'entry', 'path', 'leaf', 'identity', 'phase')

    def __init__(self, owner, entry, path, leaf, identity):
        self.owner, self.entry, self.path, self.leaf = owner, entry, path, leaf
        self.identity, self.phase = identity, 'prepared'


class _HandleCustody:
    def _init_custody(self, pool=None):
        self._pool = pool or _HandlePool()
        self._handles = []
        self._pool.owners.append(self)
        self._lock, self._thread = self._pool.lock, self._pool.thread
        self._prepared_destination = None
        self._prepared_destination_attempted = False

    def _prepare_destination(self, value, leaf):
        """Open an existing parent once; no output directory is created here."""
        with self._operation():
            _need(not self._prepared_destination_attempted, 'DESTINATION_ALREADY_PREPARED')
            self._prepared_destination_attempted = True
            try:
                value, leaf = _root(value), _component(leaf)
                handle = self._root_handle(value)
                identity = _snapshot(handle, True)[0]
                entry = next((entry for entry in self._handles
                              if entry.phase == 'open' and entry.cell.value == handle), None)
                _need(entry is not None, 'DESTINATION_HANDLE_REFUSED')
                self._prepared_destination = _PreparedDestination(self, entry, value, leaf, identity)
                return self._prepared_destination
            except BaseException:
                self._poisoned = True
                raise

    def _check_prepared_destination(self, prepared, pool):
        _need(type(prepared) is _PreparedDestination and self._prepared_destination is prepared
              and prepared.owner is self and self._pool is pool and self in pool.owners
              and not self._closed and not self._poisoned
              and prepared.phase in ('prepared', 'borrowed')
              and prepared.entry in self._handles and prepared.entry.phase == 'open',
              'DESTINATION_OWNER_REFUSED')
        handle = prepared.entry.cell.value
        _need(handle not in (None, C.c_void_p(-1).value)
              and _snapshot(handle, True)[0] == prepared.identity, 'DESTINATION_CHANGED')
        return handle

    def _observe_prepared_destination(self, prepared):
        with self._operation():
            self._check_prepared_destination(prepared, self._pool)
            return {'parent': prepared.path, 'leaf': prepared.leaf,
                    'parentIdentity': _label(prepared.identity)}

    def _remaining_handles(self):
        return MAX_HANDLES - sum(len(owner._handles) for owner in self._pool.owners)

    def _reserve_handle(self, cell=None):
        _need(self._remaining_handles() > 0, 'HANDLE_LIMIT')
        entry = _HandleEntry()
        if cell is not None:
            entry.cell = cell
        self._handles.append(entry)
        return entry

    def _release_handle(self, entry):
        _need(entry in self._handles, 'HANDLE_NOT_OWNED')
        handle = entry.cell.value
        if handle in (None, C.c_void_p(-1).value):
            self._handles.remove(entry)
            return True
        if entry.phase == 'close-uncertain':
            return False
        entry.phase = 'close-uncertain'  # Before crossing native close/interrupt boundary.
        success = _K.CloseHandle(handle)
        if success:
            self._handles.remove(entry)
        else:
            entry.phase = 'open'
        return bool(success)

    def _open(self, parent, name, directory, create=False, writable=False):
        storage = C.create_unicode_buffer(name)
        text = _Unicode(len(name.encode('utf-16-le')), (len(name) + 1) * 2, C.cast(storage, W.LPWSTR))
        # OBJ_DONT_REPARSE + OBJ_CASE_INSENSITIVE, including the drive open.
        attrs = _Attributes(C.sizeof(_Attributes), parent, C.pointer(text), 0x1040, None, None)
        entry, status = self._reserve_handle(), _Status()
        access = 0x100081 if directory else (0xC0100000 if writable else 0x80100000)
        options = (0x1 if directory else 0x40) | 0x20 | 0x00200000
        sharing = 3 if directory else 1
        # The output cell is retained BEFORE crossing ctypes/kernel boundaries.
        # An interrupt after kernel creation must not lose the returned handle.
        code = _N.NtCreateFile(C.byref(entry.cell), access, C.byref(attrs), C.byref(status), None,
                               0x10 if directory else 0x80, sharing, 2 if create else 1, options, None, 0)
        _need(code >= 0, 'CREATE_REFUSED' if create else 'OPEN_REFUSED')
        _need(entry.cell.value not in (None, C.c_void_p(-1).value) and status.Information == (2 if create else 1), 'UNEXPECTED_OPEN')
        entry.phase = 'open'
        snapshot = _snapshot(entry.cell.value, directory)
        return entry.cell.value, snapshot

    def _root_handle(self, value):
        _need(_K.GetDriveTypeW(value[:3]) == 3, 'UNSUPPORTED_DRIVE')
        mapping = C.create_unicode_buffer(2048)
        _need(_K.QueryDosDeviceW(value[:2], mapping, len(mapping))
              and re.fullmatch(r'\\Device\\HarddiskVolume[1-9][0-9]*', mapping.value), 'UNSUPPORTED_DRIVE_MAPPING')
        handle, _ = self._open(None, '\\??\\' + value[:3], True)
        filesystem = C.create_unicode_buffer(32)
        _need(_K.GetVolumeInformationByHandleW(handle, None, 0, None, None, None, filesystem, len(filesystem))
              and filesystem.value == 'NTFS', 'UNSUPPORTED_FILESYSTEM')
        for component in value[3:].split('\\') if len(value) > 3 else []:
            handle, _ = self._open(handle, component, True)
        return handle

    def _existing_root(self, value, pin):
        handle = self._root_handle(value)
        _need(_snapshot(handle, True)[0] == pin, 'ROOT_IDENTITY_MISMATCH')
        return handle

    @contextmanager
    def _operation(self, closing=False):
        _need(self._lock.acquire(False), 'BUSY_OR_WRONG_THREAD')
        try:
            _need(threading.get_ident() == self._thread, 'BUSY_OR_WRONG_THREAD')
            if not closing:
                _need(not self._closed and not self._poisoned, 'HELD')
            yield
        finally:
            self._lock.release()

    def _error(self, error):
        if isinstance(error, OwnedTransferError):
            error.lease = self
            return error
        return OwnedTransferError('IO_FAILED', self)

    def close(self):
        with self._operation(closing=True):
            extractor = getattr(self, '_extractor', None)
            _need(extractor is None or extractor._closed, 'EXTRACTOR_ACTIVE')
            borrow = getattr(self, '_borrow', None)
            _need(borrow is None or (borrow._closed and not borrow._handles), 'BORROW_ACTIVE')
            return self._close()

    def _close(self):
        failed = False
        try:
            for entry in list(reversed(self._handles)):
                if not self._release_handle(entry):
                    failed = True
            if failed:
                self._poisoned = True
                raise OwnedTransferError('CLOSE_FAILED', self)
            self._closed = not self._handles
            return self.status()
        except BaseException as error:
            self._poisoned = True
            if not isinstance(error, Exception):
                error.lease = self
                raise
            if isinstance(error, OwnedTransferError):
                raise
            raise OwnedTransferError('CLOSE_UNCERTAIN', self) from None
        finally:
            self._closed = not self._handles


class OwnedFileTransfer(_HandleCustody):
    """One explicitly acquired destination root; partial failures never roll back.

    Caller retains this object even after failure; errors also expose error.lease.
    close() releases handles only. It never deletes any created object, proves
    durability, or grants permission to release an unrelated extractor's seals.
    """
    def __init__(self, source_root, source_identity, destination_parent, parent_identity, destination_leaf):
        _need(os.name == 'nt', 'UNSUPPORTED_PLATFORM')
        _need(_abi(), 'UNSUPPORTED_ABI')
        self._source_path, self._parent_path = _root(source_root), _root(destination_parent)
        self._leaf = _component(destination_leaf)
        source_identity, parent_identity = _identity(source_identity), _identity(parent_identity)
        target = ntpath.join(self._parent_path, self._leaf).lower()
        source = self._source_path.lower()
        inside = lambda a, b: a == b or a.startswith(b.rstrip('\\') + '\\')
        _need(not inside(source, target) and not inside(target, source) and source_identity != parent_identity, 'ROOT_OVERLAP')
        self._source_pin, self._parent_pin = source_identity, parent_identity
        self._init_custody()
        self._source_dirs, self._destination_dirs = {}, {}
        self._borrow_parent = None
        self._borrow_destination = None
        self._destination_pin = None
        self._zip_source_owner = None
        self._attempted = self._acquired = self._poisoned = self._closed = False
        self._files = self._total = 0
        self._destinations = set()

    def acquire(self):
        with self._operation():
            return self._acquire()

    def _acquire(self):
        _need(not self._attempted, 'ALREADY_ATTEMPTED')
        self._attempted = True
        try:
            if self._borrow_parent is None:
                source = self._existing_root(self._source_path, self._source_pin)
            else:
                _need(self._borrow_parent._acquired and not self._borrow_parent._closed
                      and not self._borrow_parent._poisoned, 'BORROW_HELD')
                source = self._borrow_parent._temp_handle
                _need(_snapshot(source, True)[0] == self._source_pin, 'ROOT_IDENTITY_MISMATCH')
            if self._borrow_destination is None:
                parent = self._existing_root(self._parent_path, self._parent_pin)
            else:
                prepared = self._borrow_destination
                parent = prepared.owner._check_prepared_destination(prepared, self._pool)
                _need(prepared.phase == 'borrowed' and prepared.identity == self._parent_pin
                      and prepared.path == self._parent_path and prepared.leaf == self._leaf,
                      'DESTINATION_OWNER_REFUSED')
            _need(_snapshot(source, True)[0] != _snapshot(parent, True)[0], 'ROOT_OVERLAP')
            destination, observed = self._open(parent, self._leaf, True, create=True)
            self._destination_pin = observed[0]
            self._source_dirs[()] = source
            self._destination_dirs[()] = destination
            self._acquired = True
            return self.status()
        except BaseException as error:
            self._poisoned = True
            if not isinstance(error, Exception):
                error.lease = self
                raise
            raise self._error(error) from None

    def _directory(self, parts, source):
        cache = self._source_dirs if source else self._destination_dirs
        key = ()
        for part in parts:
            next_key = (*key, part)
            if next_key not in cache:
                handle, _ = self._open(cache[key], part, True, create=not source)
                cache[next_key] = handle
            key = next_key
        return cache[key]

    def transfer(self, source_relative, destination_relative, expected_size, expected_sha256):
        with self._operation():
            return self._transfer(source_relative, destination_relative, expected_size, expected_sha256)

    def _transfer(self, source_relative, destination_relative, expected_size, expected_sha256):
        try:
            _need(self._acquired, 'NOT_ACQUIRED')
            source_parts, destination_parts = _relative(source_relative), _relative(destination_relative)
            _need(type(expected_size) is int and 0 <= expected_size <= MAX_FILE_BYTES
                  and type(expected_sha256) is str and re.fullmatch(r'[a-f0-9]{64}', expected_sha256), 'INVALID_PROOF')
            folded = destination_relative.lower()
            _need(folded not in self._destinations and self._files < MAX_FILES
                  and self._total + expected_size <= MAX_TOTAL_BYTES, 'LIMIT')
            self._files += 1
            self._total += expected_size
            self._destinations.add(folded)
            if self._zip_source_owner is None:
                source_parent = self._directory(source_parts[:-1], True)
                source, before = self._open(source_parent, source_parts[-1], False)
            else:
                source, before = self._zip_source_owner._source_locked(source_parts, expected_size, expected_sha256)
            _need(before[1] == expected_size and _hash(source, expected_size) == expected_sha256
                  and _snapshot(source, False) == before, 'SOURCE_MISMATCH')
            destination_parent = self._directory(destination_parts[:-1], False)
            destination, initial = self._open(destination_parent, destination_parts[-1], False, create=True, writable=True)
            _need(initial[1] == 0 and initial[2] == 1, 'UNSAFE_DESTINATION')
            _seek(source)
            copied, remaining = hashlib.sha256(), expected_size
            while remaining:
                data = _read(source, min(remaining, CHUNK_BYTES))
                _need(data, 'SIZE_MISMATCH')
                _write(destination, data)
                copied.update(data)
                remaining -= len(data)
            _need(not _read(source, 1) and copied.hexdigest() == expected_sha256
                  and _snapshot(source, False) == before, 'SOURCE_CHANGED')
            finished = _snapshot(destination, False)
            _need(finished[2] == 1 and _hash(destination, expected_size) == expected_sha256
                  and _snapshot(destination, False) == finished, 'DESTINATION_MISMATCH')
            return {'sourceIdentity': _label(before[0]), 'destinationIdentity': _label(finished[0]), 'bytes': expected_size,
                    'sha256': expected_sha256, 'effectsAllowed': False, 'persistenceVerified': False}
        except BaseException as error:
            self._poisoned = True
            if not isinstance(error, Exception):
                error.lease = self
                raise
            raise self._error(error) from None

    def destination_observation(self):
        with self._operation():
            _need(self._acquired and self._destination_pin is not None, 'NOT_ACQUIRED')
            _need(_snapshot(self._destination_dirs[()], True)[0] == self._destination_pin,
                  'DESTINATION_CHANGED')
            return {'parent': self._parent_path, 'leaf': self._leaf,
                    'parentIdentity': _label(self._parent_pin),
                    'directoryIdentity': _label(self._destination_pin)}

    def status(self):
        return {'acquired': self._acquired, 'poisoned': self._poisoned, 'closed': self._closed,
                'closeUncertain': any(entry.phase == 'close-uncertain' for entry in self._handles),
                'retainedHandles': len(self._handles), 'attemptedFiles': self._files, 'attemptedBytes': self._total,
                'effectsAllowed': False, 'persistenceVerified': False, 'nativeInstallAccepted': False}



class ArchiveTempLease(_HandleCustody):
    """Physical custody, optionally bound to one fixed extractor process owner.

    Without a factory attempt, legacy trusted callers remain responsible for an
    independent extraction barrier. Once create_extractor is attempted, transfer
    requires that same owner's normal terminal/EOF/explicit-close facts; no
    fallback or JSON proof is accepted. This never admits native installation.
    Root handles cannot fence descendant insertion or 7z's overwrite policy.
    """
    def __init__(self, binding, archive_parent, archive_parent_identity, archive_leaf,
                 archive_identity, expected_size, expected_sha256,
                 temp_parent, temp_parent_identity, temp_leaf, *, expected_md5=None):
        _need(os.name == 'nt', 'UNSUPPORTED_PLATFORM')
        _need(_abi(), 'UNSUPPORTED_ABI')
        fields = {'operationId': r'op_[a-f0-9]{32}', 'nativeJobId': r'exec_[a-f0-9]{32}',
                  'requestSHA256': r'[a-f0-9]{64}', 'rendererGeneration': r'renderer_[a-f0-9]{32}'}
        _need(type(binding) is dict and set(binding) == set(fields), 'INVALID_BINDING')
        _need(all(type(binding[key]) is str and re.fullmatch(pattern, binding[key])
                  for key, pattern in fields.items()), 'INVALID_BINDING')
        self._binding = dict(binding)
        self._archive_parent, self._temp_parent = _root(archive_parent), _root(temp_parent)
        self._archive_leaf, self._temp_leaf = _component(archive_leaf), _component(temp_leaf)
        self._archive_pin, self._archive_parent_pin = _identity(archive_identity), _identity(archive_parent_identity)
        self._temp_parent_pin = _identity(temp_parent_identity)
        self._temp_path = _root(ntpath.join(self._temp_parent, self._temp_leaf))
        archive_path = _root(ntpath.join(self._archive_parent, self._archive_leaf)).lower()
        temp_path = self._temp_path.lower()
        inside = lambda a, b: a == b or a.startswith(b.rstrip('\\') + '\\')
        _need(not inside(archive_path, temp_path) and not inside(temp_path, archive_path), 'ROOT_OVERLAP')
        _need(type(expected_size) is int and 0 <= expected_size <= 64 * 1024 * 1024
              and type(expected_sha256) is str and re.fullmatch(r'[a-f0-9]{64}', expected_sha256), 'INVALID_PROOF')
        _need(expected_md5 is None or (type(expected_md5) is str
              and re.fullmatch(r'[a-f0-9]{32}', expected_md5)), 'INVALID_PROOF')
        self._size, self._sha, self._md5 = expected_size, expected_sha256, expected_md5
        self._init_custody()
        self._attempted = self._acquired = self._poisoned = self._closed = False
        self._archive_handle = self._temp_handle = None
        self._archive_snapshot = self._temp_pin = None
        self._borrow = None
        self._borrow_attempted = False
        self._extractor_attempted = False
        self._extractor = None

    def create_extractor(self):
        """Inert one-shot factory; start() separately requires acquired custody."""
        global _EXTRACTOR_FACTORY
        with self._operation():
            _need(not self._extractor_attempted and not self._borrow_attempted, 'EXTRACTOR_ALREADY_ATTEMPTED')
            self._extractor_attempted = True
            try:
                if _EXTRACTOR_FACTORY is None:
                    source = Path(__file__).absolute().with_name('owned-extractor-process.py')
                    for path in (source, *source.parents):
                        _need(not path.lstat().st_file_attributes & 0x400, 'UNSAFE_EXTRACTOR_SOURCE')
                    spec = importlib.util.spec_from_file_location('_owned_extractor_process_fixed', source)
                    module = importlib.util.module_from_spec(spec)
                    spec.loader.exec_module(module)
                    _EXTRACTOR_FACTORY = module._bind(_HandleCustody, ArchiveTempLease, _snapshot, _hash, OwnedTransferError)
                owner = _EXTRACTOR_FACTORY(self)
                self._extractor = owner  # Published BEFORE any process-owner kernel effects.
                return owner
            except BaseException as error:
                self._poisoned = True
                error.lease = self
                error.owner = self._extractor
                raise

    def create_zip_extractor(self, expected_payload, expected_total):
        """Inert fixed ZIP factory; mutually exclusive with the process backend."""
        global _ZIP_EXTRACTOR_FACTORY
        with self._operation():
            _need(not self._extractor_attempted and not self._borrow_attempted, 'EXTRACTOR_ALREADY_ATTEMPTED')
            self._extractor_attempted = True
            try:
                if _ZIP_EXTRACTOR_FACTORY is None:
                    source = Path(__file__).absolute().with_name('owned-zip-extractor.py')
                    for path in (source, *source.parents):
                        _need(not path.lstat().st_file_attributes & 0x400, 'UNSAFE_EXTRACTOR_SOURCE')
                    spec = importlib.util.spec_from_file_location('_owned_zip_extractor_fixed', source)
                    module = importlib.util.module_from_spec(spec)
                    spec.loader.exec_module(module)
                    _ZIP_EXTRACTOR_FACTORY = module._bind(ArchiveTempLease, _snapshot, _hash, _seek_at,
                                                          _read, _write, _relative, OwnedTransferError)
                owner = _ZIP_EXTRACTOR_FACTORY(self, expected_payload, expected_total)
                self._extractor = owner
                return owner
            except BaseException as error:
                self._poisoned = True
                error.lease, error.owner = self, self._extractor
                raise

    def acquire(self):
        with self._operation():
            _need(not self._attempted, 'ALREADY_ATTEMPTED')
            self._attempted = True
            try:
                parent = self._existing_root(self._archive_parent, self._archive_parent_pin)
                archive, observed = self._open(parent, self._archive_leaf, False)
                self._archive_handle = archive
                _need(observed[0] == self._archive_pin and observed[1] == self._size, 'ARCHIVE_MISMATCH')
                if self._md5 is None:
                    matches = _hash(archive, self._size) == self._sha
                else:
                    sha256, md5 = _hash_pair(archive, self._size)
                    matches = sha256 == self._sha and md5 == self._md5
                _need(matches and _snapshot(archive, False) == observed, 'ARCHIVE_MISMATCH')
                self._archive_snapshot = observed
                temp_parent = self._existing_root(self._temp_parent, self._temp_parent_pin)
                temp, observed_temp = self._open(temp_parent, self._temp_leaf, True, create=True)
                self._temp_handle, self._temp_pin = temp, observed_temp[0]
                self._acquired = True
                return self.status()
            except BaseException as error:
                self._poisoned = True
                if not isinstance(error, Exception):
                    error.lease = self
                    raise
                raise self._error(error) from None

    def begin_transfer(self, destination_parent, parent_identity, new_leaf):
        return self._begin_transfer(destination_parent, parent_identity, new_leaf)

    def begin_transfer_prepared(self, guard, prepared):
        # The token is a source-created object registered with its actual owner;
        # no raw handle or wire-provided identity can substitute for it.
        return self._begin_transfer(None, None, None, guard, prepared)

    def _begin_transfer(self, destination_parent, parent_identity, new_leaf, guard=None, prepared=None):
        with self._operation():
            _need(self._acquired and not self._borrow_attempted, 'BORROW_UNAVAILABLE')
            if self._extractor_attempted:
                _need(self._extractor is not None and self._extractor._handoff_ready_locked(), 'EXTRACTOR_NOT_READY')
            try:
                if guard is not None or prepared is not None:
                    _need(isinstance(guard, _HandleCustody), 'DESTINATION_OWNER_REFUSED')
                    guard._check_prepared_destination(prepared, self._pool)
                    _need(prepared.phase == 'prepared', 'DESTINATION_ALREADY_BORROWED')
                    destination_parent, parent_identity, new_leaf = prepared.path, _label(prepared.identity), prepared.leaf
                _need(_snapshot(self._archive_handle, False) == self._archive_snapshot
                      and _hash(self._archive_handle, self._size) == self._sha
                      and _snapshot(self._archive_handle, False) == self._archive_snapshot
                      and _snapshot(self._temp_handle, True)[0] == self._temp_pin, 'CUSTODY_CHANGED')
                borrow = OwnedFileTransfer(self._temp_path, _label(self._temp_pin),
                                           destination_parent, parent_identity, new_leaf)
                # Reserve before native acquisition; retained even if it fails.
                self._borrow_attempted = True
                self._borrow = borrow
                borrow._pool.owners.remove(borrow)
                borrow._pool = self._pool
                self._pool.owners.append(borrow)
                borrow._lock, borrow._thread = self._lock, self._thread
                borrow._borrow_parent = self
                if prepared is not None:
                    prepared.phase = 'borrowed'
                    borrow._borrow_destination = prepared
                    guard._borrow = borrow
                if getattr(self._extractor, '_backend', None) == 'zip':
                    borrow._zip_source_owner = self._extractor
                borrow._acquire()
                return borrow
            except BaseException as error:
                self._poisoned = True
                if not isinstance(error, Exception):
                    if self._borrow is not None:
                        self._borrow._poisoned = True
                    error.lease = self._borrow if self._borrow is not None else self
                    raise
                if self._borrow is not None:
                    self._borrow._poisoned = True
                    if isinstance(error, OwnedTransferError):
                        error.lease = self._borrow
                        raise
                    raise OwnedTransferError('IO_FAILED', self._borrow) from None
                raise self._error(error) from None

    def status(self):
        return {'binding': dict(self._binding), 'acquired': self._acquired, 'poisoned': self._poisoned, 'closed': self._closed,
                'closeUncertain': any(entry.phase == 'close-uncertain' for entry in self._handles),
                'retainedHandles': len(self._handles), 'borrowAttempted': self._borrow_attempted,
                'borrowActive': self._borrow is not None and not self._borrow._closed,
                'effectsAllowed': False, 'persistenceVerified': False,
                'nativeInstallAccepted': False, 'nativeTerminalVerified': False}
