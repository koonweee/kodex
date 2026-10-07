"""Independent service operation tests; no installed service or launchd is touched."""
import contextlib
import importlib
import importlib.machinery
import importlib.util
import io
import json
from pathlib import Path
import plistlib
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import Mock, patch

TOOLS = Path(__file__).resolve().parents[1]
SOURCE = TOOLS / 'kodex-service'
sys.path.insert(0, str(TOOLS))
try:
    operations_module = importlib.import_module('kodex_service_operations')
    cli = importlib.import_module('kodex_service_cli')
    loader = importlib.machinery.SourceFileLoader('kodex_service_operations_test_controller', str(SOURCE))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    service = importlib.util.module_from_spec(spec)
    loader.exec_module(service)
finally:
    sys.path.remove(str(TOOLS))


class OperationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.repo = self.root / 'checkout'
        self.repo.mkdir()
        self.app = service.Service(self.root / 'installed', self.root / 'agents')
        self.app.root.mkdir()
        self.app.config_path.write_text(json.dumps({
            'port': 18787, 'data_dir': str(self.root / 'data'),
            'path': '/usr/bin:/bin', 'repo': str(self.repo),
        }))
        service.link(self.app.root / 'current', self.release('initial'))
        self.operations = operations_module.Operations(self.app, SOURCE, service.__dict__)

    def submit(self, action='update', **kwargs):
        with patch.object(service, 'run'):
            return self.operations.submit(action, repo=self.repo if action == 'update' else None, **kwargs)

    def release(self, name):
        release = self.app.root / 'releases' / name
        release.mkdir(parents=True)
        return release

    def test_submit_records_job_before_bootstrap_and_uses_one_shot_worker(self):
        observed = []

        def bootstrap(args, **kwargs):
            self.assertEqual(args[:2], [service.LAUNCHCTL, 'bootstrap'])
            job = self.operations.status()
            self.assertEqual(job['state'], 'queued')
            self.assertEqual(job['repo'], str(self.repo))
            self.assertEqual(job['action'], 'update')
            plist = plistlib.loads(Path(args[-1]).read_bytes())
            self.assertTrue(plist['RunAtLoad'])
            self.assertFalse(plist['KeepAlive'])
            self.assertNotIn('StartInterval', plist)
            self.assertNotIn('StartCalendarInterval', plist)
            self.assertNotIn('WatchPaths', plist)
            self.assertEqual(plist['ProgramArguments'][-2:], ['_operation-run', job['id']])
            self.assertEqual(plist['StandardOutPath'], job['logPath'])
            worker = Path(plist['ProgramArguments'][1])
            self.assertTrue(worker.is_file())
            self.assertTrue((worker.parent / 'kodex_service_operations.py').is_file())
            self.assertTrue((worker.parent / 'kodex_service_cli.py').is_file())
            self.assertNotEqual(worker, SOURCE)
            observed.append(job['id'])

        with patch.object(service, 'run', side_effect=bootstrap), \
             patch.object(self.app, 'update') as update:
            job = self.operations.submit('update', repo=self.repo)
        self.assertEqual(observed, [job['id']])
        self.assertEqual(self.operations.status(job['id'])['state'], 'queued')
        update.assert_not_called()

    def test_queued_job_excludes_second_submission_before_worker_starts(self):
        first = self.submit()
        with patch.object(service, 'run') as launch:
            with self.assertRaisesRegex(service.ServiceError, 'operation|running|progress'):
                self.operations.submit('restart')
        launch.assert_not_called()
        self.assertEqual(self.operations.status()['id'], first['id'])

    def test_active_operation_excludes_synchronous_frontend_mutation(self):
        self.submit()
        with service.locked(self.app.root):
            with self.assertRaisesRegex(service.ServiceError, 'operation|running|progress'):
                self.operations.assert_idle()

    def test_bootstrap_failure_is_persisted_and_does_not_block_next_operation(self):
        with patch.object(service, 'run', side_effect=subprocess.CalledProcessError(5, 'launchctl')), \
             patch.object(operations_module.subprocess, 'run',
                          return_value=subprocess.CompletedProcess('launchctl', 1)):
            with self.assertRaises((service.ServiceError, subprocess.CalledProcessError)):
                self.operations.submit('restart')
        failed = self.operations.status()
        self.assertEqual(failed['state'], 'failed')
        self.assertTrue(failed['error'])
        with patch.object(self.app, 'stop') as stop, patch.object(self.app, 'start') as start:
            self.operations.execute(failed['id'])
        stop.assert_not_called()
        start.assert_not_called()
        next_job = self.submit('restart')
        self.assertNotEqual(next_job['id'], failed['id'])
        self.assertEqual(next_job['state'], 'queued')

    def test_interrupted_handoff_preserves_worker_already_accepted_by_launchd(self):
        with patch.object(service, 'run', side_effect=KeyboardInterrupt), \
             patch.object(operations_module.subprocess, 'run',
                          return_value=subprocess.CompletedProcess('launchctl', 0)):
            with self.assertRaises(KeyboardInterrupt):
                self.operations.submit('restart')
        job = self.operations.status()
        self.assertEqual(job['state'], 'queued')
        with patch.object(self.app, 'stop') as stop, patch.object(self.app, 'start') as start:
            result = self.operations.execute(job['id'])
        self.assertEqual(result['state'], 'succeeded')
        stop.assert_called_once_with()
        start.assert_called_once_with()

    def test_status_preserves_completion_written_while_reader_waits_for_lock(self):
        job = self.submit()
        self.operations._save(dict(job, state='running'))
        completed = dict(job, state='succeeded', error=None,
                         release=str((self.app.root / 'current').resolve()))

        @contextlib.contextmanager
        def worker_finishes_before_reader_acquires_lock(root, **kwargs):
            self.operations._save(completed)
            yield

        with patch.object(service, 'locked', worker_finishes_before_reader_acquires_lock):
            result = self.operations.status(job['id'])
        self.assertEqual(result['state'], 'succeeded')
        self.assertIsNone(result['error'])
        self.assertEqual(result['release'], completed['release'])
        self.assertEqual(self.operations.status(job['id'])['state'], 'succeeded')

    def test_status_fails_aged_queued_job_with_missing_or_inactive_worker(self):
        for returncode, output in [(1, ''), (0, 'state = exited\n')]:
            with self.subTest(returncode=returncode, output=output):
                job = self.submit()
                probe = subprocess.CompletedProcess('launchctl', returncode, stdout=output)
                with patch.object(operations_module.time, 'time', return_value=job['createdAt'] + 31), \
                     patch.object(operations_module.subprocess, 'run', return_value=probe):
                    result = self.operations.status(job['id'])
                self.assertEqual(result['state'], 'failed')
                self.assertTrue(result['error'])
                with patch.object(self.app, 'update') as update:
                    self.assertEqual(self.operations.execute(job['id'])['state'], 'failed')
                update.assert_not_called()

    def test_worker_records_running_state_and_holds_exclusive_service_lock(self):
        job = self.submit()
        release = self.release('new')

        def update(repo):
            self.assertEqual(repo, self.repo)
            self.assertEqual(self.operations.status(job['id'])['state'], 'running')
            with self.assertRaisesRegex(service.ServiceError, 'running'):
                with service.locked(self.app.root):
                    self.fail('worker must own the management lock')
            service.link(self.app.root / 'current', release)

        with patch.object(self.app, 'update', side_effect=update):
            result = self.operations.execute(job['id'])
        self.assertEqual(result['state'], 'succeeded')
        self.assertEqual(result['release'], str(release))
        self.assertEqual(self.operations.status(job['id'])['state'], 'succeeded')
        with service.locked(self.app.root):
            self.operations.assert_idle()

    def test_success_is_observable_after_new_controller_and_never_replayed(self):
        job = self.submit('restart')
        with patch.object(self.app, 'stop') as stop, patch.object(self.app, 'start') as start:
            result = self.operations.execute(job['id'])
        stop.assert_called_once_with()
        start.assert_called_once_with()
        restored = operations_module.Operations(self.app, SOURCE, service.__dict__)
        self.assertEqual(restored.status(job['id'])['state'], 'succeeded')
        with patch.object(self.app, 'stop') as stop, patch.object(self.app, 'start') as start:
            self.assertEqual(restored.execute(job['id'])['state'], 'succeeded')
            self.assertEqual(restored.wait(job['id'])['state'], 'succeeded')
        stop.assert_not_called()
        start.assert_not_called()
        self.assertTrue(Path(result['logPath']).exists())

    def test_action_failure_is_preserved_and_not_retried_by_wait_or_worker(self):
        job = self.submit()
        with patch.object(self.app, 'update', side_effect=service.ServiceError('build failed')) as update:
            result = self.operations.execute(job['id'])
        update.assert_called_once_with(self.repo)
        self.assertEqual(result['state'], 'failed')
        self.assertIn('build failed', result['error'])
        with patch.object(self.app, 'update') as update:
            self.assertEqual(self.operations.wait(job['id'])['state'], 'failed')
            self.assertEqual(self.operations.execute(job['id'])['state'], 'failed')
        update.assert_not_called()

    def process(self, body, *args, background=False):
        prelude = """
import importlib.machinery, importlib.util, json, os, sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
from kodex_service_operations import Operations
loader = importlib.machinery.SourceFileLoader('isolated_service_controller', sys.argv[2])
spec = importlib.util.spec_from_loader(loader.name, loader)
service = importlib.util.module_from_spec(spec)
loader.exec_module(service)
app = service.Service(Path(sys.argv[3]))
operations = Operations(app, Path(sys.argv[2]), service.__dict__)
"""
        command = [sys.executable, '-c', prelude + body, str(TOOLS), str(SOURCE),
                   str(self.app.root), *map(str, args)]
        if background:
            return subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        return subprocess.run(command, capture_output=True, text=True, timeout=15)

    def test_launched_worker_waits_for_submitter_lock_before_mutating_service(self):
        job = self.submit()
        ready, completed = self.root / 'ready', self.root / 'completed'
        worker = None
        try:
            with service.locked(self.app.root):
                worker = self.process("""
Path(sys.argv[5]).write_text('ready')
app.update = lambda repo: Path(sys.argv[6]).write_text(str(repo))
operations.execute(sys.argv[4])
""", job['id'], ready, completed, background=True)
                deadline = time.monotonic() + 10
                while not ready.exists() and worker.poll() is None and time.monotonic() < deadline:
                    time.sleep(0.01)
                self.assertTrue(ready.exists(), 'worker did not reach the operation handoff')
                self.assertIsNone(worker.poll(), 'worker must wait for the submitting process lock')
                self.assertFalse(completed.exists())
                self.assertEqual(self.operations.status(job['id'])['state'], 'queued')
            output, error = worker.communicate(timeout=15)
            self.assertEqual(worker.returncode, 0, error)
            self.assertEqual(completed.read_text(), str(self.repo))
            self.assertEqual(self.operations.status(job['id'])['state'], 'succeeded')
        finally:
            if worker is not None and worker.poll() is None:
                worker.kill()
                worker.communicate(timeout=5)

    def test_worker_uses_persisted_job_after_submitting_process_has_exited(self):
        caller = self.process("""
service.run = lambda *args, **kwargs: None
print(json.dumps(operations.submit('update', repo=Path(sys.argv[4]))))
""", self.repo)
        self.assertEqual(caller.returncode, 0, caller.stderr)
        job = json.loads(caller.stdout)
        marker = self.root / 'worker-completed'
        worker = self.process("""
app.update = lambda repo: Path(sys.argv[5]).write_text(str(repo))
print(json.dumps(operations.execute(sys.argv[4])))
""", job['id'], marker)
        self.assertEqual(worker.returncode, 0, worker.stderr)
        self.assertEqual(marker.read_text(), str(self.repo))
        self.assertEqual(self.operations.status(job['id'])['state'], 'succeeded')
        self.assertTrue(Path(job['logPath']).exists())

    def test_crashed_worker_is_failed_without_reexecuting_accepted_action(self):
        job = self.submit()
        worker = self.process("""
app.update = lambda repo: os._exit(17)
operations.execute(sys.argv[4])
""", job['id'])
        self.assertEqual(worker.returncode, 17, worker.stderr)
        with patch.object(self.app, 'update') as update:
            result = self.operations.status(job['id'])
            self.assertEqual(result['state'], 'failed')
            self.assertTrue(result['error'])
            self.assertEqual(self.operations.execute(job['id'])['state'], 'failed')
        update.assert_not_called()
        self.assertEqual(self.operations.status(job['id'])['state'], 'failed')

    def test_rollback_requires_acknowledgment_before_handoff_and_passes_it_to_worker(self):
        with patch.object(service, 'run') as launch:
            with self.assertRaisesRegex(service.ServiceError, 'data-compatible'):
                self.operations.submit('rollback')
        launch.assert_not_called()
        job = self.submit('rollback', data_compatible=True)
        with patch.object(self.app, 'rollback') as rollback:
            result = self.operations.execute(job['id'])
        rollback.assert_called_once_with(True)
        self.assertEqual(result['state'], 'succeeded')


class CommandTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.app = Mock(root=self.root)
        self.app.config.return_value = {'repo': str(self.root)}
        self.job = {'id': 'operation-123', 'state': 'queued', 'action': 'update',
                    'logPath': str(self.root / 'operation.log'), 'error': None}
        self.operations = Mock(spec=operations_module.Operations, unsafe=True)
        self.operations.submit.return_value = self.job
        self.operations.status.return_value = self.job
        self.operations.wait.return_value = dict(self.job, state='succeeded')
        self.runtime = dict(service.__dict__, Service=Mock(return_value=self.app),
                            Operations=Mock(return_value=self.operations))

    def command(self, *args):
        with patch.object(service.sys, 'platform', 'darwin'), \
             patch.object(service.os, 'getuid', return_value=501), \
             contextlib.redirect_stdout(io.StringIO()):
            return cli.main(self.runtime, ['--root', str(self.root), *args])

    def test_full_operations_default_submit_without_running_or_waiting(self):
        for args in [('update', '--repo', str(self.root)), ('restart',),
                     ('rollback', '--data-compatible')]:
            with self.subTest(command=args[0]):
                self.operations.reset_mock()
                self.app.reset_mock()
                self.command(*args)
                self.operations.submit.assert_called_once()
                self.assertEqual(self.operations.submit.call_args.args[0], args[0])
                self.operations.wait.assert_not_called()
                self.operations.execute.assert_not_called()
                self.app.update.assert_not_called()
                self.app.rollback.assert_not_called()
                self.app.stop.assert_not_called()
                self.app.start.assert_not_called()

    def test_wait_reports_failed_result_without_retrying_action(self):
        self.operations.wait.return_value = dict(self.job, state='failed', error='build failed')
        try:
            result = self.command('update', '--repo', str(self.root), '--wait')
        except service.ServiceError as error:
            self.assertIn('build failed', str(error))
        else:
            self.assertIsNotNone(result)
            self.assertNotEqual(result, 0)
        self.operations.wait.assert_called_once_with(self.job['id'])
        self.operations.execute.assert_not_called()
        self.app.update.assert_not_called()

    def test_update_wait_observes_submitted_job_without_caller_update(self):
        self.command('update', '--repo', str(self.root), '--wait')
        self.operations.submit.assert_called_once()
        self.assertEqual(self.operations.submit.call_args.args[0], 'update')
        self.assertEqual(self.operations.submit.call_args.kwargs['repo'], self.root)
        self.operations.wait.assert_called_once_with(self.job['id'])
        self.app.update.assert_not_called()
        self.operations.execute.assert_not_called()

    def test_rollback_wait_is_also_only_an_observer(self):
        self.command('rollback', '--data-compatible', '--wait')
        self.operations.submit.assert_called_once()
        self.assertEqual(self.operations.submit.call_args.args[0], 'rollback')
        self.assertTrue(self.operations.submit.call_args.kwargs['data_compatible'])
        self.operations.wait.assert_called_once_with(self.job['id'])
        self.app.rollback.assert_not_called()
        self.operations.execute.assert_not_called()

    def test_frontend_update_stays_synchronous_and_checks_active_job(self):
        self.command('update-frontend', '--repo', str(self.root))
        self.operations.assert_idle.assert_called_once_with()
        self.app.update_frontend.assert_called_once_with(self.root)
        self.operations.submit.assert_not_called()
        self.operations.wait.assert_not_called()

    def test_frontend_update_is_rejected_before_any_write_while_operation_active(self):
        self.operations.assert_idle.side_effect = service.ServiceError('operation running')
        with self.assertRaisesRegex(service.ServiceError, 'operation running'):
            self.command('update-frontend', '--repo', str(self.root))
        self.app.update_frontend.assert_not_called()

    def test_operation_status_reads_persistent_result_without_execution(self):
        self.command('operation-status', self.job['id'])
        self.operations.status.assert_called_once_with(self.job['id'])
        self.operations.execute.assert_not_called()
        self.operations.submit.assert_not_called()
        self.operations.wait.assert_not_called()


if __name__ == '__main__':
    unittest.main()
