"""Actual Transport/Worker methods; all custody/process/pipe I/O are explicit models."""
import hashlib
import importlib.util
import json
import ntpath
from pathlib import Path
import queue
import re
import types
import unittest
from unittest.mock import patch

HERE = Path(__file__).absolute().parent
spec = importlib.util.spec_from_file_location('observing_zip_worker', HERE/'owned-zip-worker.py')
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class ArchiveObservationWireTests(unittest.TestCase):
    def setUp(self):
        self.events, self.exits = [], []
        self.observe_error = self.guard_error = self.release_error = None
        self.retained = False
        self.on_observe = self.on_guard_close = None
        self.result_override = None
        self.binding = {'operationId': 'op_'+'1'*32, 'nativeJobId': 'exec_'+'2'*32,
                        'requestSHA256': '3'*64, 'rendererGeneration': 'renderer_'+'4'*32}
        self.request = {'schema': 'owned-zip-observe-archive/1', 'workerLifetime': 'worker_'+'5'*32,
                        'binding': self.binding, 'archive': {'parent': 'C:/Downloads', 'leaf': 'own.zip',
                        'bytes': 3, 'sha256': 'a'*64, 'md5': 'b'*32}}
        self.archive = {'parent': 'C:\\Downloads', 'parentIdentity': {'schema': 'win-file-id128/1',
                        'volumeSerialNumber': '123', 'fileId': '456'}, 'leaf': 'own.zip',
                        'identity': {'schema': 'win-file-id128/1', 'volumeSerialNumber': '123',
                                     'fileId': '18446744073709551620'}, 'bytes': 3, 'sha256': 'a'*64}
        test = self

        class Observer:
            def __init__(self, *args):
                test.events.append(('construct', args))
                self.closed = False
                test.observer = self

            def observe(self):
                test.events.append(('observe',))
                test.assertIs(test.executor.observation_owner, self)
                if test.on_observe:
                    test.on_observe()
                self.closed = not test.retained
                if test.observe_error is not None:
                    raise test.observe_error
                return test.result_override if test.result_override is not None else test.archive

            def status(self):
                return {'closed': self.closed, 'retainedHandles': 0 if self.closed else 1}

            def close(self):
                test.events.append(('observer-close',))
                if test.release_error is not None:
                    raise test.release_error
                self.closed = True

        class Guard:
            def __init__(self):
                self.closed = False

            def close(self):
                test.events.append(('guard-close',))
                if test.on_guard_close:
                    test.on_guard_close()
                if test.guard_error is not None:
                    raise test.guard_error
                self.closed = True

            def status(self):
                return {'closed': self.closed, 'retainedHandles': 0 if self.closed else 1}

        self.base = types.SimpleNamespace(OwnedArchiveObservation=Observer, _root=self.root,
                                         _component=self.component, _identity=self.identity,
                                         _relative=lambda value: value.split('/'))
        self.transport = worker.Transport(self.request['workerLifetime'], self.base)
        self.transport.final_written.set()  # Modeled complete final stdout delivery.
        self.guard = Guard()
        self.executor = worker.Worker(self.base, self.guard, self.transport)
        self.exit_patch = patch.object(worker.os, '_exit', side_effect=self.exits.append)
        self.exit_patch.start()
        self.addCleanup(self.exit_patch.stop)

    @staticmethod
    def root(value):
        worker.need(type(value) is str and re.fullmatch(r'[A-Za-z]:[\\/].{1,500}', value), 'INVALID_ROOT')
        return ntpath.normpath(value).lower()

    @staticmethod
    def component(value):
        worker.need(type(value) is str and 0 < len(value) <= 255 and not re.search(r'[\\/]', value), 'INVALID_COMPONENT')
        return value

    @staticmethod
    def identity(value):
        worker.need(worker.exact(value, ('schema', 'volumeSerialNumber', 'fileId'))
                    and value['schema'] == 'win-file-id128/1', 'INVALID_IDENTITY')

    def encode(self, value):
        return json.dumps(value, separators=(',', ':')).encode('utf-8')

    def submit(self):
        self.raw = self.encode(self.request)
        self.transport.accept(self.raw)

    def response(self):
        return json.loads(self.transport.slot[0])

    def control(self, command='release', **changes):
        value = {'schema': 'owned-zip-worker-control/1', 'workerLifetime': self.request['workerLifetime'],
                 'binding': dict(self.binding), 'command': command}
        value.update(changes)
        return self.encode(value)

    def test_exact_request_hash_and_success_after_both_closed(self):
        self.submit()
        self.assertTrue(self.transport.observe_seen)
        self.assertEqual(self.events, [])
        self.executor.observation_step()
        response = self.response()
        self.assertEqual(list(response), ['schema', 'workerLifetime', 'binding', 'packetSHA256', 'phase',
                                          'archive', 'errorCode', 'effectsAllowed', 'nativeInstallAccepted',
                                          'persistenceVerified'])
        self.assertEqual(response['schema'], 'owned-archive-observation/1')
        self.assertEqual(response['packetSHA256'], hashlib.sha256(self.raw).hexdigest())
        self.assertEqual(response['archive'], self.archive)
        self.assertEqual(response['binding'], self.binding)
        self.assertIsNone(response['errorCode'])
        self.assertEqual(response['phase'], 'observed')
        self.assertEqual(self.exits, [0])
        self.assertTrue(self.observer.closed and self.guard.closed)
        self.assertIsNone(self.executor.work_root)
        self.assertIsNone(self.executor.owner)
        self.assertIsNone(self.executor.prepared_destination)
        self.assertFalse(any(response[key] for key in ('effectsAllowed', 'nativeInstallAccepted', 'persistenceVerified')))

    def test_invalid_metadata_spends_mode_without_constructor(self):
        for change in ({'bytes': 0}, {'bytes': True}, {'bytes': 64*1024*1024+1}, {'md5': 'A'*32},
                       {'sha256': '0'*63}, {'extra': 1}):
            with self.subTest(change=change):
                transport = worker.Transport(self.request['workerLifetime'], self.base)
                value = {**self.request, 'archive': {**self.request['archive'], **change}}
                with self.assertRaises(RuntimeError):
                    transport.accept(self.encode(value))
                self.assertTrue(transport.observe_seen)
                self.assertTrue(transport.start_seen)
                self.assertIsNotNone(transport.fault)
                self.assertTrue(transport.commands.empty())
        self.assertEqual(self.events, [])

    def test_destination_or_start_disqualifies_virgin_mode(self):
        for attribute in ('prepare_seen', 'start_seen'):
            transport = worker.Transport(self.request['workerLifetime'], self.base)
            setattr(transport, attribute, True)
            with self.assertRaisesRegex(RuntimeError, 'OBSERVATION_NOT_VIRGIN'):
                transport.accept(self.encode(self.request))
            self.assertTrue(transport.commands.empty())

    def test_wrong_lifetime_binding_and_extra_top_field_are_refused(self):
        for value in ({**self.request, 'workerLifetime': 'other'},
                      {**self.request, 'binding': {**self.binding, 'operationId': 'wrong'}},
                      {**self.request, 'extra': True}):
            transport = worker.Transport(self.request['workerLifetime'], self.base)
            with self.assertRaises(RuntimeError):
                transport.accept(self.encode(value))
            self.assertTrue(transport.commands.empty())

    def test_request_replay_before_work_faults_and_never_opens(self):
        self.submit()
        with self.assertRaises(RuntimeError):
            self.transport.accept(self.raw)
        self.executor.observation_step()
        self.assertFalse(any(event[0] == 'construct' for event in self.events))
        self.assertEqual(self.response()['phase'], 'failed')
        self.assertIsNone(self.response()['archive'])
        self.assertEqual(self.exits, [65])

    def test_observer_known_closed_error_preserves_primary_and_exits65(self):
        self.submit()
        primary = RuntimeError('OWNED_TRANSFER_ARCHIVE_MISMATCH')
        self.observe_error = primary
        self.executor.observation_step()
        self.assertIs(self.executor.observation_primary, primary)
        self.assertEqual(self.response()['errorCode'], 'OWNED_TRANSFER_ARCHIVE_MISMATCH')
        self.assertEqual(self.response()['phase'], 'failed')
        self.assertTrue(self.guard.closed)
        self.assertEqual(self.exits, [65])

    def test_uncertain_owner_holds_without_source_close_or_exit(self):
        self.submit()
        self.retained = True
        self.observe_error = RuntimeError('OWNED_TRANSFER_READ_FAILED')
        self.executor.observation_step()
        self.assertEqual(self.response()['phase'], 'held')
        self.assertIsNone(self.response()['archive'])
        self.assertFalse(self.guard.closed)
        self.assertEqual(self.exits, [])
        self.assertFalse(self.transport.observation_final)

    def test_held_release_known_close_is_failed_not_new_metadata(self):
        self.test_uncertain_owner_holds_without_source_close_or_exit()
        primary = self.executor.observation_primary
        self.transport.accept(self.control())
        self.executor.observation_step()
        self.assertIs(self.executor.observation_primary, primary)
        self.assertEqual(self.response()['phase'], 'failed')
        self.assertIsNone(self.response()['archive'])
        self.assertEqual(self.exits, [65])
        self.assertEqual(self.events[-2:], [('observer-close',), ('guard-close',)])
        with self.assertRaises(RuntimeError):
            self.transport.accept(self.control())

    def test_held_release_uncertain_is_once_and_never_exits(self):
        self.test_uncertain_owner_holds_without_source_close_or_exit()
        self.release_error = RuntimeError('OWNED_TRANSFER_CLOSE_UNCERTAIN')
        self.transport.accept(self.control())
        self.executor.observation_step()
        self.assertEqual(self.response()['phase'], 'held')
        self.assertEqual(self.exits, [])
        with self.assertRaises(RuntimeError):
            self.transport.accept(self.control())
        with self.assertRaises(RuntimeError):
            self.executor.release_observation()
        self.assertEqual(self.events.count(('observer-close',)), 1)

    def test_guard_close_failure_holds_and_erases_completed_snapshot(self):
        self.submit()
        self.guard_error = RuntimeError('OWNED_TRANSFER_CLOSE_FAILED')
        self.executor.observation_step()
        self.assertTrue(self.observer.closed)
        self.assertEqual(self.response()['phase'], 'held')
        self.assertIsNone(self.response()['archive'])
        self.assertEqual(self.exits, [])

    def test_concurrent_control_during_observe_cannot_produce_success(self):
        self.submit()
        def extra():
            with self.assertRaises(RuntimeError):
                self.transport.accept(self.control())
        self.on_observe = extra
        self.executor.observation_step()
        self.assertEqual(self.response()['phase'], 'failed')
        self.assertIsNone(self.response()['archive'])
        self.assertEqual(self.exits, [65])

    def test_fault_during_guard_close_prevents_positive_terminal(self):
        self.submit()
        self.on_guard_close = lambda: setattr(self.transport, 'fault', 'CONTROLLER_EOF')
        self.executor.observation_step()
        self.assertEqual(self.response()['errorCode'], 'OBSERVATION_PROTOCOL_FAULT')
        self.assertEqual(self.exits, [65])

    def test_reader_eof_malformed_and_extra_frame_are_sticky_before_operation(self):
        raw = self.encode(self.request)
        for suffix in (b'', b'{broken}\n', self.control('handoff')+b'\n'):
            transport = worker.Transport(self.request['workerLifetime'], self.base)
            transport.final_written.set()  # Modeled delivered final frame; no real five-second wait.
            with patch.object(worker.os, 'read', side_effect=[raw+b'\n'+suffix, b'']):
                transport.reader()
            self.assertIsNotNone(transport.fault)
            executor = worker.Worker(self.base, self.guard, transport)
            executor.observation_step()
            self.assertEqual(json.loads(transport.slot[0])['phase'], 'failed')
        self.assertFalse(any(event[0] == 'construct' for event in self.events))

    def test_all_other_controls_refused_after_observation_claim(self):
        self.submit()
        for command in ('cancel', 'handoff', 'abort', 'start', 'prepare_destination'):
            with self.subTest(command=command), self.assertRaises(RuntimeError):
                self.transport.accept(self.control(command))
        self.assertEqual(self.transport.commands.qsize(), 1)

    def test_release_foreign_binding_cannot_close_retained_owner(self):
        self.test_uncertain_owner_holds_without_source_close_or_exit()
        with self.assertRaises(RuntimeError):
            self.transport.accept(self.control(binding={**self.binding, 'nativeJobId': 'exec_'+'9'*32}))
        self.assertNotIn(('observer-close',), self.events)

    def test_bad_result_and_error_strings_are_not_metadata_or_path_leaks(self):
        self.submit()
        self.result_override = {**self.archive, 'extra': True}
        self.executor.observation_step()
        self.assertEqual(self.response()['phase'], 'failed')
        self.assertEqual(self.response()['errorCode'], 'OBSERVATION_RESULT_REFUSED')
        self.assertEqual(worker.observation_code(OSError('C:/private/model')), 'OBSERVATION_OPERATION_FAILED')
        self.assertEqual(worker.observation_code(RuntimeError('ARBITRARY_UPPERCASE')), 'OBSERVATION_OPERATION_FAILED')

    def test_undelivered_final_is_bounded_and_never_exit0(self):
        self.submit()
        with patch.object(self.transport.final_written, 'wait', return_value=False) as wait:
            self.executor.observation_step()
        wait.assert_called_once_with(5)
        self.assertEqual(self.exits, [65])

    def test_install_release_cannot_close_observer_via_legacy_path(self):
        self.test_uncertain_owner_holds_without_source_close_or_exit()
        with self.assertRaisesRegex(RuntimeError, 'OBSERVATION_RELEASE_REQUIRED'):
            self.executor.release()
        self.assertNotIn(('observer-close',), self.events)

    def test_legacy_start_and_cancel_transport_lane_remain_separate(self):
        value = {'schema': 'owned-zip-worker-start/1', 'workerLifetime': self.request['workerLifetime'],
                 'binding': self.binding, 'archive': dict(self.archive),
                 'payload': {'own.txt': 'a'*64}, 'total': 3}
        self.transport.accept(self.encode(value))
        self.assertFalse(self.transport.observe_seen)
        command, _, digest = self.transport.commands.get_nowait()
        self.assertEqual(command, 'start')
        self.assertEqual(digest, hashlib.sha256(self.encode(value)).hexdigest())
        self.transport.accept(self.control('cancel'))
        self.assertTrue(self.transport.cancel_seen.is_set())
        self.assertEqual(self.transport.commands.get_nowait()[0], 'cancel')
        self.assertEqual(self.events, [])


if __name__ == '__main__':
    unittest.main()
