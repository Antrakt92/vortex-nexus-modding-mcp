"""Regenerate or check integrity pins for the reviewed Git source inventory."""
import argparse
import hashlib
from io import BytesIO
import json
import ntpath
import os
from pathlib import Path
import subprocess
import tempfile

from recovery import no_links, relative

ROOT = Path(__file__).resolve().parents[1]
TEXT_SUFFIXES = {'.cjs', '.mjs', '.js', '.ts', '.tsx', '.py', '.ps1', '.json',
                 '.md', '.yml', '.yaml', '.txt', '.css', '.html', '.svg', '.cs', '.toml', '.xml', '.rs'}


def validate_encoding(name, data):
    # Node replaces invalid UTF-8 silently. A matching byte hash must not bless
    # damaged maintained source; upstream byte-pinned snapshots stay untouched.
    parts = Path(name).parts
    maintained = len(parts) == 1 or parts[0] in {'tools', 'scripts', 'tests', 'docs', '.github'}
    if maintained and (Path(name).suffix.lower() in TEXT_SUFFIXES or Path(name).name == 'Cargo.lock'):
        try:
            data.decode('utf-8', errors='strict')
        except UnicodeDecodeError:
            raise ValueError('Maintained text is not valid UTF-8: ' + name) from None


def content():
    # Use the index: unreviewed/ignored local state never enters the manifest.
    unstaged = subprocess.check_output(['git', 'diff', '--name-only', '-z'], cwd=ROOT).decode().split('\0')
    if any(name and name != 'recovery-manifest.json' for name in unstaged):
        raise ValueError('Stage or preserve pending source changes before regenerating the manifest')
    index = subprocess.check_output(['git', 'ls-files', '--stage', '-z'], cwd=ROOT)
    entries = {}
    portable_names = set()
    for record in filter(None, index.split(b'\0')):
        metadata, name = record.split(b'\t', 1)
        mode, object_id, stage = metadata.split()
        name = name.decode('utf-8')
        if stage != b'0':
            raise ValueError('Resolve unmerged source before generating its manifest: ' + name)
        if name == 'recovery-manifest.json':
            continue
        if mode not in {b'100644', b'100755'}:
            raise ValueError('Expected ordinary staged source file: ' + name)
        normalized_name = ntpath.normcase(relative(name).as_posix())
        if normalized_name in portable_names:
            raise ValueError('Duplicate portable recovery path: ' + name)
        portable_names.add(normalized_name)
        entries[name] = object_id
    names = sorted(entries)
    objects = BytesIO(subprocess.check_output(
        ['git', '--no-replace-objects', 'cat-file', '--batch'], cwd=ROOT,
        input=b''.join(entries[name] + b'\n' for name in names)))
    rows = []
    for name in names:
        fields = objects.readline().split()
        if len(fields) != 3 or fields[:2] != [entries[name], b'blob']:
            raise ValueError('Cannot read staged source blob: ' + name)
        size = int(fields[2])
        data = objects.read(size)
        if len(data) != size or objects.read(1) != b'\n':
            raise ValueError('Incomplete staged source blob: ' + name)
        path = ROOT / name
        no_links(path)
        if not path.is_file():
            raise ValueError('Expected ordinary source file: ' + name)
        normalized = data.replace(b'\r\n', b'\n')
        worktree_data = path.read_bytes()
        if worktree_data.replace(b'\r\n', b'\n') != normalized:
            raise ValueError('Working file differs from the staged source: ' + name)
        validate_encoding(name, data)
        rows.append({'path': name, 'sha256_lf': hashlib.sha256(normalized).hexdigest()})
    if not rows:
        raise ValueError('Stage the reviewed source inventory before generating its manifest')
    return (json.dumps({'schema': 1, 'digest': 'SHA-256 after CRLF-to-LF normalization',
                        'files': rows}, indent=2) + '\n').encode()


def update(write=False):
    target = ROOT / 'recovery-manifest.json'
    no_links(target)
    expected = content()
    if write:
        if target.exists() and not target.is_file():
            raise ValueError('Expected ordinary recovery manifest')
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(prefix='recovery-manifest-', suffix='.tmp', dir=ROOT, delete=False) as stream:
                temporary = Path(stream.name)
                stream.write(expected)
                stream.flush()
                os.fsync(stream.fileno())
            no_links(target)
            os.replace(temporary, target)
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)
    elif not target.exists() or target.read_bytes().replace(b'\r\n', b'\n') != expected:
        raise SystemExit('Recovery manifest differs; review/stage source changes, then use --write')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--write', action='store_true')
    args = parser.parse_args()
    update(args.write)
    print('Recovery manifest matches reviewed source inventory')
