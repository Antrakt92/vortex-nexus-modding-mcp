"""Verify source recovery inputs and prepare local configuration without credentials."""
from __future__ import annotations
import argparse
import hashlib
import json
import ntpath
import os
from pathlib import Path, PurePosixPath, PureWindowsPath
import re
import stat
import subprocess
import sys
import tempfile
import urllib.request

ROOT = Path(__file__).resolve().parents[1]


def digest(data):
    return hashlib.sha256(data).hexdigest()


def relative(value):
    if not isinstance(value, str):
        raise ValueError('Unsafe recovery path')
    parts = value.split('/')
    for part in parts:
        if (not part or part.endswith(('.', ' ')) or any(c in '\\:<>"|?*' or ord(c) < 32 for c in part)
                or (ntpath.isreserved(part) if hasattr(ntpath, 'isreserved') else PureWindowsPath(part).is_reserved())):
            raise ValueError('Unsafe recovery path')
    return PurePosixPath(*parts)


def no_links(path):
    for p in (*reversed(path.parents), path):
        # exists() follows links and hides dangling reparse points.
        try:
            info = p.lstat()
        except FileNotFoundError:
            continue
        except NotADirectoryError as error:
            raise ValueError('Recovery parent is not a directory') from error
        if stat.S_ISLNK(info.st_mode) or getattr(info, 'st_file_attributes', 0) & 0x400:
            raise ValueError('Recovery through reparse paths is refused')
        if p != path and not stat.S_ISDIR(info.st_mode):
            raise ValueError('Recovery parent is not a directory')


def absolute(value):
    p = Path(value).expanduser()
    if not p.is_absolute():
        raise ValueError('Choose an absolute path')
    no_links(p)
    return p.resolve()


def verify(root=ROOT):
    manifest_path = root / 'recovery-manifest.json'
    no_links(manifest_path)
    manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
    if (not isinstance(manifest, dict) or set(manifest) != {'schema', 'digest', 'files'}
            or type(manifest['schema']) is not int or manifest['schema'] != 1
            or manifest['digest'] != 'SHA-256 after CRLF-to-LF normalization'
            or not isinstance(manifest['files'], list) or not manifest['files']):
        raise ValueError('Invalid or unsupported recovery manifest')
    seen = set()
    for row in manifest['files']:
        if (not isinstance(row, dict) or set(row) != {'path', 'sha256_lf'}
                or not isinstance(row['path'], str)
                or not isinstance(row['sha256_lf'], str)
                or not re.fullmatch(r'[a-f0-9]{64}', row['sha256_lf'])):
            raise ValueError('Invalid recovery manifest file entry')
        rel = relative(row['path']).as_posix()
        normalized = ntpath.normcase(rel)
        if normalized in seen:
            raise ValueError('Duplicate recovery input')
        seen.add(normalized)
        p = root / rel
        no_links(p)
        if not p.is_file() or digest(p.read_bytes().replace(b'\r\n', b'\n')) != row['sha256_lf']:
            raise ValueError('Recovery source differs: ' + rel)
    return {'verified_files': len(seen), 'integrity_verified': True}


def file_matches(path, expected):
    if not path.is_file():
        return False
    with path.open('rb') as existing:
        return existing.read(len(expected) + 1) == expected


def write_matching(path, data, apply):
    no_links(path)
    if path.exists():
        if not file_matches(path, data):
            raise ValueError('Existing file differs; refusing overwrite: ' + str(path))
        return 'unchanged'
    if apply:
        path.parent.mkdir(parents=True, exist_ok=True)
        no_links(path)
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(prefix='.recovery-', dir=path.parent, delete=False) as out:
                temporary = Path(out.name)
                out.write(data)
                out.flush()
                os.fsync(out.fileno())
            no_links(path)
            # Both publication paths refuse to replace a newly created destination.
            if os.name == 'nt':
                temporary.rename(path)
            else:
                os.link(temporary, path)
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)
    return 'created' if apply else 'would_create'


def configure(workspace, apply=False, source=ROOT):
    workspace = absolute(workspace)
    # Client-local environment only. No global environment, bearer or API key.
    value = {'mcpServers': {'vortex': {'command': 'node',
             'args': [str(source / 'tools/modding/vortex-agent/bridge.mjs')],
             'env': {'NEXUS_WORKSPACE': str(workspace),
                     'NEXUS_CONTEXT_ROOT': str(workspace / 'local-state/upstream-sources')}}}}
    data = (json.dumps(value, indent=2) + '\n').encode()
    target = workspace / 'local-state/nexus-tools-recovery/client-template.json'
    status = write_matching(target, data, apply)
    return {'mode': 'apply' if apply else 'plan', 'configuration': status, 'path': str(target),
            'client_configuration_modified': False, 'credentials_created': False}


def restore_skills(snapshot, destination, apply=False):
    snapshot, destination = absolute(snapshot), absolute(destination)
    manifest_path = snapshot / 'manifest.json'
    no_links(manifest_path)
    manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
    plan = []
    files, directories = set(), set()
    for row in manifest['skills']:
        rel = relative(row['path'])
        if rel.parts[0] != 'skills' or len(rel.parts) < 3:
            raise ValueError('Unexpected skill snapshot scope')
        key = tuple(part.lower() for part in rel.parts[1:])
        parents = {key[:length] for length in range(1, len(key))}
        if key in files or key in directories or files.intersection(parents):
            raise ValueError('Conflicting skill snapshot paths')
        files.add(key)
        directories.update(parents)
        src = snapshot / rel
        no_links(src)
        data = src.read_bytes()
        if digest(data) != row['sha256']:
            raise ValueError('Private skill snapshot changed')
        target = destination.joinpath(*rel.parts[1:])
        no_links(target)
        # Validate every destination before creating even one file.
        write_matching(target, data, False)
        plan.append((target, data))
    for target, data in plan:
        write_matching(target, data, apply)
    return {'mode': 'apply' if apply else 'plan', 'skills_files': len(plan),
            'unrelated_files_preserved': True}


def run_git(args, cwd=None):
    return subprocess.check_output(['git', *map(str, args)], cwd=cwd, stderr=subprocess.PIPE,
                                   encoding='utf-8', timeout=120).strip()


def bundle_size(row):
    size = row['bytes']
    if type(size) is not int or not 0 < size < sys.maxsize:
        raise ValueError('Invalid recovery bundle size pin')
    return size


def verify_bundle(bundle, row):
    size = bundle_size(row)
    no_links(bundle)
    if not bundle.is_file():
        raise ValueError('Missing supplied recovery bundle: ' + bundle.name)
    if bundle.stat().st_size != size:
        raise ValueError('Recovery bundle changed: ' + bundle.name)
    with bundle.open('rb') as stream:
        data = stream.read(size + 1)
    if len(data) != size or digest(data) != row['sha256']:
        raise ValueError('Recovery bundle changed: ' + bundle.name)
    return data


def fetch_sources(workspace, archive_dir=None, apply=False):
    workspace = absolute(workspace)
    lock = json.loads((ROOT / 'source-lock.json').read_text(encoding='utf-8'))
    results, pending = [], []
    archive_root = None
    for row in lock['upstreams']:
        name = relative(row['name']).as_posix()
        if '/' in name:
            raise ValueError('Invalid upstream name')
        bundle_name = relative(row['bundle']).as_posix()
        if '/' in bundle_name:
            raise ValueError('Invalid recovery bundle name')
        target = workspace / 'local-state/upstream-sources' / name
        no_links(target)
        if target.exists():
            if Path(run_git(['rev-parse', '--show-toplevel'], target)).resolve() != target.resolve():
                raise ValueError('Existing upstream checkout root differs: ' + name)
            if (run_git(['rev-parse', 'HEAD'], target) != row['commit']
                    or run_git(['--no-optional-locks', 'status', '--porcelain', '--untracked-files=no'], target)):
                raise ValueError('Existing upstream checkout differs: ' + name)
            results.append({'name': name, 'state': 'already_verified'})
            continue
        result = {'name': name, 'state': 'would_restore'}
        results.append(result)
        if archive_dir is not None:
            if archive_root is None:
                archive_root = absolute(archive_dir)
            bundle = archive_root / bundle_name
            verify_bundle(bundle, row)
            result['bundle_verification'] = 'size_and_sha256'
        else:
            bundle = workspace / 'local-state/recovery-downloads' / bundle_name
        pending.append((row, target, bundle, result))

    report = {'mode': 'apply' if apply else 'plan', 'sources': results,
              'vortex_restarted': False, 'credentials_included': False}
    if not apply:
        return report

    # A bad supplied bundle must block the batch before any checkout is made.
    for row, target, bundle, result in pending:
        no_links(bundle)
        if archive_dir is None and not bundle.exists():
            size = bundle_size(row)
            bundle.parent.mkdir(parents=True, exist_ok=True)
            url = row['url']
            if not url.startswith((
                    'https://github.com/Antrakt92/vortex-nexus-modding-mcp/releases/download/',
                    'https://github.com/Antrakt92/Nexus-Modding-Tools/releases/download/')):
                raise ValueError('Unexpected recovery download origin')
            with urllib.request.urlopen(url, timeout=90) as response:
                data = response.read(size + 1)
            if len(data) != size or digest(data) != row['sha256']:
                raise ValueError('Recovery download failed size/hash verification')
            write_matching(bundle, data, True)
            del data
        verified = verify_bundle(bundle, row)
        # Publish a checkout only after verification, so failed Git operations
        # cannot strand an incomplete repository at the final recovery path.
        target.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix='source-restore-', dir=target.parent) as tmp:
            private = Path(tmp)
            frozen = private / 'verified.bundle'
            if write_matching(frozen, verified, True) != 'created':
                raise ValueError('Private recovery bundle already exists')
            candidate = private / 'checkout'
            candidate.mkdir()
            run_git(['init', '--quiet'], candidate)
            no_links(frozen)
            if not file_matches(frozen, verified):
                raise ValueError('Private recovery bundle changed before fetch')
            del verified
            run_git(['fetch', '--quiet', '--no-tags', frozen, 'HEAD'], candidate)
            run_git(['checkout', '--quiet', '--detach', row['commit']], candidate)
            if run_git(['rev-parse', 'HEAD'], candidate) != row['commit']:
                raise ValueError('Recovered upstream commit mismatch')
            candidate.rename(target)
        result['state'] = 'restored'
    return report


def main():
    options = {'verify': set(), 'configure': {'workspace', 'apply'},
               'sources': {'workspace', 'apply', 'archive_dir'}, 'skills': {'snapshot', 'skills_home', 'apply'}}
    p = argparse.ArgumentParser(description=__doc__, argument_default=argparse.SUPPRESS)
    p.add_argument('command', choices=options)
    p.add_argument('--workspace')
    p.add_argument('--apply', action='store_true')
    p.add_argument('--archive-dir')
    p.add_argument('--snapshot')
    p.add_argument('--skills-home')
    args = p.parse_args()
    for option in sorted(vars(args).keys() - {'command'} - options[args.command]):
        p.error('--' + option.replace('_', '-') + ' is not supported for ' + args.command)
    apply = getattr(args, 'apply', False)
    workspace = getattr(args, 'workspace', os.environ.get('NEXUS_WORKSPACE', str(ROOT)))
    if args.command == 'verify':
        result = verify()
    elif args.command == 'configure':
        result = configure(workspace, apply)
    elif args.command == 'sources':
        result = fetch_sources(workspace, getattr(args, 'archive_dir', None), apply)
    else:
        if not getattr(args, 'snapshot', None) or not getattr(args, 'skills_home', None):
            p.error('skills requires --snapshot and --skills-home')
        result = restore_skills(args.snapshot, args.skills_home, apply)
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
