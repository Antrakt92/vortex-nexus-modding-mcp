import contextlib
import importlib.util
import io
import json
import lzma
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import zipfile
import zlib

HERE = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("nexus_publish", HERE / "publish.py")
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)
asset_spec = importlib.util.spec_from_file_location("release_assets", HERE / "release-assets.py")
assets = importlib.util.module_from_spec(asset_spec)
asset_spec.loader.exec_module(assets)
credential_spec = importlib.util.spec_from_file_location("windows_credential", HERE / "windows-credential.py")
credential = importlib.util.module_from_spec(credential_spec)
credential_spec.loader.exec_module(credential)


class RunnerTests(unittest.TestCase):
    def setUp(self):
        test_cache = Path(os.environ["NEXUS_TEST_STATE"]) if os.environ.get("NEXUS_TEST_STATE") else None
        if test_cache is not None:
            test_cache.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(prefix="nexus publication ", dir=test_cache)
        self.root = Path(self.temp.name)
        self.archive = self.root / "fixture.zip"
        with zipfile.ZipFile(self.archive, "w") as z:
            z.writestr("fixture.txt", "Synthetic publication test, not a mod package.")
        self.m = dict(game="examplegame", mod_page_id="12", mod_id="456", file_id="123", existing_file=True,
                      archive=str(self.archive), version="1.2.3", sha256=p.sha256(self.archive), expected_user_id="42")
        self.target = {"id": "123", "versions_count": 1}
        self.mod = {"id": "456", "game_scoped_id": "12", "game_id": "1"}
        self.files = {"mod_files": [{"id": "123"}]}
        self.version = dict(id="987", file={"id": "123"}, version="1.2.3", name="fixture.zip", category="main")

    def tearDown(self):
        self.temp.cleanup()

    def read(self, route, key):
        self.assertEqual(key, "mock-secret-never-log")
        if route == "/v1/users/validate.json": return {"user_id": 42}
        if route == "/v1/games/examplegame/mods/12.json":
            return {"mod_id": 12, "domain_name": "examplegame", "user": {"member_id": 42}}
        return {"/games/examplegame/mods/12": self.mod, "/mods/456/files": self.files,
                "/mod-files/123": self.target, "/mod-files/123/versions": {"versions": [{"version": "1.0.0"}]},
                "/mod-file-versions/987": self.version}[route]

    def execute(self, report):
        with patch.object(p, "verify_action", return_value=("node", b"synthetic action")):
            return p.execute(self.m, publish=True, state=self.root, credential=lambda: "mock-secret-never-log",
                             invoke=lambda *a: report, read=self.read)

    def test_dry_run_never_reads_key_or_invokes_action_network(self):
        with patch.object(p, "verify_action", side_effect=AssertionError), patch.object(p, "api_read", side_effect=AssertionError):
            result = p.execute(self.m, state=self.root, credential=lambda: self.fail("key read"),
                               invoke=lambda *a: self.fail("action run"))
        self.assertEqual(result["outcome"], "dry-run")
        self.assertFalse(result["uploaded"])
        self.assertFalse(result["target_relationship_verified"])
        self.assertFalse(p.receipt_path(self.m, self.root).exists())

    def test_malformed_or_large_manifest_stops_before_execution_with_safe_diagnostic(self):
        target = self.root / "manifest.json"
        cases = [(b"{", "must be valid UTF-8 JSON"),
                 (b"\xff", "must be valid UTF-8 JSON"),
                 (b'{"version":"1","version":"2"}', "unique field names"),
                 (b'{"version":NaN}', "must be valid UTF-8 JSON"),
                 (b'{"version":Infinity}', "must be valid UTF-8 JSON"),
                 (b'{"version":-Infinity}', "must be valid UTF-8 JSON"),
                 (b" " * (p.MANIFEST_LIMIT + 1), "exceeds 1 MiB")]
        for content, diagnostic in cases:
            target.write_bytes(content)
            stderr = io.StringIO()
            with (self.subTest(diagnostic=diagnostic), patch.object(sys, "argv", ["publish.py", str(target)]),
                  patch.object(p, "execute") as execute, contextlib.redirect_stderr(stderr)):
                self.assertEqual(p.main(), 2)
                self.assertIn(diagnostic, stderr.getvalue())
                self.assertNotIn("inspect the receipt", stderr.getvalue())
                execute.assert_not_called()

    def test_local_manifest_read_is_bounded(self):
        manifest = io.BytesIO(json.dumps(self.m).encode("utf-8"))
        target = self.root / "manifest.json"
        with patch.object(Path, "open", return_value=manifest), patch.object(
                manifest, "read", wraps=manifest.read) as read:
            self.assertEqual(p.load_manifest(target), self.m)
        read.assert_called_once_with(p.MANIFEST_LIMIT + 1)

    def test_invalid_manifest_variants(self):
        for change in [{"file_id": "0"}, {"mod_id": "../../other"}, {"existing_file": False},
                       {"archive": "fixture.zip"}, {"sha256": "0" * 64}, {"version": "1\n2"},
                       {"archive_existing_version": "false"}, {"category": "removed"},
                       {"api_key": "forbidden"}, {"NEXUSMODS_API_BASE": "https://invalid"}]:
            with self.subTest(change=change), self.assertRaises(p.Blocked):
                p.preflight({**self.m, **change})

    def test_not_zip(self):
        self.archive.write_bytes(b"not a zip")
        self.m["sha256"] = p.sha256(self.archive)
        with self.assertRaises(p.Blocked): p.preflight(self.m)

    def test_zip_requires_a_file_and_accepts_directory_entries(self):
        with zipfile.ZipFile(self.archive, "w") as z:
            z.writestr("folder/", "")
        self.m["sha256"] = p.sha256(self.archive)
        with self.assertRaisesRegex(p.Blocked, "contains no files"):
            p.preflight(self.m)
        with zipfile.ZipFile(self.archive, "a") as z:
            z.writestr("folder/fixture.txt", "Synthetic file")
        self.m["sha256"] = p.sha256(self.archive)
        with patch.object(zipfile.ZipFile, "open", autospec=True, side_effect=zipfile.ZipFile.open) as opened:
            self.assertEqual(p.preflight(self.m)["sha256"], self.m["sha256"])
        members = [call.args[1] for call in opened.call_args_list]
        self.assertTrue(all(isinstance(entry, zipfile.ZipInfo) for entry in members))
        self.assertEqual([entry.filename for entry in members], ["folder/", "folder/fixture.txt"])

    def test_zip_stream_errors_are_reported_before_credentials_or_action(self):
        for error in (zlib.error("fixture"), lzma.LZMAError("fixture"), OSError("fixture")):
            with self.subTest(error=type(error)), patch.object(zipfile.ZipExtFile, "read", side_effect=error), \
                    patch.object(p, "verify_action", side_effect=AssertionError("unexpected action verification")):
                with self.assertRaisesRegex(p.Blocked, "^ZIP integrity validation failed\\.$"):
                    p.execute(self.m, publish=True, state=self.root, credential=lambda: self.fail("key read"))

    def test_archive_read_errors_have_a_specific_message(self):
        with patch.object(p, "sha256", side_effect=PermissionError("fixture")):
            with self.assertRaisesRegex(p.Blocked, "^Archive could not be read\\.$"):
                p.preflight(self.m)

    def test_version_id_requires_reconciliation_before_reading_manifest(self):
        for mode in ([], ["--publish"]):
            with self.subTest(mode=mode):
                result = subprocess.run(
                    [sys.executable, "-B", str(HERE / "publish.py"),
                     str(self.root / "missing.json"), "--version-id", "987", *mode],
                    capture_output=True, text=True, timeout=10,
                )
                self.assertEqual(result.returncode, 2)
                self.assertIn("--version-id requires --reconcile", result.stderr)
                self.assertEqual(result.stdout, "")

    def test_correct_done_requires_independent_metadata_readback(self):
        result = self.execute({"ok": True, "version_id": "987"})
        self.assertEqual(result["outcome"], "done")
        self.assertTrue(result["uploaded"])
        self.assertTrue(result["metadata_verified"])
        self.assertFalse(result["artifact_verified"])
        text = p.receipt_path(self.m, self.root).read_text()
        self.assertNotIn("mock-secret", text)
        self.assertNotIn("https://", text)

    def test_readback_mismatch_is_unknown(self):
        self.version["version"] = "wrong"
        result = self.execute({"ok": True, "version_id": "987"})
        self.assertEqual(result["outcome"], "unknown")
        self.assertFalse(result["uploaded"])

    def test_failure_after_version_creation_is_unknown_reconcile_preserves_partial_action(self):
        result = self.execute({"ok": False, "version_id": "987"})
        self.assertEqual(result["outcome"], "unknown")
        result = p.reconcile(self.m, "mock-secret-never-log", state=self.root, read=self.read)
        self.assertEqual(result["outcome"], "done")
        self.assertFalse(result["action_complete"])

    def test_reconcile_refuses_to_replace_existing_version_id(self):
        result = self.execute({"ok": True, "version_id": "987"})
        self.assertEqual(result["outcome"], "done")
        path = p.receipt_path(self.m, self.root)
        previous = path.read_bytes()
        with self.assertRaisesRegex(p.Blocked, "version ID conflicts"):
            p.reconcile(self.m, state=self.root, version_id="988",
                        credential=lambda: self.fail("credential read for a different version ID"))
        self.assertEqual(path.read_bytes(), previous)

    def test_reconcile_uses_durable_lock_version_when_receipt_is_missing_it(self):
        self.execute({"ok": False, "version_id": "987"})
        path = p.receipt_path(self.m, self.root)
        p.write_receipt(path, {**p.load_receipt(path, self.m), "version_id": None})
        result = p.reconcile(self.m, state=self.root, key="mock-secret-never-log", read=self.read)
        self.assertEqual(result["outcome"], "done")
        self.assertEqual(result["version_id"], "987")
        self.assertFalse(p.target_lock_path(self.m, self.root).exists())

    def test_reconcile_recovers_interruption_between_terminal_receipt_and_target_marker(self):
        primary = p.receipt_path(self.m, self.root)
        marker = p.target_lock_path(self.m, self.root)
        real_update = p.update_owned

        def interrupt_marker_update(path, data, manifest):
            if path == marker and not data["action_running"]:
                raise OSError("fixture interruption after primary receipt write")
            real_update(path, data, manifest)

        with patch.object(p, "update_owned", side_effect=interrupt_marker_update):
            with self.assertRaisesRegex(OSError, "interruption after primary receipt"):
                self.execute({"ok": False, "version_id": "987"})
        returned = p.load_receipt(primary, self.m)
        initial = p.load_receipt(marker, self.m)
        self.assertEqual(returned["attempt_id"], initial["attempt_id"])
        self.assertEqual((returned["outcome"], returned["action_running"], returned["version_id"]),
                         ("unknown", False, "987"))
        self.assertEqual((initial["outcome"], initial["action_running"], initial["version_id"]),
                         ("attempt", True, None))

        for receipt_changes, marker_changes in (
            ({"action_running": True}, {}), ({"outcome": "attempt"}, {}), ({"version_id": None}, {}),
            ({}, {"attempt_id": "f" * 32}), ({}, {"time_utc": "2020-01-01T00:00:00+00:00"}),
            ({}, {"outcome": "unknown"}), ({}, {"action_complete": True}),
            ({}, {"version_id": "987"}), ({}, {"expected_user_id": "999"}),
        ):
            with self.subTest(receipt=receipt_changes, marker=marker_changes):
                p.write_receipt(primary, {**returned, **receipt_changes})
                p.write_receipt(marker, {**initial, **marker_changes})
                before = (primary.read_bytes(), marker.read_bytes())
                with self.assertRaises(p.Blocked):
                    p.reconcile(self.m, state=self.root, version_id="987",
                                credential=lambda: self.fail("credential read with ambiguous evidence"),
                                read=lambda *_: self.fail("GET with ambiguous evidence"))
                self.assertEqual((primary.read_bytes(), marker.read_bytes()), before)

        p.write_receipt(primary, returned)
        p.write_receipt(marker, initial)
        with patch.object(p, "update_owned", side_effect=interrupt_marker_update):
            with self.assertRaisesRegex(p.Blocked, "Receipt unavailable"):
                p.reconcile(self.m, state=self.root, key="mock-secret-never-log", read=self.read)
        self.assertEqual(p.load_receipt(primary, self.m)["outcome"], "done")
        self.assertEqual(p.load_receipt(marker, self.m), initial)

        with patch.object(self, "read", wraps=self.read) as get:
            result = p.reconcile(self.m, state=self.root, key="mock-secret-never-log", read=get)
        get.assert_any_call("/mod-file-versions/987", "mock-secret-never-log")
        self.assertEqual(result["outcome"], "done")
        self.assertEqual(result["attempt_id"], initial["attempt_id"])
        self.assertFalse(result["action_complete"])
        self.assertFalse(result["artifact_verified"])
        self.assertFalse(marker.exists())
        self.assertEqual(p.load_receipt(primary, self.m), result)

    def test_reconcile_refuses_conflicting_durable_versions_before_credentials(self):
        self.execute({"ok": False, "version_id": "987"})
        lock = p.target_lock_path(self.m, self.root)
        p.write_receipt(lock, {**p.load_receipt(lock, self.m), "version_id": "988"})
        previous = lock.read_bytes()
        with self.assertRaisesRegex(p.Blocked, "version ID conflicts"):
            p.reconcile(self.m, state=self.root,
                        credential=lambda: self.fail("credential read with conflicting ledger evidence"))
        self.assertEqual(lock.read_bytes(), previous)

    def test_attempt_survives_crash_and_hash_change_cannot_bypass(self):
        path = p.receipt_path(self.m, self.root)
        p.write_receipt(path, p.record(self.m, "attempt"), exclusive=True)
        with zipfile.ZipFile(self.archive, "a") as z: z.writestr("changed.txt", "changed")
        self.m["sha256"] = p.sha256(self.archive)
        with self.assertRaisesRegex(p.Blocked, "Blind retry"):
            self.execute({"ok": True, "version_id": "987"})

    def test_unknown_and_done_both_block_retries(self):
        self.execute({"ok": False, "version_id": None})
        with self.assertRaisesRegex(p.Blocked, "Blind retry"): self.execute({"ok": True, "version_id": "987"})
        with self.assertRaises(p.Blocked): p.reconcile(self.m, "mock-secret-never-log", state=self.root, read=self.read)

    def test_version_bump_cannot_bypass_uncertain_target_lock(self):
        self.execute({"ok": False, "version_id": None})
        self.m["version"] = "2.0.0"
        with self.assertRaisesRegex(p.Blocked, "unresolved"): self.execute({"ok": True, "version_id": "987"})

    def test_done_unlocks_target_for_new_versions_but_keeps_exact_attempt_receipt(self):
        self.execute({"ok": True, "version_id": "987"})
        self.assertFalse(p.target_lock_path(self.m, self.root).exists())
        with self.assertRaisesRegex(p.Blocked, "Blind retry"): self.execute({"ok": True, "version_id": "987"})
        self.m["version"] = "2.0.0"
        self.version["version"] = "2.0.0"
        self.assertEqual(self.execute({"ok": True, "version_id": "987"})["outcome"], "done")

    def test_readback_errors_are_sanitized_and_redirects_refused(self):
        with patch.object(p, "build_opener", side_effect=RuntimeError("mock-secret https://signed.invalid")):
            with self.assertRaises(p.Blocked) as error: p.api_read("/mod-files/123", "mock-secret")
        self.assertNotIn("mock-secret", str(error.exception))
        self.assertNotIn("https://", str(error.exception))
        with self.assertRaises(p.Blocked): p.NoRedirect().redirect_request(None, None, 302, "x", {}, "https://other")

    def test_wrong_target_and_duplicate_block_before_attempt(self):
        self.mod["id"] = "other"
        with self.assertRaises(p.Blocked): self.execute({"ok": True, "version_id": "987"})
        self.assertFalse(p.receipt_path(self.m, self.root).exists())
        self.mod["id"] = "456"
        def duplicate(route, key):
            return {"versions": [{"version": "1.2.3"}]} if route.endswith("/versions") else self.read(route, key)
        with self.assertRaises(p.Blocked):
            p.validate_target(self.m, "mock-secret-never-log", duplicate)

    def test_malformed_remote_version_listing_cannot_admit_upload(self):
        for legacy_version in (None, False, 123, {}):
            def read(route, key):
                if route.endswith("/versions"):
                    return {"versions": [{"version": "1.0.0"}, {"version": legacy_version}]}
                return self.read(route, key)

            with self.subTest(version=legacy_version), self.assertRaisesRegex(p.Blocked, "version-list schema"):
                p.validate_target(self.m, "mock-secret-never-log", read)

    def test_exclusive_attempt_receipt(self):
        path = p.receipt_path(self.m, self.root)
        p.write_receipt(path, p.record(self.m, "attempt"), exclusive=True)
        with self.assertRaises(FileExistsError): p.write_receipt(path, {}, exclusive=True)

    def test_environment_is_allowlisted(self):
        fixture = {"NODE_OPTIONS": "--import ignored", "NEXUSMODS_API_BASE": "https://example.invalid",
                   "GITHUB_OUTPUT": "private.txt", "ACTIONS_STEP_DEBUG": "true", "OTHER_SECRET": "private"}
        with patch.object(p, "os", SimpleNamespace(environ=fixture)):
            env = p.child_environment(self.m, "mock-secret-never-log")
        for k in ["NODE_OPTIONS", "NEXUSMODS_API_BASE", "GITHUB_OUTPUT", "ACTIONS_STEP_DEBUG", "OTHER_SECRET"]:
            self.assertNotIn(k, env)
        self.assertEqual(env["INPUT_ARCHIVE_EXISTING_VERSION"], "false")

    def test_release_assets_binds_archive_and_keeps_default_preflight_offline(self):
        env = {"RELEASE_TAG": "v1.2.3", "ARCHIVE_ASSET": "fixture.zip", "MANIFEST_ASSET": "publication.json",
               "GH_REPO": "example/mod", "RUNNER_TEMP": str(self.root)}
        def download(command, **kwargs):
            self.assertIn("--pattern", command)
            destination = Path(command[command.index("--dir") + 1])
            (destination / "fixture.zip").write_bytes(self.archive.read_bytes())
            manifest = json.dumps(self.m).encode("utf-8")
            manifest += b" " * (p.MANIFEST_LIMIT - len(manifest))
            (destination / "publication.json").write_bytes(manifest)
            return subprocess.CompletedProcess(command, 0, b"", b"")
        with (patch.object(assets, "os", SimpleNamespace(environ=env)),
              patch.object(assets.subprocess, "run", side_effect=download),
              patch.dict(sys.modules, {"publish": p})):
            self.assertEqual(assets.main(), 0)
        result = p.load_manifest(self.root / "nexus-publish-assets/manifest.json")
        self.assertEqual(result["archive"], str((self.root / "nexus-publish-assets/fixture.zip").resolve()))
        self.assertEqual(result["sha256"], self.m["sha256"])

    def test_release_assets_checks_normalized_manifest_before_writing_it(self):
        env = {"RELEASE_TAG": "v1.2.3", "ARCHIVE_ASSET": "fixture.zip", "MANIFEST_ASSET": "publication.json",
               "GH_REPO": "example/mod", "RUNNER_TEMP": str(self.root)}
        manifest = json.dumps({**self.m, "archive": ""}, separators=(",", ":")).encode("utf-8")

        def download(command, **kwargs):
            destination = Path(command[command.index("--dir") + 1])
            (destination / "fixture.zip").write_bytes(self.archive.read_bytes())
            (destination / "publication.json").write_bytes(manifest)
            return subprocess.CompletedProcess(command, 0, b"", b"")

        with (patch.object(assets, "os", SimpleNamespace(environ=env)),
              patch.object(assets.subprocess, "run", side_effect=download),
              patch.dict(sys.modules, {"publish": p}),
              patch.object(p, "MANIFEST_LIMIT", len(manifest)),
              contextlib.redirect_stderr(io.StringIO())):
            self.assertEqual(assets.main(), 2)
        destination = self.root / "nexus-publish-assets"
        self.assertFalse((destination / "manifest.json").exists())
        self.assertEqual((destination / "publication.json").read_bytes(), manifest)

    def test_release_assets_rejects_argument_injection_and_suppresses_gh_errors(self):
        env = {"RELEASE_TAG": "--delete", "ARCHIVE_ASSET": "fixture.zip", "MANIFEST_ASSET": "publication.json",
               "GH_REPO": "example/mod", "RUNNER_TEMP": str(self.root)}
        stderr = io.StringIO()
        with (patch.object(assets, "os", SimpleNamespace(environ=env)),
              patch.object(assets.subprocess, "run") as call,
              contextlib.redirect_stderr(stderr)):
            self.assertEqual(assets.main(), 2)
            call.assert_not_called()
        env["RELEASE_TAG"] = "v1.2.3"
        with (patch.object(assets, "os", SimpleNamespace(environ=env)),
              contextlib.redirect_stderr(stderr),
              patch.object(assets.subprocess, "run", return_value=subprocess.CompletedProcess(
                  [], 1, b"mock-secret", b"https://private.invalid"))):
            self.assertEqual(assets.main(), 2)
        self.assertNotIn("mock-secret", stderr.getvalue())
        self.assertNotIn("https://", stderr.getvalue())

    def test_windows_archive_lock_blocks_mutation_but_allows_action_read(self):
        with p.frozen_archive(self.archive):
            self.assertEqual(p.sha256(self.archive), self.m["sha256"])
            with self.assertRaises(PermissionError): self.archive.write_bytes(b"changed")
            with self.assertRaises(PermissionError): self.archive.unlink()
        self.archive.write_bytes(b"released")

    def test_execute_consumes_captured_action_when_source_checkout_changes(self):
        action = self.root / "approved-action"
        script = action / "dist/index.js"
        script.parent.mkdir(parents=True)
        approved = b"// Synthetic pinned action bytes, never executed\r\n"
        changed = b"// New checkout bytes, never executed\n"
        script.write_bytes(approved)
        pin = p.bundle_sha256(approved)
        invoked = []

        def tool_probe(command, **_options):
            version = {"HEAD": p.PIN, "--version": "v24.20.0", "process.versions.undici": "7.24.0"}
            return SimpleNamespace(stdout=version[command[-1]])

        def read(route, key):
            value = self.read(route, key)
            if route == "/mod-files/123/versions":
                script.write_bytes(changed)
            return value

        def inspect_invocation(manifest, _key, staged_action, _node):
            invoked.append(staged_action)
            self.assertEqual(manifest["archive"], str(self.archive))
            entry = staged_action / "dist/index.js"
            metadata = staged_action / "package.json"
            self.assertEqual(entry.read_bytes(), approved)
            self.assertEqual(json.loads(metadata.read_text())["type"], "module")
            if os.name == "nt":
                for path in (entry, metadata):
                    with self.assertRaises(PermissionError):
                        path.open("r+b").close()
            return {"ok": True, "version_id": "987"}

        with (patch.object(p, "BUNDLE_SHA256", pin),
              patch.object(p.shutil, "which", return_value="node"),
              patch.object(p.subprocess, "run", side_effect=tool_probe)):
            result = p.execute(self.m, publish=True, state=self.root, action=action,
                               credential=lambda: "mock-secret-never-log", invoke=inspect_invocation, read=read)
        self.assertEqual(result["outcome"], "done")
        self.assertEqual(len(invoked), 1)
        self.assertNotEqual(invoked[0], action)
        self.assertFalse(invoked[0].exists())
        self.assertEqual(script.read_bytes(), changed)

    def test_staged_action_cleanup_failure_does_not_replace_publication_outcome(self):
        cleanup = p.tempfile.TemporaryDirectory.cleanup
        retained = []

        def cleanup_retained():
            for directory in retained:
                cleanup(directory)

        self.addCleanup(cleanup_retained)

        def late_cleanup_failure(directory):
            if Path(directory.name).name.startswith("nexus-reviewed-action-"):
                retained.append(directory)
                raise PermissionError("private diagnostic output")
            return cleanup(directory)

        mkdir = Path.mkdir

        def stage_acquisition_failure(path, *args, **kwargs):
            if path.name == "dist" and path.parent.name.startswith("nexus-reviewed-action-"):
                raise OSError("Primary staging failure")
            return mkdir(path, *args, **kwargs)

        with (patch.object(p.tempfile.TemporaryDirectory, "cleanup", late_cleanup_failure),
              contextlib.redirect_stderr(io.StringIO()) as warning):
            result = self.execute({"ok": True, "version_id": "987"})
            with (patch.object(Path, "mkdir", stage_acquisition_failure),
                  self.assertRaisesRegex(OSError, "Primary staging failure")):
                with p.stage_action(b"synthetic action"):
                    self.fail("staging acquired")

        self.assertEqual(result["outcome"], "done")
        self.assertEqual(p.load_receipt(p.receipt_path(self.m, self.root), self.m), result)
        self.assertFalse(p.target_lock_path(self.m, self.root).exists())
        self.assertEqual(len(retained), 2)
        self.assertEqual(warning.getvalue().count("staging cleanup incomplete"), 2)
        self.assertNotIn("private diagnostic output", warning.getvalue())

    def test_verification_probes_get_only_runtime_environment_and_finite_timeout(self):
        action = self.root / "verified-tool-probe"
        script = action / "dist/index.js"
        script.parent.mkdir(parents=True)
        bundle = b"// Synthetic verification input, never executed\r\n"
        script.write_bytes(bundle)
        probes = []

        def tool_probe(argv, **options):
            probes.append((argv, options))
            outputs = {"HEAD": p.PIN, "--version": "v24.20.0", "process.versions.undici": "7.24.0"}
            return SimpleNamespace(stdout=outputs[argv[-1]])

        inherited = {"PATH": r"C:\Code\node", "SystemRoot": r"C:\Windows",
                     "NEXUS_PUBLISH_KEY": "synthetic-credential-placeholder", "NODE_OPTIONS": "--no-warnings",
                     "GIT_DIR": "synthetic-git-directory", "UNRELATED_OPTION": "not-required"}
        with (patch.dict(os.environ, inherited, clear=True),
              patch.object(p, "BUNDLE_SHA256", p.bundle_sha256(bundle)),
              patch.object(p.shutil, "which", return_value="trusted-node"),
              patch.object(p.subprocess, "run", side_effect=tool_probe)):
            self.assertEqual(p.verify_action(action), ("trusted-node", bundle))

        self.assertEqual([argv[-1] for argv, _ in probes], ["HEAD", "--version", "process.versions.undici"])
        for _, options in probes:
            self.assertIn("env", options)
            environment = {key.upper(): value for key, value in options["env"].items()}
            self.assertEqual(environment, {"PATH": inherited["PATH"], "SYSTEMROOT": inherited["SystemRoot"]})
            self.assertGreater(options["timeout"], 0)
            self.assertLessEqual(options["timeout"], 30)
            self.assertTrue(options["capture_output"] and options["check"] and options["text"])

    def test_verification_timeout_preserves_typed_refusal(self):
        for probe in range(3):
            with self.subTest(probe=probe):
                approved = [SimpleNamespace(stdout=p.PIN), SimpleNamespace(stdout="v24.20.0")]
                responses = [*approved[:probe], subprocess.TimeoutExpired("synthetic probe", timeout=15)]
                with (patch.object(p.shutil, "which", return_value="trusted-node"),
                      patch.object(p.subprocess, "run", side_effect=responses) as command):
                    with self.assertRaisesRegex(p.Blocked, "Pinned action checkout and Node 24 are required"):
                        p.verify_action(self.root)
                    self.assertEqual(command.call_count, probe + 1)

    def test_bundle_pin_accepts_only_git_eol_conversion_and_rejects_tampering(self):
        original = p.DEFAULT_ACTION / "dist/index.js"
        copied = self.root / "bundle.js"
        content = original.read_bytes().replace(b"\r\n", b"\n")
        copied.write_bytes(content.replace(b"\n", b"\r\n"))
        self.assertEqual(p.bundle_sha256(copied.read_bytes()), p.BUNDLE_SHA256)
        copied.write_bytes(content + b"//tampered")
        self.assertNotEqual(p.bundle_sha256(copied.read_bytes()), p.BUNDLE_SHA256)
        with patch.object(p, "bundle_sha256", return_value="0" * 64):
            with self.assertRaisesRegex(p.Blocked, "pin or bundle hash"): p.verify_action(p.DEFAULT_ACTION)

    def test_official_bundle_end_to_end_mock_network(self):
        node, bundle = p.verify_action(p.DEFAULT_ACTION)
        for case, expected in [("success", True), ("upload-failure", False), ("changelog-failure", False)]:
            with self.subTest(case=case):
                manifest = {**self.m, "changelog": "Modeled changelog"}
                env = p.child_environment(manifest, "mock-secret-never-log")
                env["MOCK_CASE"] = case
                with p.stage_action(bundle) as staged:
                    result = subprocess.run([node, "--import", (HERE / "tests/mock-network.mjs").as_uri(),
                                             str(HERE / "safe-action.mjs"), str(staged / "dist/index.js")],
                                            env=env, capture_output=True, timeout=30)
                combined = result.stdout + result.stderr
                self.assertNotIn(b"mock-secret", combined)
                self.assertNotIn(b"signature", combined)
                self.assertNotIn(b"https://", combined)
                self.assertEqual(result.stderr, b"")
                report = json.loads(result.stdout)
                self.assertEqual(report["ok"], expected)
                self.assertEqual(report["version_id"], None if case == "upload-failure" else "987")
                self.assertEqual(result.returncode, 0 if expected else 1)

    def mocked_bundle(self, manifest, case="success", **options):
        env = p.child_environment(manifest, "mock-secret-never-log")
        env.update(MOCK_CASE=case, **options)
        node, bundle = p.verify_action(p.DEFAULT_ACTION)
        with p.stage_action(bundle) as staged:
            result = subprocess.run([node, "--import", (HERE / "tests/mock-network.mjs").as_uri(),
                                     str(HERE / "safe-action.mjs"), str(staged / "dist/index.js")],
                                    env=env, capture_output=True, timeout=30)
        self.assertEqual(result.stderr, b"")
        for forbidden in [b"mock-secret", b"signature", b"https://"]:
            self.assertNotIn(forbidden, result.stdout + result.stderr)
        return result, json.loads(result.stdout)

    def test_bundle_redirect_302_307_never_forwards_api_key(self):
        for code in (302, 307):
            with self.subTest(code=code):
                result, report = self.mocked_bundle(self.m, f"redirect-{code}")
                self.assertEqual(result.returncode, 1)  # 73 means fake native fetch forwarded the key.
                self.assertFalse(report["ok"])
                self.assertIsNone(report["version_id"])

    def test_bundle_storage_denies_unsafe_destinations_before_any_storage_request(self):
        for url in ["http://fixture.s3.eu-west-1.amazonaws.com/part", "https://localhost/part",
                    "https://127.0.0.1/part", "https://[::1]/part", "https://10.0.0.1/part",
                    "https://attacker.invalid/part", "https://fixture.s3.eu-west-1.amazonaws.com.evil.invalid/part",
                    "https://fixture.s3.eu-west-1.amazonaws.com:444/part", "https://user:pass@fixture.s3.eu-west-1.amazonaws.com/part"]:
            with self.subTest(url=url):
                result, report = self.mocked_bundle(self.m, "storage-denied", MOCK_STORAGE_URL=url)
                self.assertEqual(result.returncode, 1)  # 73 means unsafe storage reached the transport.
                self.assertFalse(report["ok"])
                self.assertIsNone(report["version_id"])

    def test_real_bundle_empty_display_name_readback_uses_filename_fallback(self):
        self.m["display_name"] = ""
        result, report = self.mocked_bundle(self.m, MOCK_EXPECTED_NAME="fixture.zip")
        self.assertEqual(result.returncode, 0)
        receipt = self.execute(report)
        self.assertEqual(receipt["outcome"], "done")
        self.assertEqual(receipt["effective_display_name"], "fixture.zip")

    def test_padded_action_options_are_rejected_before_action_or_key_access(self):
        options = ["display_name", "description", "category", "changelog", "version", "mod_id", "file_id"]
        for field in options:
            for padding in [" ", "\t", "\n", "\u00a0", "\ufeff", "\u2028", "\u3000"]:
                with self.subTest(field=field, padding=repr(padding)):
                    manifest = {**self.m, field: padding + (self.m.get(field) or "name") + padding}
                    with self.assertRaises(p.Blocked):
                        p.execute(manifest, state=self.root, credential=lambda: self.fail("credential accessed"),
                                  invoke=lambda *a: self.fail("action invoked"))
        with self.assertRaises(p.Blocked): p.preflight({**self.m, "display_name": "   "})

    def test_real_bundle_effective_name_defaults_and_all_optional_metadata_semantics(self):
        for name in ["A named version", "Named _'().- version", ""]:
            with self.subTest(name=repr(name)):
                manifest = {**self.m, "display_name": name, "category": "", "description": "", "changelog": "",
                            "primary_mod_manager_download": False, "allow_mod_manager_download": True,
                            "show_requirements_pop_up": False, "archive_existing_version": False, "update_mod_version": False}
                manifest = p.preflight(manifest)
                expected_name = name or "fixture.zip"
                expected = {"name": expected_name, "file_category": "main", "primary_mod_manager_download": False,
                            "allow_mod_manager_download": True, "show_requirements_pop_up": False,
                            "archive_existing_file": False, "update_mod_version": False}
                result, report = self.mocked_bundle(manifest, MOCK_EXPECTED_NAME=expected_name, MOCK_METADATA=json.dumps(expected))
                self.assertEqual(result.returncode, 0)
                self.assertTrue(report["ok"])
                self.version["name"] = expected_name
                self.assertTrue(p.readback(manifest, "987", "mock-secret-never-log", self.read))
                self.assertEqual(p.record(manifest, "dry-run")["effective_display_name"], expected_name)
                self.assertEqual(p.record(manifest, "dry-run")["effective_category"], "main")

    def test_reconcile_cannot_change_effective_display_name_in_existing_receipt(self):
        self.execute({"ok": False, "version_id": "987"})
        self.m["display_name"] = "Changed later"
        self.version["name"] = "Changed later"
        with self.assertRaisesRegex(p.Blocked, "effective metadata"):
            p.reconcile(self.m, "mock-secret-never-log", state=self.root, read=self.read)

    def fake_credential_api(self, blob, reported_size=None, success=True):
        import ctypes
        from types import SimpleNamespace
        allocation = ctypes.create_string_buffer(blob)
        item = credential.Credential()
        item.Type = 1
        item.CredentialBlob = ctypes.addressof(allocation)
        item.CredentialBlobSize = len(blob) if reported_size is None else reported_size
        reads, frees = [], []
        class Call:
            def __init__(self, function): self.function = function
            def __call__(self, *args): return self.function(*args)
        def read(target, kind, flags, out):
            reads.append((target, kind, flags))
            if success:
                ctypes.cast(out, ctypes.POINTER(ctypes.POINTER(credential.Credential)))[0] = ctypes.pointer(item)
            return success
        api = SimpleNamespace(CredReadW=Call(read), CredFree=Call(lambda pointer: frees.append(bool(pointer))))
        return api, reads, frees, (allocation, item)

    def test_shared_credential_reads_only_verified_target_counted_utf16_and_frees(self):
        api, reads, frees, keepalive = self.fake_credential_api("synthetic-credential".encode("utf-16-le"))
        self.assertEqual(credential.load(api), "synthetic-credential")
        self.assertEqual(reads, [("skill-nexus", 1, 0)])
        self.assertEqual(frees, [True])

    def test_shared_credential_missing_malformed_and_empty_remain_safe_and_free(self):
        for blob, size, success in [(b"", 0, True), (b"aa", 1, True), (b"aa", 2562, True),
                                    (b"\x00\xd8", 2, True), (b"\x00\x00", 2, True), (b"", 0, False)]:
            with self.subTest(size=size, success=success):
                api, reads, frees, keepalive = self.fake_credential_api(blob, size, success)
                with self.assertRaises(credential.CredentialUnavailable): credential.load(api)
                self.assertEqual(reads, [("skill-nexus", 1, 0)])
                self.assertEqual(frees, [True] if success else [])

    def test_dry_run_windows_cli_mode_does_not_read_real_credentials(self):
        with patch.object(p, "shared_windows_credential", side_effect=AssertionError("must not access")):
            self.assertEqual(p.execute(self.m, state=self.root, credential=p.shared_windows_credential)["outcome"], "dry-run")


if __name__ == "__main__":
    unittest.main()
