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
import tempfile
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
SOURCE_INVENTORY = PROCESS_GUARD.with_name('maintained-sources.json')
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
    destination = STATE / (label + '.snapshot.json')
    no_reparse(destination)
    STATE.mkdir(parents=True, exist_ok=True)
    no_reparse(destination)
    with destination.open('x', encoding='utf-8') as output:
        json.dump(values, output, indent=2)
    print(json.dumps({'snapshot': str(destination), 'files': len(values)}))

def compare(before, after):
    before, after = checked_label(before), checked_label(after)
    snapshots = [STATE / (label + '.snapshot.json') for label in (before, after)]
    for snapshot_path in snapshots:
        no_reparse(snapshot_path)
    old, new = (json.loads(p.read_text(encoding='utf-8')) for p in snapshots)
    changed = sorted(p for p in old.keys() | new.keys() if old.get(p) != new.get(p))
    result = {'unchanged': not changed, 'before_count': len(old), 'after_count': len(new), 'changed_paths': changed}
    destination = STATE / 'protected-state-comparison.json'
    no_reparse(destination)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=STATE,
                                         suffix='.tmp', delete=False) as output:
            temporary = Path(output.name)
            json.dump(result, output, indent=2)
            output.flush()
            os.fsync(output.fileno())
        no_reparse(destination)
        # Rename rather than truncate so an existing hardlink cannot alter its
        # other pathname's contents.
        os.replace(temporary, destination)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
    print(json.dumps(result))
    if changed:
        raise RuntimeError('Protected files changed; inspect comparison')

def no_reparse(file):
    for parent in (*reversed(file.parents), file):
        try:
            info = parent.lstat()
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(info.st_mode) or getattr(info, 'st_file_attributes', 0) & 0x400:
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
                read_bytes = 0
                for chunk in iter(lambda: stream.read(1024 * 1024), b''):
                    read_bytes += len(chunk)
                    if read_bytes > before.st_size:
                        raise RuntimeError('Receipt size changed during snapshot')
                    digest.update(chunk)
                after = os.fstat(stream.fileno())
                if read_bytes != before.st_size or generation(after) != observed[entry] or after.st_ctime_ns != opened.st_ctime_ns:
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
    no_reparse(SOURCE_INVENTORY)
    inventory_bytes = SOURCE_INVENTORY.read_bytes()
    inventory = json.loads(inventory_bytes)
    keys = {'bundleModules', 'provenanceOnly'}
    if (not isinstance(inventory, dict) or set(inventory) != keys
            or any(not isinstance(inventory[key], list) or not inventory[key] for key in keys)):
        raise RuntimeError('Invalid maintained source inventory')
    names = [*inventory['bundleModules'], *inventory['provenanceOnly'], SOURCE_INVENTORY.name]
    if (any(not isinstance(name, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]*\.(?:cjs|mjs|py|json)', name) for name in names)
            or len({name.lower() for name in names}) != len(names)):
        raise RuntimeError('Invalid maintained source inventory')
    sources = provenance.get('sources')
    if not isinstance(sources, dict) or set(sources) != set(names):
        raise RuntimeError('Package maintained source inventory differs')
    root = absolute_root(provenance.get('maintainedSource'), 'Maintained source root')
    for name, pin in sources.items():
        if not isinstance(pin, str) or not re.fullmatch('[a-f0-9]{64}', pin):
            raise RuntimeError('Invalid maintained source provenance')
        file = root / name
        no_reparse(file)
        if not file.is_file():
            raise RuntimeError('Maintained source provenance differs')
        if name == SOURCE_INVENTORY.name:
            data = file.read_bytes()
            if data.replace(b'\r\n', b'\n') != inventory_bytes.replace(b'\r\n', b'\n'):
                raise RuntimeError('Package maintained source inventory differs')
            digest = hashlib.sha256(data).hexdigest()
        else:
            digest = sha(file)
        if digest != pin:
            raise RuntimeError('Maintained source provenance differs')


@contextmanager
def install_lock():
    no_reparse(UPGRADES)
    UPGRADES.mkdir(parents=True, exist_ok=True)
    lock = UPGRADES / 'install.lock'
    owner = f'{os.getpid()}:{uuid.uuid4().hex}'
    owner_bytes = owner.encode('utf-8')
    windows_generation = None
    pending = None
    acquired = False
    try:
        try:
            # Publish a complete owner record atomically without replacing another
            # installer. A write or flush failure leaves no active lock.
            with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=UPGRADES,
                                             prefix='.install-lock-', delete=False) as handle:
                pending = Path(handle.name)
                handle.write(owner)
                handle.flush()
                os.fsync(handle.fileno())
            if os.name == 'nt':
                windows_generation = prepared_receipt_generation(pending, owner_bytes)
                if windows_generation is None:
                    pending = None
                    raise RuntimeError('Prepared installer lock changed; acquisition refused')
                try:
                    pending.rename(lock)
                    if prepared_receipt_generation(lock, owner_bytes) != windows_generation or os.path.lexists(pending):
                        raise RuntimeError('Published installer lock could not be verified; acquisition refused')
                    acquired = True
                except (OSError, KeyboardInterrupt) as error:
                    # A caught interrupt can arrive after Windows moved the
                    # exact lock even though the installer never entered.
                    acquired = False
                    cleanup = None
                    if not os.path.lexists(pending) and \
                            prepared_receipt_generation(lock, owner_bytes) == windows_generation and \
                            not os.path.lexists(pending):
                        cleanup = lock
                    elif prepared_receipt_generation(pending, owner_bytes) == windows_generation:
                        cleanup = pending
                    pending = None
                    if cleanup is not None:
                        try:
                            cleanup.unlink()
                        except OSError:
                            error.add_note('Installer lock cleanup failed; inspect lock state before retry')
                    raise
                pending = None
            else:
                os.link(pending, lock)
                acquired = True
        finally:
            if pending is not None and (windows_generation is None or
                                        prepared_receipt_generation(pending, owner_bytes) == windows_generation):
                pending.unlink(missing_ok=True)
        yield
    finally:
        if acquired:
            no_reparse(lock)
            if windows_generation is not None:
                owned = prepared_receipt_generation(lock, owner_bytes) == windows_generation
            else:
                owned = lock.read_text(encoding='utf-8') == owner
            if not owned:
                raise RuntimeError('Installer lock ownership changed; cleanup refused')
            lock.unlink()


def verify_runtime_workspace(provenance):
    runtime = absolute_root(provenance.get('workspaceRoot'), 'Package runtime workspace')
    no_reparse(runtime)
    if os.path.normcase(str(runtime)) != os.path.normcase(str(ROOT)):
        raise RuntimeError('Package runtime workspace differs from active credential/receipt workspace')


def prepared_receipt_generation(file, payload, *, links=1):
    """Pin the exact private receipt across a rename, or return no proof."""
    def identity(value):
        return (value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns,
                getattr(value, 'st_birthtime_ns', None), value.st_nlink)

    try:
        no_reparse(file)
        before = file.lstat()
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != links or before.st_size != len(payload):
            return None
        pin = identity(before)
        with file.open('rb') as stream:
            opened = os.fstat(stream.fileno())
            if identity(opened) != pin or stream.read(len(payload) + 1) != payload:
                return None
            finished = os.fstat(stream.fileno())
            if identity(finished) != pin or finished.st_ctime_ns != opened.st_ctime_ns:
                return None
        no_reparse(file)
        current = file.lstat()
        return pin if identity(current) == pin and current.st_ctime_ns == before.st_ctime_ns else None
    except (OSError, RuntimeError):
        return None


def publish_upgrade_receipt(pending, final):
    if os.name == 'nt':
        pending.rename(final)
    else:
        os.link(pending, final)


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
    no_reparse(target)
    present = target.exists()
    if present and not from_sha:
        raise RuntimeError('Existing plugin; use explicit pinned upgrade')
    if from_sha and not present:
        raise RuntimeError('Upgrade requires the existing owned plugin')
    prior_identity = directory_identity(target) if present else None
    prior_package = package(target, from_sha, allow_historical=True) if present else None

    def check_target():
        no_reparse(target)
        if prior_identity is None:
            if target.exists():
                raise RuntimeError('Plugin target appeared during installation')
            return
        try:
            current_identity = directory_identity(target)
        except FileNotFoundError as error:
            raise RuntimeError('Upgrade target disappeared') from error
        if current_identity != prior_identity or package(target, from_sha, allow_historical=True) != prior_package:
            raise RuntimeError('Upgrade target changed')

    with install_lock():
        check_target()
        run = UPGRADES / uuid.uuid4().hex
        run.mkdir()
        pins = receipt_pins()
        check_target()
        if prior_identity is not None:
            shutil.copytree(target, run / 'old-plugin')
            if package(run / 'old-plugin', from_sha, allow_historical=True) != prior_package:
                raise RuntimeError('Upgrade target changed while backing up')
            check_target()
        (run / 'receipt-pins.json').write_text(json.dumps(pins, indent=2), encoding='utf-8')
        # Staging and the atomic directory swap are on the installation volume.
        temp_parent = PLUGINS.parent / 'temp'
        no_reparse(temp_parent)
        temp_parent.mkdir(exist_ok=True)
        staged = temp_parent / ('vortex-agent-upgrade-' + run.name)
        old = temp_parent / ('vortex-agent-old-' + run.name)
        shutil.copytree(source, staged)
        staged_identity = directory_identity(staged)
        staged_provenance = package(staged, expected_sha, '1.1.0')
        stopped()
        verify_runtime_workspace(staged_provenance)
        verify_sources(staged_provenance)
        if receipt_pins() != pins:
            raise RuntimeError('Receipt pins changed before swap')
        if directory_identity(staged) != staged_identity or package(staged, expected_sha, '1.1.0') != staged_provenance:
            raise RuntimeError('Staged package changed before swap')
        if os.path.lexists(old):
            raise RuntimeError('Upgrade rollback destination already exists')
        check_target()
        result = {'installed': str(target), 'version': '1.1.0', 'sha256': expected_sha, 'oldBundleBackup': str(run / 'old-plugin') if from_sha else None,
                  'receiptPins': str(run / 'receipt-pins.json'), 'receiptsUnchanged': True, 'restartPerformed': False}
        receipt_pending = run / 'upgrade.json.pending'
        receipt_final = run / 'upgrade.json'
        receipt_bytes = json.dumps(result, indent=2).encode('utf-8')
        with receipt_pending.open('xb') as output:
            output.write(receipt_bytes)
            output.flush()
            os.fsync(output.fileno())
        receipt_generation = prepared_receipt_generation(receipt_pending, receipt_bytes)
        if receipt_generation is None:
            raise RuntimeError('Prepared upgrade receipt changed before swap')

        def receipt_committed():
            return (not os.path.lexists(receipt_pending)
                    and prepared_receipt_generation(receipt_final, receipt_bytes) == receipt_generation
                    and not os.path.lexists(receipt_pending))

        def exact_linked_receipt():
            linked_generation = (*receipt_generation[:-1], 2)
            return (prepared_receipt_generation(receipt_final, receipt_bytes, links=2) == linked_generation
                    and prepared_receipt_generation(receipt_pending, receipt_bytes, links=2) == linked_generation)

        stopped()
        publication_attempted = False
        try:
            if prior_identity is not None:
                target.rename(old)
                if directory_identity(old) != prior_identity:
                    raise RuntimeError('Upgrade target changed during swap')
            staged.rename(target)
            if directory_identity(target) != staged_identity or package(target, expected_sha, '1.1.0') != staged_provenance:
                raise RuntimeError('Staged package changed during swap')
            if receipt_pins() != pins:
                raise RuntimeError('Receipt pins changed during upgrade')
            # Only the final name is a success receipt. A publication failure
            # must recover the same plugin state as any post-swap failure.
            if os.path.lexists(receipt_final):
                raise RuntimeError('Upgrade receipt destination already exists')
            if prepared_receipt_generation(receipt_pending, receipt_bytes) != receipt_generation:
                raise RuntimeError('Prepared upgrade receipt changed before publication')
            publication_attempted = True
            publish_upgrade_receipt(receipt_pending, receipt_final)
            if os.name != 'nt':
                if not exact_linked_receipt():
                    raise RuntimeError('Linked upgrade receipt changed before staging cleanup')
                receipt_pending.unlink()
        except BaseException as error:
            if publication_attempted:
                # An interrupt can arrive after the OS already committed the
                # rename. Once committed, never reverse the package swap.
                if receipt_committed():
                    raise
                if os.name != 'nt' and isinstance(error, KeyboardInterrupt) and exact_linked_receipt():
                    try:
                        receipt_pending.unlink()
                    except OSError:
                        error.add_note('Upgrade receipt staging cleanup failed; inspect retained receipt')
                    raise
                still_pending = prepared_receipt_generation(receipt_pending, receipt_bytes) == receipt_generation
                if not still_pending or (os.path.lexists(receipt_final) and not isinstance(error, FileExistsError)):
                    raise RuntimeError('Upgrade receipt publication uncertain; plugin state retained') from error
            # Recover an interrupted swap, but never move a concurrent foreign
            # target just because it occupies the installation pathname.
            if target.exists() or target.is_symlink():
                if directory_identity(target) == staged_identity:
                    target.rename(temp_parent / ('vortex-agent-failed-' + run.name))
                elif old.exists():
                    raise RuntimeError('Plugin target changed during failed swap; rollback refused; old plugin retained')
            if os.path.lexists(old):
                if prior_identity is None or directory_identity(old) != prior_identity \
                        or package(old, from_sha, allow_historical=True) != prior_package:
                    raise RuntimeError('Saved plugin changed during failed swap; rollback refused')
                old.rename(target)
            raise
        # A returned rename is not a readback. Keep both packages for inspection
        # if the terminal receipt no longer binds the exact prepared file.
        if not receipt_committed():
            raise RuntimeError('Upgrade receipt publication uncertain; plugin state retained')
        print(json.dumps(result))

def sync_provenance(expected_sha, package_root=None):
    source = SOURCE if package_root is None else absolute_root(package_root, 'Package root')
    target = PLUGINS / 'vortex-agent'
    with install_lock():
        provenance = package(source, expected_sha, '1.1.0')
        installed = package(target, expected_sha, '1.1.0')
        if installed['licenseFileSHA256'] != provenance['licenseFileSHA256']:
            raise RuntimeError('Installed license files differ from source provenance')
        target_identity = directory_identity(target)
        installed_file = target / 'provenance.json'
        installed_bytes = installed_file.read_bytes()
        installed_generation = prepared_receipt_generation(installed_file, installed_bytes)
        if installed_generation is None or json.loads(installed_bytes) != installed:
            raise RuntimeError('Installed provenance changed before metadata sync')
        verify_runtime_workspace(provenance)
        verify_sources(provenance)
        pins = receipt_pins()
        metadata = (source / 'provenance.json').read_bytes()
        if json.loads(metadata) != provenance:
            raise RuntimeError('Source provenance changed before sync')
        # Keep the staged file outside the installed package so its exact
        # inventory can be revalidated immediately before replacing metadata.
        temp_parent = PLUGINS.parent / 'temp'
        no_reparse(temp_parent)
        temp_parent.mkdir(exist_ok=True)
        temp = temp_parent / ('vortex-agent-provenance-' + uuid.uuid4().hex + '.tmp')
        staged_generation = None
        try:
            with temp.open('xb') as handle:
                handle.write(metadata)
                handle.flush()
                os.fsync(handle.fileno())
            staged_generation = prepared_receipt_generation(temp, metadata)
            if staged_generation is None:
                raise RuntimeError('Prepared provenance changed during metadata staging')
            if receipt_pins() != pins:
                raise RuntimeError('Receipt pins changed before metadata sync')
            verify_runtime_workspace(provenance)
            verify_sources(provenance)
            if (source / 'provenance.json').read_bytes() != metadata:
                raise RuntimeError('Source provenance changed during metadata staging')
            if directory_identity(target) != target_identity or package(target, expected_sha, '1.1.0') != installed:
                raise RuntimeError('Installed plugin changed during metadata staging')
            if prepared_receipt_generation(installed_file, installed_bytes) != installed_generation:
                raise RuntimeError('Installed provenance changed during metadata staging')
            if prepared_receipt_generation(temp, metadata) != staged_generation:
                raise RuntimeError('Prepared provenance changed before metadata sync')
            try:
                os.replace(temp, installed_file)
            except OSError as error:
                if prepared_receipt_generation(temp, metadata) == staged_generation and \
                        prepared_receipt_generation(installed_file, installed_bytes) == installed_generation:
                    raise
                raise RuntimeError('Provenance sync outcome uncertain; inspect installed package') from error

            try:
                verified = (receipt_pins() == pins and directory_identity(target) == target_identity
                            and prepared_receipt_generation(installed_file, metadata) == staged_generation
                            and package(target, expected_sha, '1.1.0') == provenance
                            and prepared_receipt_generation(installed_file, metadata) == staged_generation
                            and not os.path.lexists(temp))
            except (OSError, RuntimeError, ValueError, TypeError, KeyError) as error:
                raise RuntimeError('Provenance sync outcome uncertain; inspect installed package') from error
            if not verified:
                raise RuntimeError('Provenance sync outcome uncertain; inspect installed package')
        except BaseException as error:
            if staged_generation is not None and prepared_receipt_generation(temp, metadata) == staged_generation:
                try:
                    temp.unlink()
                except OSError:
                    error.add_note('Prepared provenance cleanup failed; staging file retained')
            raise
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
