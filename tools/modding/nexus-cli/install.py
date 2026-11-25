"""Install the pinned official release asset of the community Nexus CLI."""
import hashlib
import io
import json
import os
from pathlib import Path
import stat
import sys
import tempfile
import urllib.request
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from workspace_paths import workspace_root

ROOT = workspace_root(canonicalize=False) / 'local-state/nexus-cli'
VERSION = '1.1.1'
SHA256 = '4790715ab94847757eb405c6442dae8dcc73c2f656ec43c367038b7b79c5812d'
SIZE = 377388
URL = f'https://github.com/vadimtrifonov/nexusmods-cli/releases/download/v{VERSION}/nexusmods-{VERSION}-win-x64.zip'


def no_reparse(file):
    for parent in (*reversed(file.parents), file):
        try:
            info = parent.lstat()
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(info.st_mode) or getattr(info, 'st_file_attributes', 0) & 0x400:
            raise RuntimeError('Reparse installation path refused')


def file_stamp(info):
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_nlink)


def verify_existing_file(target, expected):
    message = 'Existing installation differs; refusing overwrite'
    no_reparse(target)
    before = target.lstat()
    if not stat.S_ISREG(before.st_mode) or not before.st_ino:
        raise RuntimeError(message)
    with target.open('rb') as source:
        opened = os.fstat(source.fileno())
        if file_stamp(opened) != file_stamp(before) or source.read(len(expected) + 1) != expected:
            raise RuntimeError(message)
        finished = os.fstat(source.fileno())
        if file_stamp(finished) != file_stamp(opened) or finished.st_ctime_ns != opened.st_ctime_ns:
            raise RuntimeError(message)
    no_reparse(target)
    current = target.lstat()
    if file_stamp(current) != file_stamp(before) or current.st_ctime_ns != before.st_ctime_ns:
        raise RuntimeError(message)
    # Windows path and descriptor ctime can use different clocks.
    return file_stamp(current), current.st_ctime_ns, finished.st_ctime_ns


def publish_new_file(target, data, *, before_publish=None):
    no_reparse(target)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(prefix='.nexus-cli-install-', dir=target.parent, delete=False) as output:
            temporary = Path(output.name)
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
        no_reparse(target)
        if before_publish is not None:
            before_publish()
        # Publish only complete bytes and refuse a concurrently created target.
        if os.name == 'nt':
            temporary.rename(target)
            temporary = None
        else:
            os.link(temporary, target)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def install():
    # Examine the configured path before normalization can remove a junction.
    no_reparse(ROOT)
    root = Path(os.path.abspath(ROOT))
    destination = root / VERSION
    receipt_path = root / 'installation.json'
    no_reparse(destination)
    no_reparse(receipt_path)
    root.mkdir(parents=True, exist_ok=True)
    archive = root / f'nexusmods-{VERSION}-win-x64.zip'
    no_reparse(archive)
    if not archive.exists():
        request = urllib.request.Request(URL, headers={'User-Agent': 'Nexus-Agent-Setup/1'})
        with urllib.request.urlopen(request, timeout=90) as response:
            data = response.read(SIZE + 1)
        if len(data) != SIZE or hashlib.sha256(data).hexdigest() != SHA256:
            raise RuntimeError('Release size/SHA256 mismatch')
        publish_new_file(archive, data)
    with archive.open('rb') as source:
        data = source.read(SIZE + 1)
    if len(data) != SIZE or hashlib.sha256(data).hexdigest() != SHA256:
        raise RuntimeError('Cached release size/SHA256 mismatch')
    # Extract the exact bytes whose frozen pin was checked, without reopening a
    # cache pathname that another process could replace after verification.
    files = {}
    with zipfile.ZipFile(io.BytesIO(data)) as zipped:
        if zipped.testzip() is not None:
            raise RuntimeError('Release CRC failure')
        for item in zipped.infolist():
            target = Path(os.path.abspath(destination / item.filename))
            if not target.is_relative_to(destination):
                raise RuntimeError('Release path escape')
            no_reparse(target)
            if item.is_dir():
                continue
            expected = zipped.read(item)
            if target in files:
                raise RuntimeError('Duplicate release installation path')
            files[target] = expected
            if target.exists():
                verify_existing_file(target, expected)
    executables = {file for file in files if file.name.lower() == 'nexusmods.exe'} | set(destination.rglob('nexusmods.exe'))
    if len(executables) != 1:
        raise RuntimeError('Expected one CLI executable')
    executable = next(iter(executables))
    if executable not in files:
        raise RuntimeError('CLI executable absent from pinned release')
    receipt = {'version': VERSION, 'source_commit': '494f061e9f277414c4df306826b4d92cd1e6b90c',
               'release_sha256': SHA256, 'release_size': SIZE, 'crc_verified': True,
               'executable': str(executable), 'exe_sha256': hashlib.sha256(files[executable]).hexdigest()}

    def capture_existing_receipt():
        no_reparse(receipt_path)
        if not receipt_path.exists():
            return None
        raw = receipt_path.read_bytes()
        if json.loads(raw.decode('utf-8')) != receipt:
            raise RuntimeError('Existing installation receipt differs; refusing overwrite')
        return raw, verify_existing_file(receipt_path, raw)

    # Preflight every existing output and the receipt before installing anything.
    retained_receipt = capture_existing_receipt()
    generations = {}
    for target, expected in files.items():
        no_reparse(target)
        target.parent.mkdir(parents=True, exist_ok=True)
        if not target.exists():
            publish_new_file(target, expected)
        generations[target] = verify_existing_file(target, expected)

    def verify_installed_files():
        for target, expected in files.items():
            if verify_existing_file(target, expected) != generations[target]:
                raise RuntimeError('Installed file generation changed before receipt publication')

    if retained_receipt is None:
        retained_receipt = capture_existing_receipt()
    if retained_receipt is not None:
        verify_installed_files()
        raw, generation = retained_receipt
        message = 'Existing installation receipt changed during verification'
        try:
            current = verify_existing_file(receipt_path, raw)
        except (OSError, RuntimeError) as error:
            raise RuntimeError(message) from error
        if current != generation:
            raise RuntimeError(message)
    else:
        publish_new_file(receipt_path, (json.dumps(receipt, indent=2) + '\n').encode('utf-8'),
                         before_publish=verify_installed_files)
    print(json.dumps(receipt))

if __name__ == '__main__':
    install()
