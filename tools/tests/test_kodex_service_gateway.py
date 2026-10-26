"""Fixed executable lifecycle regressions; only disposable installations are used."""
import importlib.machinery
import importlib.util
import json
import os
from pathlib import Path
import plistlib
import shutil
import socket
import sys
import subprocess
import tempfile
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[1] / 'kodex-service'
loader = importlib.machinery.SourceFileLoader('kodex_service_gateway_test', str(SOURCE))
spec = importlib.util.spec_from_loader(loader.name, loader)
service = importlib.util.module_from_spec(spec)
loader.exec_module(service)


class FixedGatewayTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.app = service.Service(self.root / 'installed', self.root / 'agents')
        self.app.root.mkdir()
        self.app.config_path.write_text(json.dumps({
            'port': 18787, 'data_dir': str(self.root / 'data'), 'path': '/usr/bin:/bin',
        }))
        self.fixed = self.app.root / 'bin/kodex-gateway'
        external = patch.object(service, 'run', side_effect=AssertionError('Unexpected external command'))
        external.start()
        self.addCleanup(external.stop)

    def release(self, name):
        release = self.app.root / 'releases' / name
        release.mkdir(parents=True)
        gateway = release / 'kodex-gateway'
        gateway.write_text('#!/bin/sh\nexit 0\n# release: ' + name + '\n')
        gateway.chmod(0o755)
        for filename in service.CONTROLLER_FILES:
            (release / filename).write_bytes((SOURCE.parent / filename).read_bytes())
        return release

    def select(self, release):
        service.link(self.app.root / 'current', release)
        service.link(self.app.root / 'controller', release)
        service.link(self.app.root / 'kodex-service', self.app.root / 'controller/kodex-service')

    def install_fixture(self, release):
        self.fixed.parent.mkdir(exist_ok=True)
        shutil.copy2(release / 'kodex-gateway', self.fixed)

    def assert_installed(self, release):
        self.assertFalse(self.fixed.is_symlink())
        self.assertEqual(self.fixed.read_bytes(), (release / 'kodex-gateway').read_bytes())
        self.assertTrue(os.access(self.fixed, os.X_OK))
        self.assertEqual(list(self.fixed.parent.glob('.gateway-*')), [])

    def test_initial_execution_uses_real_fixed_binary_and_selected_release_resources(self):
        release = self.release('initial')
        self.select(release)
        with patch.object(service, 'check_port'), patch.object(service.os, 'execve') as execute:
            self.app.execute()
        self.assert_installed(release)
        binary, args, environment = execute.call_args.args
        self.assertEqual(binary, self.fixed)
        self.assertEqual(args, [str(self.fixed)])
        self.assertEqual(environment['KODEX_CODEX_BINARY'], str(release / 'codex'))
        self.assertEqual(environment['KODEX_FRONTEND_DIST'], str(release / 'frontend'))

    def test_startup_recovers_binary_from_selected_release_after_interrupted_switch(self):
        old, selected = self.release('old'), self.release('selected')
        self.install_fixture(old)
        self.select(selected)
        with patch.object(service, 'check_port'), patch.object(service.os, 'execve'):
            self.app.execute()
        self.assert_installed(selected)
        self.assertIn('old', (old / 'kodex-gateway').read_text())

    def test_unchanged_startup_keeps_installed_inode(self):
        release = self.release('current')
        self.select(release)
        self.install_fixture(release)
        inode = self.fixed.stat().st_ino
        with patch.object(service, 'check_port'), patch.object(service.os, 'execve'):
            self.app.execute()
        self.assertEqual(self.fixed.stat().st_ino, inode)

    def test_update_stages_before_stop_then_replaces_and_starts_matching_release(self):
        old, new = self.release('old'), self.release('new')
        self.select(old)
        self.install_fixture(old)
        old_inode = self.fixed.stat().st_ino
        actions = []

        def stop():
            actions.append('stop')
            self.assertEqual(self.fixed.stat().st_ino, old_inode)
            self.assertEqual(self.fixed.read_bytes(), (old / 'kodex-gateway').read_bytes())
            staged = list(self.fixed.parent.glob('.gateway-*'))
            self.assertEqual(len(staged), 1)
            self.assertEqual(staged[0].read_bytes(), (new / 'kodex-gateway').read_bytes())
            self.assertEqual((self.app.root / 'current').resolve(), old)

        def start():
            actions.append('start')
            self.assert_installed(new)
            self.assertNotEqual(self.fixed.stat().st_ino, old_inode)
            self.assertEqual((self.app.root / 'current').resolve(), new)
            self.assertEqual((self.app.root / 'previous').resolve(), old)

        with patch.object(self.app, 'build', return_value=new), \
             patch.object(self.app, 'stop', side_effect=stop), \
             patch.object(self.app, 'start', side_effect=start):
            self.app.update(self.root)
        self.assertEqual(actions, ['stop', 'start'])

    def test_failed_staging_preserves_running_binary_and_selection(self):
        old, new = self.release('old'), self.release('new')
        self.select(old)
        self.install_fixture(old)
        with patch.object(self.app, 'build', return_value=new), \
             patch.object(service.shutil, 'copy2', side_effect=OSError('copy failed')), \
             patch.object(self.app, 'stop') as stop:
            with self.assertRaisesRegex(OSError, 'copy failed'):
                self.app.update(self.root)
        stop.assert_not_called()
        self.assert_installed(old)
        self.assertEqual((self.app.root / 'current').resolve(), old)

    def test_failed_signature_verification_never_stops_or_publishes(self):
        old, new = self.release('old'), self.release('new')
        self.select(old)
        self.install_fixture(old)
        self.app.configure_code_signing_identity('A' * 40)
        failure = subprocess.CalledProcessError(1, 'codesign', stderr='invalid signature')
        with patch.object(self.app, 'build', return_value=new), \
             patch.object(service, 'run', side_effect=failure), \
             patch.object(self.app, 'stop') as stop:
            with self.assertRaisesRegex(service.ServiceError, 'invalid signature'):
                self.app.update(self.root)
        stop.assert_not_called()
        self.assert_installed(old)
        self.assertEqual((self.app.root / 'current').resolve(), old)

    def test_failed_stop_never_replaces_live_binary(self):
        old, new = self.release('old'), self.release('new')
        self.select(old)
        self.install_fixture(old)
        with patch.object(self.app, 'build', return_value=new), \
             patch.object(self.app, 'stop', side_effect=service.ServiceError('still running')):
            with self.assertRaisesRegex(service.ServiceError, 'still running'):
                self.app.update(self.root)
        self.assert_installed(old)
        self.assertEqual((self.app.root / 'current').resolve(), old)

    def test_failed_atomic_install_does_not_start_mixed_release(self):
        old, new = self.release('old'), self.release('new')
        self.select(old)
        self.install_fixture(old)
        replace = Path.replace

        def fail_install(path, destination):
            if destination == self.fixed:
                raise OSError('rename failed')
            return replace(path, destination)

        with patch.object(self.app, 'build', return_value=new), \
             patch.object(self.app, 'stop'), patch.object(self.app, 'start') as start, \
             patch.object(Path, 'replace', new=fail_install):
            with self.assertRaisesRegex(OSError, 'rename failed'):
                self.app.update(self.root)
        start.assert_not_called()
        self.assert_installed(old)
        self.assertEqual((self.app.root / 'current').resolve(), new)
        with patch.object(service, 'check_port'), patch.object(service.os, 'execve'):
            self.app.execute()
        self.assert_installed(new)

    def test_rollback_keeps_new_controller_and_restores_binary_at_same_path(self):
        old, new = self.release('old'), self.release('new')
        (old / 'kodex-service').write_text('obsolete launcher')
        self.select(new)
        self.install_fixture(new)
        service.link(self.app.root / 'previous', old)
        with patch.object(self.app, 'stop'), patch.object(self.app, 'start'):
            self.app.rollback(True)
        self.assert_installed(old)
        self.assertEqual((self.app.root / 'current').resolve(), old)
        self.assertEqual((self.app.root / 'previous').resolve(), new)
        self.app.write_plist()
        command = plistlib.loads(self.app.plist.read_bytes())['ProgramArguments']
        self.assertEqual(Path(command[1]).resolve(), new / 'kodex-service')

    def test_rollback_verification_failure_leaves_live_release_untouched(self):
        old, new = self.release('old'), self.release('new')
        self.select(new)
        self.install_fixture(new)
        service.link(self.app.root / 'previous', old)
        self.app.configure_code_signing_identity('A' * 40)
        failure = subprocess.CalledProcessError(1, 'codesign', stderr='invalid rollback signature')
        with patch.object(service, 'run', side_effect=failure), patch.object(self.app, 'stop') as stop:
            with self.assertRaisesRegex(service.ServiceError, 'invalid rollback signature'):
                self.app.rollback(True)
        stop.assert_not_called()
        self.assert_installed(new)
        self.assertEqual((self.app.root / 'current').resolve(), new)

    def test_rollback_with_missing_or_broken_current_never_stops_live_job(self):
        old, new = self.release('old'), self.release('new')
        self.install_fixture(new)
        service.link(self.app.root / 'previous', old)
        for broken in (False, True):
            with self.subTest(broken=broken):
                self.select(new)
                current = self.app.root / 'current'
                current.unlink()
                if broken:
                    current.symlink_to(self.root / 'missing-release')
                with patch.object(self.app, 'stop') as stop:
                    with self.assertRaises(FileNotFoundError):
                        self.app.rollback(True)
                stop.assert_not_called()
                self.assert_installed(new)

    def test_interrupted_rollback_preserves_both_release_selections(self):
        swap = service.swap_paths
        for after_swap in (False, True):
            with self.subTest(after_swap=after_swap):
                old = self.release(f'old-{after_swap}')
                new = self.release(f'new-{after_swap}')
                self.select(new)
                self.install_fixture(new)
                service.link(self.app.root / 'previous', old)

                def interrupt(left, right):
                    if after_swap:
                        swap(left, right)
                    raise KeyboardInterrupt('worker interrupted')

                with patch.object(self.app, 'stop'), patch.object(self.app, 'start') as start, \
                     patch.object(service, 'swap_paths', side_effect=interrupt):
                    with self.assertRaisesRegex(KeyboardInterrupt, 'worker interrupted'):
                        self.app.rollback(True)
                start.assert_not_called()
                selected, previous = (old, new) if after_swap else (new, old)
                self.assertEqual((self.app.root / 'current').resolve(), selected)
                self.assertEqual((self.app.root / 'previous').resolve(), previous)
                self.assert_installed(new)
                with patch.object(service, 'check_port'), patch.object(service.os, 'execve'):
                    self.app.execute()
                self.assert_installed(selected)

    def test_explicit_start_prepares_binary_before_bootstrap(self):
        release = self.release('initial')
        self.select(release)

        def bootstrap(_args):
            self.assert_installed(release)
            command = plistlib.loads(self.app.plist.read_bytes())['ProgramArguments']
            self.assertEqual(Path(command[1]).resolve(), release / 'kodex-service')

        with patch.object(service, 'check_port'), patch.object(self.app, 'job', return_value=None), \
             patch.object(self.app, 'health'), patch.object(service, 'run', side_effect=bootstrap):
            self.app.start()

    def test_start_of_healthy_running_job_does_not_replace_its_binary(self):
        old, selected = self.release('old'), self.release('selected')
        self.select(selected)
        self.install_fixture(old)
        inode = self.fixed.stat().st_ino
        with patch.object(self.app, 'job', return_value={'pid': 42}), patch.object(self.app, 'health'):
            self.app.start()
        self.assertEqual(self.fixed.stat().st_ino, inode)
        self.assert_installed(old)

    def test_rollback_entry_point_executes_fixed_binary_using_retained_controller(self):
        old, new = self.release('old'), self.release('new')
        (old / 'kodex-service').write_text('obsolete launcher')
        (old / 'kodex-gateway').write_text(
            '#!/bin/sh\n'
            'printf \'%s\\n\' "$0" "$KODEX_CODEX_BINARY" "$KODEX_FRONTEND_DIST"\n')
        self.select(new)
        self.install_fixture(new)
        service.link(self.app.root / 'previous', old)
        with patch.object(self.app, 'stop'), patch.object(self.app, 'start'):
            self.app.rollback(True)
        with socket.socket() as listener:
            listener.bind(('127.0.0.1', 0))
            port = listener.getsockname()[1]
        config = json.loads(self.app.config_path.read_text())
        config['port'] = port
        self.app.config_path.write_text(json.dumps(config))
        result = subprocess.run([sys.executable, str(self.app.root / 'kodex-service'),
                                 '--root', str(self.app.root), '_run'],
                                capture_output=True, text=True, check=True)
        self.assertEqual(result.stdout.splitlines(), [str(self.fixed), str(old / 'codex'),
                                                      str(old / 'frontend')])
        self.assert_installed(old)

    def test_startup_repairs_missing_execute_permission_by_replacing_file(self):
        release = self.release('current')
        self.select(release)
        self.install_fixture(release)
        self.fixed.chmod(0o644)
        inode = self.fixed.stat().st_ino
        with patch.object(service, 'check_port'), patch.object(service.os, 'execve'):
            self.app.execute()
        self.assert_installed(release)
        self.assertNotEqual(self.fixed.stat().st_ino, inode)

    def test_nonexecutable_release_is_rejected_before_stopping(self):
        old, new = self.release('old'), self.release('new')
        self.select(old)
        self.install_fixture(old)
        (new / 'kodex-gateway').chmod(0o644)
        with patch.object(self.app, 'build', return_value=new), patch.object(self.app, 'stop') as stop:
            with self.assertRaisesRegex(service.ServiceError, 'not executable'):
                self.app.update(self.root)
        stop.assert_not_called()
        self.assert_installed(old)

    def test_signed_update_and_rollback_verify_copies_without_resigning_archives(self):
        old, new = self.release('old'), self.release('new')
        self.select(old)
        self.install_fixture(old)
        originals = [(release / 'kodex-gateway').read_bytes() for release in (old, new)]
        self.app.configure_code_signing_identity('A' * 40)
        calls = []

        def command(args, **_kwargs):
            calls.append(args)
            requirement = 'designated => identifier "dev.kodex.gateway" and certificate root = H"abc"'
            return subprocess.CompletedProcess(args, 0, requirement, '')

        def stop():
            staged = list(self.fixed.parent.glob('.gateway-*'))
            self.assertEqual(len(staged), 1)
            self.assertIn([service.CODESIGN, '--verify', '--strict', '--verbose=2', staged[0]], calls)

        with patch.object(self.app, 'build', return_value=new), \
             patch.object(service, 'run', side_effect=command), \
             patch.object(self.app, 'stop', side_effect=stop), patch.object(self.app, 'start'):
            self.app.update(self.root)
            self.app.rollback(True)
        self.assert_installed(old)
        self.assertFalse(any('--sign' in args for args in calls))
        self.assertEqual([(release / 'kodex-gateway').read_bytes() for release in (old, new)], originals)

    def test_startup_rejects_symlinked_binary_or_directory(self):
        release = self.release('initial')
        self.select(release)
        for directory_link in (False, True):
            with self.subTest(directory_link=directory_link):
                if directory_link:
                    destination = self.root / 'outside'; destination.mkdir()
                    self.fixed.parent.symlink_to(destination, target_is_directory=True)
                else:
                    self.fixed.parent.mkdir()
                    self.fixed.symlink_to(release / 'kodex-gateway')
                try:
                    with patch.object(service, 'check_port'), patch.object(service.os, 'execve') as execute:
                        with self.assertRaisesRegex(service.ServiceError, 'real'):
                            self.app.execute()
                    execute.assert_not_called()
                finally:
                    if directory_link:
                        self.fixed.parent.unlink()
                    else:
                        self.fixed.unlink()
                        self.fixed.parent.rmdir()


if __name__ == '__main__':
    unittest.main()
