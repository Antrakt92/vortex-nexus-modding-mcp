"""Bounded plugin installation and protected-file snapshots; never edit managed mods."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import os
import re
import stat
import uuid
from contextlib import contextmanager

def absolute_root(value, name):
    if not isinstance(value, str) or not value or any(ord(c) < 32 for c in value):
        raise RuntimeError(name + ' requires an absolute path')
    result = Path(value)
    if not result.is_absolute():
        raise RuntimeError(name + ' requires an absolute path')
    # Preserve the supplied path components so no_reparse can still reject an
    # alias; resolving filesystem links here would hide them from that guard.
    return Path(os.path.abspath(result))


ROOT = absolute_root(os.environ.get('NEXUS_WORKSPACE', str(Path(__file__).resolve().parents[3])), 'NEXUS_WORKSPACE')
STATE = ROOT / 'local-state/agent-tooling-setup'
SOURCE = ROOT / 'local-state/vortex-agent-build/plugin/vortex-agent'
PLUGINS = absolute_root(os.environ.get('APPDATA', str(Path.home() / 'AppData/Roaming')), 'APPDATA') / 'Vortex/plugins'
RECEIPTS = ROOT / 'local-state/vortex-agent-build/receipts'
UPGRADES = ROOT / 'local-state/vortex-agent-build/upgrades'
PROCESS_GUARD = Path(__file__).resolve().with_name('guard.cjs')
PROCESS_SNAPSHOT_SCRIPT = """
const names = require(process.argv[1]).processNames();
process.stdout.write(JSON.stringify({schema: 1, complete: true, count: names.length, names}));
"""

def sha(file):
    digest = hashlib.sha256()
    with file.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()

def stopped():
    # Reuse the maintained bounded .NET enumeration instead of tasklist.
    # Always enumerate again, including immediately before the directory swap.
    try:
        node = shutil.which('node')
        if not node:
            raise RuntimeError('Unverifiable Windows process list')
        result = subprocess.run([str(Path(node).resolve()), '-e', PROCESS_SNAPSHOT_SCRIPT, str(PROCESS_GUARD)],
            capture_output=True, text=True, encoding='utf-8', timeout=15,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
        if result.returncode != 0 or result.stderr.strip() or len(result.stdout) > 1024 * 1024:
            raise RuntimeError('Unverifiable Windows process list')
        snapshot = json.loads(result.stdout)
        if not isinstance(snapshot, dict) or set(snapshot) != {'schema', 'complete', 'count', 'names'} \
            or type(snapshot['schema']) is not int or snapshot['schema'] != 1 or snapshot['complete'] is not True \
            or type(snapshot['count']) is not int or not 0 < snapshot['count'] <= 65536 \
            or not isinstance(snapshot['names'], list) or len(snapshot['names']) != snapshot['count'] \
            or any(not isinstance(name, str) or not 0 < len(name) <= 260
                or re.search(r'[\\/\x00-\x1f\x7f]', name) for name in snapshot['names']):
            raise RuntimeError('Unverifiable Windows process list')
        names = {name.lower() for name in snapshot['names']}
    except (OSError, subprocess.SubprocessError, UnicodeError, json.JSONDecodeError) as exc:
        raise RuntimeError('Unverifiable Windows process list') from exc
    if names & {name.lower() for name in ['Vortex.exe', 'Cyberpunk2077.exe', 'REDprelauncher.exe', 'ACU.exe', 'SkyrimSE.exe', 'SkyrimVR.exe', 'skse64_loader.exe', 'sksevr_loader.exe', 'Fallout4.exe', 'f4se_loader.exe']}:
        raise RuntimeError('Vortex/game still running; close gracefully before installation')

def game_roots(values=None):
    if values is None:
        try:
            values = json.loads(os.environ.get('NEXUS_GAME_ROOTS_JSON', '[]'))
        except json.JSONDecodeError as exc:
            raise RuntimeError('NEXUS_GAME_ROOTS_JSON must be an array of absolute game directories') from exc
    if not isinstance(values, list) or not values:
        raise RuntimeError('Snapshot requires explicit --game-root paths or NEXUS_GAME_ROOTS_JSON; game protection cannot be assumed')
    roots = [absolute_root(value, 'game root') for value in values]
    if len(set(roots)) != len(roots) or any(not root.is_dir() for root in roots):
        raise RuntimeError('Game roots must be distinct existing directories')
    return roots


def checked_label(label):
    if not isinstance(label, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,127}', label):
        raise RuntimeError('Snapshot label must be a bounded filename component')
    return label


def snapshot(label, roots=None):
    label = checked_label(label)
    files = set()
    for game in game_roots(roots):
        files.update(game.glob('vortex.deployment*.json'))
        files.update((game / 'r6/scripts').rglob('*.reds'))
        files.update((game / 'r6/tweaks').rglob('*.yaml'))
        files.update((game / 'r6/tweaks').rglob('*.yml'))
    for directory in PLUGINS.iterdir():
        if directory.is_dir() and directory.name != 'vortex-agent':
            files.update(p for p in directory.rglob('*') if p.is_file())
    values = {str(p): {'size': p.stat().st_size, 'sha256': sha(p)} for p in sorted(files) if p.is_file()}
    STATE.mkdir(parents=True, exist_ok=True)
    destination = STATE / (label + '.snapshot.json')
    with destination.open('x', encoding='utf-8') as output:
        json.dump(values, output, indent=2)
    print(json.dumps({'snapshot': str(destination), 'files': len(values)}))

def compare(before, after):
    before, after = checked_label(before), checked_label(after)
    old = json.loads((STATE / (before + '.snapshot.json')).read_text(encoding='utf-8'))
    new = json.loads((STATE / (after + '.snapshot.json')).read_text(encoding='utf-8'))
    changed = sorted(p for p in old.keys() | new.keys() if old.get(p) != new.get(p))
    result = {'unchanged': not changed, 'before_count': len(old), 'after_count': len(new), 'changed_paths': changed}
    (STATE / 'protected-state-comparison.json').write_text(json.dumps(result, indent=2), encoding='utf-8')
    print(json.dumps(result))
    if changed:
        raise RuntimeError('Protected files changed; inspect comparison')

def no_reparse(file):
    for parent in [file, *file.parents]:
        try:
            attributes = getattr(parent.lstat(), 'st_file_attributes', 0)
        except FileNotFoundError:
            continue
        if parent.is_symlink() or attributes & 0x400:
            raise RuntimeError('Reparse path refused')


def directory_identity(directory):
    no_reparse(directory)
    value = directory.stat()
    if not directory.is_dir():
        raise RuntimeError('Plugin directory identity unavailable')
    return value.st_dev, value.st_ino


def package(directory, expected_sha, target_version=None, *, allow_historical=False):
    if not expected_sha or not re.fullmatch('[a-f0-9]{64}', expected_sha):
        raise RuntimeError('Explicit frozen bundle SHA-256 required')
    no_reparse(directory)
    base_files = {'index.js', 'info.json', 'LICENSE.md', 'provenance.json'}
    entries = {p.name for p in directory.iterdir()}
    if entries not in (base_files, base_files | {'THIRD-PARTY-NOTICES.md'}):
        raise RuntimeError('Unexpected plugin contents; preserve and inspect')
    for file in directory.iterdir():
        no_reparse(file)
        if not file.is_file():
            raise RuntimeError('Plugin entry is not a regular file')
    provenance = json.loads((directory / 'provenance.json').read_text(encoding='utf-8'))
    info = json.loads((directory / 'info.json').read_text(encoding='utf-8'))
    if sha(directory / 'index.js') != expected_sha or provenance['pluginSha256'] != expected_sha:
        raise RuntimeError('Plugin bundle pin mismatch')
    if info.get('id') != 'vortex-agent' or info['version'] != provenance['version'] or (target_version and info['version'] != target_version):
        raise RuntimeError('Owned plugin/version identity mismatch')
    if provenance.get('protocol') != 'vortex-agent/1' or provenance.get('installSupported') is not False:
        raise RuntimeError('Plugin contract mismatch')
    historical = entries == base_files and allow_historical and provenance.get('version') in {'1.0.3', '1.0.4'} \
        and 'packageSchemaVersion' not in provenance and 'licenseFileSHA256' not in provenance and 'sourceOffer' not in provenance
    if not historical:
        if entries != base_files | {'THIRD-PARTY-NOTICES.md'} or provenance.get('packageSchemaVersion') != 2:
            raise RuntimeError('Current plugin package requires pinned third-party notices')
        licenses = provenance.get('licenseFileSHA256')
        if not isinstance(licenses, dict) or set(licenses) != {'LICENSE.md', 'THIRD-PARTY-NOTICES.md'}:
            raise RuntimeError('License file pin contract mismatch')
        for name, pin in licenses.items():
            if not isinstance(pin, str) or not re.fullmatch('[a-f0-9]{64}', pin) or sha(directory / name) != pin:
                raise RuntimeError('License file pin mismatch')
        offer = provenance.get('sourceOffer')
        if not isinstance(offer, dict) or not isinstance(offer.get('repository'), str) or offer['repository'] not in {
                'https://github.com/Antrakt92/vortex-nexus-modding-mcp',
                'https://github.com/Antrakt92/Nexus-Modding-Tools'}:
            raise RuntimeError('Corresponding source repository contract mismatch')
    return provenance


def receipt_pins():
    no_reparse(RECEIPTS)
    if not RECEIPTS.exists():
        return {}
    if not RECEIPTS.is_dir():
        raise RuntimeError('Receipt root is not a directory')
    pins, observed, identities, names = {}, {}, set(), set()
    total_bytes = 0

    def generation(value):
        return (value.st_dev, value.st_ino, value.st_mode, value.st_size,
                value.st_mtime_ns, getattr(value, 'st_birthtime_ns', value.st_ctime_ns), value.st_nlink,
                getattr(value, 'st_file_attributes', 0))

    def walk(entry, relative, depth):
        nonlocal total_bytes
        if depth > 32 or len(pins) >= 100000:
            raise RuntimeError('Receipt tree limit exceeded')
        no_reparse(entry)
        before = entry.lstat()
        identity = (before.st_dev, before.st_ino)
        if identity in identities or relative.casefold() in names:
            raise RuntimeError('Receipt alias refused')
        identities.add(identity)
        names.add(relative.casefold())
        observed[entry] = generation(before)
        pin = {'generation': list(observed[entry])}
        if stat.S_ISDIR(before.st_mode):
            children = sorted(entry.iterdir(), key=lambda p: p.name)
            pin.update(type='directory', changeTimeNS=before.st_ctime_ns, children=[p.name for p in children])
            pins[relative] = pin
            for child in children:
                walk(child, child.relative_to(RECEIPTS).as_posix(), depth + 1)
        elif stat.S_ISREG(before.st_mode) and before.st_nlink == 1:
            total_bytes += before.st_size
            if total_bytes > 1024 * 1024 * 1024:
                raise RuntimeError('Receipt tree byte limit exceeded')
            digest = hashlib.sha256()
            with entry.open('rb') as stream:
                opened = os.fstat(stream.fileno())
                if generation(opened) != observed[entry]:
                    raise RuntimeError('Receipt generation changed')
                for chunk in iter(lambda: stream.read(1024 * 1024), b''):
                    digest.update(chunk)
                after = os.fstat(stream.fileno())
                if generation(after) != observed[entry] or after.st_ctime_ns != opened.st_ctime_ns:
                    raise RuntimeError('Receipt generation changed')
            # Windows path/handle APIs can expose different ctime values; compare
            # creation identity across APIs and change time only on open handles.
            pin.update(type='file', size=before.st_size, handleChangeTimeNS=opened.st_ctime_ns,
                       sha256=digest.hexdigest())
            pins[relative] = pin
        else:
            raise RuntimeError('Receipt entry is not an unaliased regular file or directory')

    walk(RECEIPTS, '.', 0)
    # Recheck the entire observed tree, including empty directories and the root.
    for entry, before in observed.items():
        no_reparse(entry)
        if generation(entry.lstat()) != before:
            raise RuntimeError('Receipt tree changed during snapshot')
        if pins[entry.relative_to(RECEIPTS).as_posix()]['type'] == 'directory':
            if entry.lstat().st_ctime_ns != pins[entry.relative_to(RECEIPTS).as_posix()]['changeTimeNS']:
                raise RuntimeError('Receipt tree changed during snapshot')
            if sorted(p.name for p in entry.iterdir()) != pins[entry.relative_to(RECEIPTS).as_posix()]['children']:
                raise RuntimeError('Receipt tree changed during snapshot')
        else:
            with entry.open('rb') as stream:
                current = os.fstat(stream.fileno())
                if generation(current) != before or current.st_ctime_ns != pins[entry.relative_to(RECEIPTS).as_posix()]['handleChangeTimeNS']:
                    raise RuntimeError('Receipt tree changed during snapshot')
    return pins


def verify_sources(provenance):
    for name, pin in provenance['sources'].items():
        if Path(name).name != name or not re.fullmatch('[a-f0-9]{64}', pin):
            raise RuntimeError('Invalid maintained source provenance')
        if sha(Path(provenance['maintainedSource']) / name) != pin:
            raise RuntimeError('Maintained source provenance differs')


@contextmanager
def install_lock():
    no_reparse(UPGRADES)
    UPGRADES.mkdir(parents=True, exist_ok=True)
    lock = UPGRADES / 'install.lock'
    owner = f'{os.getpid()}:{uuid.uuid4().hex}'
    with lock.open('x', encoding='utf-8') as handle:
        handle.write(owner)
        handle.flush()
        os.fsync(handle.fileno())
    try:
        yield
    finally:
        no_reparse(lock)
        if lock.read_text(encoding='utf-8') != owner:
            raise RuntimeError('Installer lock ownership changed; cleanup refused')
        lock.unlink()


def verify_runtime_workspace(provenance):
    runtime = absolute_root(provenance.get('workspaceRoot'), 'Package runtime workspace')
    no_reparse(runtime)
    if os.path.normcase(str(runtime)) != os.path.normcase(str(ROOT)):
        raise RuntimeError('Package runtime workspace differs from active credential/receipt workspace')


def install(expected_sha, from_sha=None, package_root=None):
    stopped()
    source = SOURCE if package_root is None else absolute_root(package_root, 'Package root')
    provenance = package(source, expected_sha, '1.1.0')
    verify_runtime_workspace(provenance)
    verify_sources(provenance)
    target = PLUGINS / 'vortex-agent'
    no_reparse(PLUGINS)
    if not PLUGINS.is_dir():
        raise RuntimeError('Confirmed plugins parent missing')
    if target.exists() and not from_sha:
        raise RuntimeError('Existing plugin; use explicit pinned upgrade')
    if from_sha and not target.exists():
        raise RuntimeError('Upgrade requires the existing owned plugin')
    if target.exists():
        package(target, from_sha, allow_historical=True)
    with install_lock():
        run = UPGRADES / uuid.uuid4().hex
        run.mkdir()
        pins = receipt_pins()
        if target.exists():
            shutil.copytree(target, run / 'old-plugin')
            package(run / 'old-plugin', from_sha, allow_historical=True)
        (run / 'receipt-pins.json').write_text(json.dumps(pins, indent=2), encoding='utf-8')
        # Staging and the atomic directory swap are on the installation volume.
        temp_parent = PLUGINS.parent / 'temp'
        no_reparse(temp_parent)
        temp_parent.mkdir(exist_ok=True)
        staged = temp_parent / ('vortex-agent-upgrade-' + run.name)
        old = temp_parent / ('vortex-agent-old-' + run.name)
        shutil.copytree(source, staged)
        staged_provenance = package(staged, expected_sha, '1.1.0')
        stopped()
        verify_runtime_workspace(staged_provenance)
        verify_sources(staged_provenance)
        if receipt_pins() != pins:
            raise RuntimeError('Receipt pins changed before swap')
        staged_identity = directory_identity(staged)
        try:
            if target.exists():
                package(target, from_sha, allow_historical=True)
                target.rename(old)
            staged.rename(target)
            package(target, expected_sha, '1.1.0')
            if receipt_pins() != pins:
                raise RuntimeError('Receipt pins changed during upgrade')
        except BaseException:
            # Recover an interrupted swap, but never move a concurrent foreign
            # target just because it occupies the installation pathname.
            if target.exists() or target.is_symlink():
                if directory_identity(target) == staged_identity:
                    target.rename(temp_parent / ('vortex-agent-failed-' + run.name))
                elif old.exists():
                    raise RuntimeError('Plugin target changed during failed swap; rollback refused; old plugin retained')
            if old.exists():
                package(old, from_sha, allow_historical=True)
                old.rename(target)
            raise
        result = {'installed': str(target), 'version': '1.1.0', 'sha256': expected_sha, 'oldBundleBackup': str(run / 'old-plugin') if from_sha else None,
                  'receiptPins': str(run / 'receipt-pins.json'), 'receiptsUnchanged': True, 'restartPerformed': False}
        (run / 'upgrade.json').write_text(json.dumps(result, indent=2), encoding='utf-8')
        print(json.dumps(result))

def sync_provenance(expected_sha, package_root=None):
    source = SOURCE if package_root is None else absolute_root(package_root, 'Package root')
    target = PLUGINS / 'vortex-agent'
    with install_lock():
        provenance = package(source, expected_sha, '1.1.0')
        package(target, expected_sha, '1.1.0')
        verify_runtime_workspace(provenance)
        verify_sources(provenance)
        pins = receipt_pins()
        metadata = (source / 'provenance.json').read_bytes()
        if json.loads(metadata) != provenance:
            raise RuntimeError('Source provenance changed before sync')
        temp = target / ('provenance-' + uuid.uuid4().hex + '.tmp')
        try:
            with temp.open('xb') as handle:
                handle.write(metadata)
                handle.flush()
                os.fsync(handle.fileno())
            if receipt_pins() != pins:
                raise RuntimeError('Receipt pins changed before metadata sync')
            verify_runtime_workspace(provenance)
            verify_sources(provenance)
            if (source / 'provenance.json').read_bytes() != metadata:
                raise RuntimeError('Source provenance changed during metadata staging')
            os.replace(temp, target / 'provenance.json')
        finally:
            if temp.exists():
                temp.unlink()
    print(json.dumps({'provenance_synced': True, 'runtime_bundle_changed': False, 'sha256': expected_sha}))

def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument('operation', choices=['snapshot', 'compare', 'install', 'upgrade', 'sync-provenance'])
    parser.add_argument('--expected-sha')
    parser.add_argument('--from-sha')
    parser.add_argument('--package-root', help='Absolute verified package directory; runtime workspace must still match NEXUS_WORKSPACE')
    parser.add_argument('--game-root', action='append', help='Absolute game directory protected by snapshot; repeat for every game')
    parser.add_argument('labels', nargs='*')
    args = parser.parse_args(argv)
    if args.package_root is not None and args.operation not in {'install', 'upgrade', 'sync-provenance'}:
        parser.error('--package-root is supported only for install/upgrade/sync-provenance')
    if args.operation == 'snapshot' and len(args.labels) == 1:
        snapshot(args.labels[0], args.game_root)
    elif args.operation == 'compare' and len(args.labels) == 2:
        compare(*args.labels)
    elif args.operation == 'install' and not args.labels:
        install(args.expected_sha, package_root=args.package_root)
    elif args.operation == 'upgrade' and not args.labels:
        if not args.from_sha:
            parser.error('upgrade requires --from-sha')
        install(args.expected_sha, args.from_sha, args.package_root)
    elif args.operation == 'sync-provenance' and not args.labels:
        sync_provenance(args.expected_sha, package_root=args.package_root)
    else:
        parser.error('snapshot requires one label; compare two; install none')


if __name__ == '__main__':
    main()
