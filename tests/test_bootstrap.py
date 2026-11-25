import base64
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import sys
import tarfile
import tempfile
import unittest
from unittest import mock

scripts = Path(__file__).resolve().parents[1] / 'scripts'
sys.path.insert(0, str(scripts))
spec = importlib.util.spec_from_file_location('bootstrap', scripts / 'bootstrap_pnpm.py')
b = importlib.util.module_from_spec(spec)
spec.loader.exec_module(b)


def fixture(name='package/bin/tool.cjs', link=False, extra_names=()):
    stream = io.BytesIO()
    with tarfile.open(fileobj=stream, mode='w:gz') as archive:
        member = tarfile.TarInfo(name)
        data = b'example'
        if link:
            member.type = tarfile.SYMTYPE
            member.linkname = '/outside'
            archive.addfile(member)
        else:
            member.size = len(data)
            archive.addfile(member, io.BytesIO(data))
        for extra in extra_names:
            member = tarfile.TarInfo(extra)
            member.size = len(data)
            archive.addfile(member, io.BytesIO(data))
    value = stream.getvalue()
    lock = {'archiveBytes': len(value),
            'integrity': 'sha512-' + base64.b64encode(hashlib.sha512(value).digest()).decode(),
            'fileCount': 1 + len(extra_names), 'unpackedBytes': len(data) * (1 + len(extra_names))}
    return value, lock


def fixture_workspace(root):
    vendor = root / 'dependencies/vortex-mcp'
    vendor.mkdir(parents=True)
    data, pins = fixture()
    version = '10.34.9'
    lock = {**pins, 'package': 'pnpm', 'version': version,
            'registryMetadata': f'https://registry.npmjs.org/pnpm/{version}',
            'tarball': f'https://registry.npmjs.org/pnpm/-/pnpm-{version}.tgz',
            'retainedUnderIgnored': f'.tooling/pnpm-{version}'}
    (vendor / 'package.json').write_text(json.dumps({'packageManager': f'pnpm@{version}'}))
    (vendor / 'PNPM-BOOTSTRAP.json').write_text(json.dumps(lock))
    return vendor, data, lock


class BootstrapTests(unittest.TestCase):
    def test_plan_rejects_inconsistent_source_and_destination_without_network(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            vendor = root / 'dependencies/vortex-mcp'; vendor.mkdir(parents=True)
            version = '10.34.9'
            _, pins = fixture()
            lock = {**pins, 'package': 'pnpm', 'version': version,
                    'registryMetadata': f'https://registry.npmjs.org/pnpm/{version}',
                    'tarball': f'https://registry.npmjs.org/pnpm/-/pnpm-{version}.tgz',
                    'retainedUnderIgnored': f'.tooling/pnpm-{version}'}
            (vendor / 'package.json').write_text(json.dumps({'packageManager': f'pnpm@{version}'}))
            lock_file = vendor / 'PNPM-BOOTSTRAP.json'
            for patch in [{'tarball': 'https://example.com/tool.tgz'},
                          {'registryMetadata': 'https://example.com/metadata'},
                          {'retainedUnderIgnored': 'src'}, {'version': '../outside'},
                          {'package': 'other'}, {'version': '9.15.0'}]:
                lock_file.write_text(json.dumps({**lock, **patch}))
                with self.subTest(patch=patch), mock.patch.object(b, 'ROOT', root), \
                        mock.patch.object(b.urllib.request, 'urlopen') as network:
                    with self.assertRaisesRegex(ValueError, 'build-tool'):
                        b.bootstrap()
                    network.assert_not_called()
            lock_file.write_text(json.dumps(lock))
            with mock.patch.object(b, 'ROOT', root), mock.patch.object(b.urllib.request, 'urlopen') as network:
                self.assertEqual(b.bootstrap()['mode'], 'plan')
                network.assert_not_called()
            self.assertFalse((vendor / '.tooling').exists())

    def test_retained_build_tool_path_cannot_escape_vendor_root(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            vendor = root / 'dependencies/vortex-mcp'; vendor.mkdir(parents=True)
            for value in ['../../../outside', str(root / 'outside')]:
                (vendor / 'PNPM-BOOTSTRAP.json').write_text(json.dumps({'retainedUnderIgnored': value}))
                with mock.patch.object(b, 'ROOT', root):
                    with self.assertRaisesRegex(ValueError, 'recovery path'):
                        b.bootstrap()
            self.assertFalse((root / 'outside').exists())

    def test_supplied_archive_is_read_only_to_the_pinned_size_plus_one(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            vendor, data, lock = fixture_workspace(root)
            archive = root / 'supplied.tgz'
            oversized = data + b'oversized'
            archive.write_bytes(oversized)
            original_open = Path.open
            read_sizes = []

            class ObservedArchive(io.BytesIO):
                def read(self, size=-1):
                    read_sizes.append(size)
                    return super().read(size)

            def tracked_open(path, *args, **kwargs):
                if path == archive:
                    return ObservedArchive(oversized)
                return original_open(path, *args, **kwargs)

            with mock.patch.object(b, 'ROOT', root), mock.patch.object(Path, 'open', tracked_open), \
                    mock.patch.object(b.urllib.request, 'urlopen') as network:
                with self.assertRaisesRegex(ValueError, 'archive size differs'):
                    b.bootstrap(apply=True, archive_path=archive)
                network.assert_not_called()
            self.assertEqual(read_sizes, [lock['archiveBytes'] + 1])
            self.assertFalse((vendor / '.tooling').exists())

            archive.write_bytes(data)
            with mock.patch.object(b, 'ROOT', root), mock.patch.object(b.urllib.request, 'urlopen') as network:
                self.assertEqual(b.bootstrap(apply=True, archive_path=archive)['state'], 'unpacked')
                network.assert_not_called()
            self.assertEqual((vendor / lock['retainedUnderIgnored'] / 'bin/tool.cjs').read_bytes(), b'example')

    def test_plan_validates_explicit_archive_without_touching_the_output_or_network(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            vendor, data, lock = fixture_workspace(root)
            archive = root / 'supplied.tgz'
            with mock.patch.object(b, 'ROOT', root), mock.patch.object(b.urllib.request, 'urlopen') as network:
                with self.assertRaisesRegex(ValueError, 'ordinary file'):
                    b.bootstrap(archive_path=archive)
                with self.assertRaisesRegex(ValueError, 'ordinary file'):
                    b.bootstrap(archive_path=root)
                archive.write_bytes(data[:-1] + bytes([data[-1] ^ 1]))
                with self.assertRaisesRegex(ValueError, 'archive integrity differs'):
                    b.bootstrap(archive_path=archive)
                archive.write_bytes(data)
                planned = b.bootstrap(archive_path=archive)
                self.assertEqual(planned, {'mode': 'plan', 'target': str(vendor / lock['retainedUnderIgnored']),
                                           'network_accessed': False, 'archive_verified': True, 'files': 1})
                self.assertNotIn('archive_verified', b.bootstrap())
                network.assert_not_called()
            self.assertFalse((vendor / '.tooling').exists())

    def test_bad_archive_pins_refuse_before_network_and_output_in_both_modes(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            vendor, _, lock = fixture_workspace(root)
            for field, value in [('archiveBytes', True), ('archiveBytes', 0), ('archiveBytes', 2**60),
                                 ('fileCount', 0), ('fileCount', 2**60), ('unpackedBytes', -1),
                                 ('unpackedBytes', 2**60), ('integrity', 'sha512-invalid')]:
                with self.subTest(field=field, value=value):
                    (vendor / 'PNPM-BOOTSTRAP.json').write_text(json.dumps({**lock, field: value}))
                    with mock.patch.object(b, 'ROOT', root), mock.patch.object(b.urllib.request, 'urlopen') as network:
                        for apply in (False, True):
                            with self.assertRaisesRegex(ValueError, 'Invalid pinned build-tool'):
                                b.bootstrap(apply=apply)
                        network.assert_not_called()
                    self.assertFalse((vendor / '.tooling').exists())

    def test_interrupted_unpack_can_retry_with_same_verified_archive(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            vendor, data, lock = fixture_workspace(root)
            archive = root / 'supplied.tgz'
            archive.write_bytes(data)
            target = vendor / lock['retainedUnderIgnored']
            previous = target.parent / 'pnpm-verified-previous'
            previous.mkdir(parents=True)
            (previous / 'proof').write_bytes(b'preserve')
            write = Path.write_bytes

            def interrupted(path, value):
                if path.name == 'tool.cjs':
                    raise OSError('synthetic unpack interruption')
                return write(path, value)

            with mock.patch.object(b, 'ROOT', root), mock.patch.object(b.urllib.request, 'urlopen') as network:
                with mock.patch.object(Path, 'write_bytes', interrupted):
                    with self.assertRaisesRegex(OSError, 'synthetic unpack interruption'):
                        b.bootstrap(apply=True, archive_path=archive)
                self.assertFalse(target.exists())
                self.assertEqual(list(target.parent.iterdir()), [previous])
                self.assertEqual(b.bootstrap(apply=True, archive_path=archive)['state'], 'unpacked')
                self.assertEqual(b.bootstrap(apply=True, archive_path=archive)['state'], 'already_verified')
                self.assertEqual((target / 'bin/tool.cjs').read_bytes(), b'example')
                self.assertEqual((previous / 'proof').read_bytes(), b'preserve')
                network.assert_not_called()

    def test_pinned_content(self):
        data, lock = fixture()
        self.assertEqual(b.entries(data, lock), {'bin/tool.cjs': b'example'})

    def test_reject_corruption(self):
        data, lock = fixture()
        with self.assertRaises(ValueError):
            b.entries(data[:-1] + bytes([data[-1] ^ 1]), lock)

    def test_reject_paths_and_links_even_with_matching_hash(self):
        for name, link in [('package/../outside', False), ('package/bin/link', True), ('/absolute', False)]:
            data, lock = fixture(name, link)
            with self.assertRaises(ValueError):
                b.entries(data, lock)

    def test_reject_windows_path_aliases_before_unpacking(self):
        for name, extra in [('package/bin/CON.txt', ()), ('package/bin/tool. ', ()),
                            ('package/bin/tool', ('package/BIN/TOOL',)),
                            ('package/bin/tool', ('package/BIN/TOOL/nested.cjs',)),
                            ('package/bin/tool', ('package/BIN/other.cjs',))]:
            with self.subTest(name=name, extra=extra):
                data, lock = fixture(name, extra_names=extra)
                with self.assertRaisesRegex(ValueError, 'archive path'):
                    b.entries(data, lock)

    def test_inventory_limits_are_checked_before_extracting_oversized_member(self):
        data, lock = fixture()
        with mock.patch.object(tarfile.TarFile, 'extractfile', side_effect=AssertionError('must not extract')):
            with self.assertRaisesRegex(ValueError, 'content inventory'):
                b.entries(data, {**lock, 'unpackedBytes': lock['unpackedBytes'] - 1})


if __name__ == '__main__':
    unittest.main()
