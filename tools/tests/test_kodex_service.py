"""Service lifecycle tests; no real launchd jobs or user storage are touched."""
import importlib.machinery
import importlib.util
from pathlib import Path
import json
import hashlib
import io
import tarfile
import socket
import sys
import subprocess
import tempfile
import unittest
import urllib.parse
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[1] / 'kodex-service'
loader = importlib.machinery.SourceFileLoader('kodex_service', str(SOURCE))
spec = importlib.util.spec_from_loader(loader.name, loader)
service = importlib.util.module_from_spec(spec)
loader.exec_module(service)


class LifecycleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.app = service.Service(self.root / 'installed', self.root / 'agents')
        self.app.root.mkdir()
        self.app.config_path.write_text(json.dumps({
            'port': 18787, 'data_dir': str(self.root / 'data'),
            'path': '/usr/bin:/bin',
        }))
        self.actions = []

    def release(self, name):
        path = self.app.root / 'releases' / name
        path.mkdir(parents=True)
        (path / 'frontend').mkdir()
        (path / 'frontend/index.html').write_text(name)
        (path / 'kodex-gateway').write_text('gateway')
        (path / 'codex').write_text('native')
        (path / 'manifest.json').write_text(json.dumps({'schema_version': '0.160.0'}))
        return path

    def test_port_conflict_is_detected(self):
        with socket.socket() as listener:
            listener.bind(('127.0.0.1', 0))
            listener.listen()
            with self.assertRaisesRegex(service.ServiceError, 'already in use'):
                service.check_port(listener.getsockname()[1])

    def test_build_failure_never_stops_existing_service(self):
        old = self.release('old')
        service.link(self.app.root / 'current', old)
        with patch.object(self.app, 'build', side_effect=service.ServiceError('build failed')), \
             patch.object(self.app, 'stop') as stop:
            with self.assertRaisesRegex(service.ServiceError, 'build failed'):
                self.app.update(self.root)
        stop.assert_not_called()
        self.assertEqual((self.app.root / 'current').resolve(), old)

    def test_update_stages_before_stop_and_preserves_previous(self):
        old, new = self.release('old'), self.release('new')
        service.link(self.app.root / 'current', old)
        def build(repo):
            self.actions.append('build')
            return new
        with patch.object(self.app, 'build', side_effect=build), \
             patch.object(self.app, 'stop', side_effect=lambda: self.actions.append('stop')), \
             patch.object(self.app, 'start', side_effect=lambda: self.actions.append('start')):
            self.app.update(self.root)
        self.assertEqual(self.actions, ['build', 'stop', 'start'])
        self.assertEqual((self.app.root / 'current').resolve(), new)
        self.assertEqual((self.app.root / 'previous').resolve(), old)

    def test_update_keeps_worker_controller_after_rollback_to_older_release(self):
        old, new = self.release('old'), self.release('new')
        (old / 'kodex-service').write_text('old synchronous controller')
        for name in service.CONTROLLER_FILES:
            (new / name).write_bytes((SOURCE.parent / name).read_bytes())
        service.link(self.app.root / 'current', old)
        service.link(self.app.root / 'kodex-service', self.app.root / 'current/kodex-service')
        with patch.object(self.app, 'build', return_value=new), \
             patch.object(self.app, 'stop'), patch.object(self.app, 'start'):
            self.app.update(self.root)
            self.app.rollback(True)
        self.assertEqual((self.app.root / 'current').resolve(), old)
        self.assertEqual((self.app.root / 'controller').resolve(), new)
        installed = self.app.root / 'kodex-service'
        self.assertEqual(installed.resolve(), new / 'kodex-service')
        observed = subprocess.run([sys.executable, str(installed), '--root', str(self.app.root),
                                   'operation-status'], check=True, capture_output=True, text=True)
        self.assertIsNone(json.loads(observed.stdout))

    def test_failed_health_stops_new_release_without_automatic_data_rollback(self):
        old, new = self.release('old'), self.release('new')
        service.link(self.app.root / 'current', old)
        with patch.object(self.app, 'build', return_value=new), \
             patch.object(self.app, 'stop') as stop, \
             patch.object(self.app, 'start', side_effect=service.ServiceError('unhealthy')):
            with self.assertRaisesRegex(service.ServiceError, 'unhealthy'):
                self.app.update(self.root)
        self.assertEqual(stop.call_count, 2)
        self.assertEqual((self.app.root / 'current').resolve(), new)
        self.assertEqual((self.app.root / 'previous').resolve(), old)

    def test_autostart_toggle_does_not_start_or_stop_service(self):
        self.app.write_plist()
        with patch.object(self.app, 'start') as start, patch.object(self.app, 'stop') as stop:
            self.app.autostart(True)
            self.assertTrue(self.app.login_plist.exists())
            self.app.autostart(False)
            self.assertFalse(self.app.login_plist.exists())
        start.assert_not_called()
        stop.assert_not_called()

    def test_start_conflict_does_not_bootstrap_or_kill_other_process(self):
        self.release('new')
        service.link(self.app.root / 'current', self.app.root / 'releases/new')
        with patch.object(self.app, 'job', return_value=None), \
             patch.object(service, 'check_port', side_effect=service.ServiceError('already in use')), \
             patch.object(service, 'run') as run:
            with self.assertRaisesRegex(service.ServiceError, 'already in use'):
                self.app.start()
        run.assert_not_called()

    def test_runtime_environment_does_not_inherit_desktop_or_gateway_overrides(self):
        release = self.release('new')
        with patch.dict(service.os.environ, {'CODEX_HOME': '/desktop', 'KODEX_DATA_DIR': '/old',
                                            'OPENAI_API_KEY': 'secret', 'ENV': '/injected'}):
            env = self.app.environment(release)
        self.assertNotIn('CODEX_HOME', env)
        self.assertNotIn('OPENAI_API_KEY', env)
        self.assertNotIn('ENV', env)
        self.assertEqual(env['KODEX_DATA_DIR'], str(self.root / 'data'))
        self.assertEqual(env['KODEX_CODEX_BINARY'], str(release / 'codex'))
        self.assertEqual(env['KODEX_FRONTEND_DIST'], str(release / 'frontend'))

    def test_rollback_requires_explicit_data_compatibility_acknowledgment(self):
        with self.assertRaisesRegex(service.ServiceError, 'data-compatible'):
            self.app.rollback(False)

    def test_other_installation_cannot_be_stopped(self):
        from types import SimpleNamespace
        result = SimpleNamespace(returncode=0, stdout='working directory = /another/root\n pid = 123\n')
        with patch.object(service.subprocess, 'run', return_value=result), \
             patch.object(service, 'run') as mutation:
            with self.assertRaisesRegex(service.ServiceError, 'another installation'):
                self.app.stop()
        mutation.assert_not_called()

    def test_other_installation_autostart_cannot_be_removed(self):
        self.app.login_plist.parent.mkdir()
        self.app.login_plist.write_bytes(service.plistlib.dumps({'WorkingDirectory': '/another/root'}))
        with self.assertRaisesRegex(service.ServiceError, 'another installation'):
            self.app.autostart(False)
        self.assertTrue(self.app.login_plist.exists())

    def test_build_packages_release_and_forces_same_origin(self):
        repo = self.root / 'repo'
        for folder in ('tools', 'apps/gateway/src', 'apps/web/dist', 'target/release',
                       'plugins/kodex-control', '.agents/plugins'):
            (repo / folder).mkdir(parents=True)
        (repo / 'apps/gateway/src/schema.rs').write_text('APP_SERVER_SCHEMA_VERSION: &str = "0.160.0"')
        for name in service.CONTROLLER_FILES:
            (repo / 'tools' / name).write_text('controller')
        (repo / 'target/release/kodex-gateway').write_text('executable')
        (repo / 'apps/web/dist/index.html').write_text('frontend')
        (repo / '.agents/plugins/marketplace.json').write_text('{}')
        def acquire(version, stage):
            self.assertEqual(version, '0.160.0')
            (stage / 'codex').write_text('native executable')
            return {'asset':'official-package', 'sha256':'verified'}
        with patch.object(service, 'acquire_native', side_effect=acquire), \
             patch.object(service, 'run') as commands, \
             patch.dict(service.os.environ, {'VITE_KODEX_API_BASE_URL': 'http://other-gateway'}):
            release = self.app.build(repo)
        build = next(call for call in commands.call_args_list if call.args[0][:3] == ['npm', 'run', 'build'])
        self.assertEqual(build.kwargs['env']['VITE_KODEX_API_BASE_URL'], '')
        self.assertEqual((release / 'frontend/index.html').read_text(), 'frontend')
        self.assertTrue((release / 'marketplace/.agents/plugins/marketplace.json').is_file())
        self.assertEqual((release / 'codex').read_text(), 'native executable')
        for name in service.CONTROLLER_FILES:
            self.assertEqual((release / name).read_text(), 'controller')

    def frontend_fixture(self):
        old, previous = self.release('old'), self.release('previous')
        service.link(self.app.root / 'current', old)
        service.link(self.app.root / 'previous', previous)
        (old / 'frontend/assets').mkdir()
        (old / 'frontend/assets/old-abcdefgh.js').write_text('old chunk')
        repo = self.root / 'repo'
        for folder in ('apps/gateway/src', 'apps/web/src/api', 'apps/web/dist/assets'):
            (repo / folder).mkdir(parents=True)
        (repo / 'apps/gateway/src/schema.rs').write_text('APP_SERVER_SCHEMA_VERSION: &str = "0.160.0"')
        (repo / 'apps/web/src/api/compatibility.ts').write_text('const API_VERSION = "1" satisfies unknown;')
        (repo / 'apps/web/dist/index.html').write_text('new frontend')
        (repo / 'apps/web/dist/assets/new-abcdefgh.js').write_text('new chunk')
        return old, previous, repo

    def fake_swap(self, left, right):
        temporary = left.with_name('.test-swap')
        left.rename(temporary)
        right.rename(left)
        temporary.rename(right)

    def test_frontend_update_retains_assets_and_never_restarts_or_builds_native(self):
        old, previous, repo = self.frontend_fixture()
        with patch.object(self.app, 'health', return_value=42) as health, \
             patch.object(self.app, 'job', return_value={'pid': 42}), \
             patch.object(service, 'swap_directories', side_effect=self.fake_swap), \
             patch.object(service, 'run') as commands, \
             patch.object(service, 'acquire_native') as native, \
             patch.object(self.app, 'stop') as stop, patch.object(self.app, 'start') as start, \
             patch.dict(service.os.environ, {'VITE_KODEX_API_BASE_URL': 'http://other'}):
            self.app.update_frontend(repo)
        self.assertEqual([call.args[0] for call in commands.call_args_list],
                         [['npm', 'ci'], ['npm', 'run', 'build']])
        self.assertEqual(commands.call_args_list[-1].kwargs['env']['VITE_KODEX_API_BASE_URL'], '')
        self.assertEqual((old / 'frontend/index.html').read_text(), 'new frontend')
        self.assertEqual((old / 'frontend/assets/old-abcdefgh.js').read_text(), 'old chunk')
        self.assertEqual((old / 'frontend/assets/new-abcdefgh.js').read_text(), 'new chunk')
        self.assertEqual((self.app.root / 'current').resolve(), old)
        self.assertEqual((self.app.root / 'previous').resolve(), previous)
        self.assertEqual((old / 'kodex-gateway').read_text(), 'gateway')
        native.assert_not_called()
        stop.assert_not_called()
        start.assert_not_called()
        self.assertEqual(health.call_count, 3)
        for call in health.call_args_list:
            self.assertEqual(call.kwargs['expected_pid'], 42)
            self.assertEqual(call.kwargs['api_version'], '1')

    def test_frontend_failed_health_rolls_back_only_frontend_and_keeps_new_chunks(self):
        old, previous, repo = self.frontend_fixture()
        with patch.object(self.app, 'health', side_effect=[42, 42, service.ServiceError('unhealthy'), 42]), \
             patch.object(self.app, 'job', return_value={'pid': 42}), \
             patch.object(service, 'swap_directories', side_effect=self.fake_swap) as swap, \
             patch.object(service, 'run'), \
             patch.object(self.app, 'stop') as stop, patch.object(self.app, 'start') as start:
            with self.assertRaisesRegex(service.ServiceError, 'rolled back'):
                self.app.update_frontend(repo)
        self.assertEqual(swap.call_count, 2)
        self.assertEqual((old / 'frontend/index.html').read_text(), 'old')
        self.assertEqual((old / 'frontend/assets/new-abcdefgh.js').read_text(), 'new chunk')
        self.assertEqual((self.app.root / 'current').resolve(), old)
        self.assertEqual((self.app.root / 'previous').resolve(), previous)
        stop.assert_not_called()
        start.assert_not_called()

    def test_frontend_build_failure_leaves_index_and_assets_unchanged(self):
        old, _, repo = self.frontend_fixture()
        with patch.object(self.app, 'health', return_value=42), \
             patch.object(self.app, 'job', return_value={'pid': 42}), \
             patch.object(service, 'run', side_effect=service.ServiceError('build failed')), \
             patch.object(service, 'swap_directories') as swap:
            with self.assertRaisesRegex(service.ServiceError, 'build failed'):
                self.app.update_frontend(repo)
        self.assertEqual((old / 'frontend/index.html').read_text(), 'old')
        self.assertFalse((old / 'frontend/assets/new-abcdefgh.js').exists())
        swap.assert_not_called()
        self.assertFalse(any(path.name.startswith('.frontend-') for path in old.iterdir()))

    def test_frontend_schema_mismatch_refuses_before_build(self):
        old, _, repo = self.frontend_fixture()
        (repo / 'apps/gateway/src/schema.rs').write_text('APP_SERVER_SCHEMA_VERSION: &str = "0.999.0"')
        with patch.object(service, 'run') as commands, patch.object(self.app, 'health') as health:
            with self.assertRaisesRegex(service.ServiceError, 'schema'):
                self.app.update_frontend(repo)
        commands.assert_not_called()
        health.assert_not_called()
        self.assertEqual((old / 'frontend/index.html').read_text(), 'old')

    def test_retained_asset_copy_failure_never_publishes_partial_chunk(self):
        old, _, repo = self.frontend_fixture()
        new = repo / 'apps/web/dist'
        def fail(source, target):
            Path(target).write_text('partial')
            raise OSError('copy failed')
        with patch.object(service.shutil, 'copy2', side_effect=fail):
            with self.assertRaisesRegex(OSError, 'copy failed'):
                service.retain_frontend_assets(new, old / 'frontend')
        self.assertFalse((old / 'frontend/assets/new-abcdefgh.js').exists())
        self.assertFalse(any((old / 'frontend/assets').glob('.asset-*')))
        self.assertEqual((old / 'frontend/assets/old-abcdefgh.js').read_text(), 'old chunk')

    def test_frontend_asset_collision_refuses_without_overwriting_live_files(self):
        old, _, repo = self.frontend_fixture()
        (repo / 'apps/web/dist/assets/old-abcdefgh.js').write_text('different content')
        with patch.object(self.app, 'health', return_value=42), \
             patch.object(self.app, 'job', return_value={'pid': 42}), \
             patch.object(service, 'run'), patch.object(service, 'swap_directories') as swap:
            with self.assertRaisesRegex(service.ServiceError, 'collision'):
                self.app.update_frontend(repo)
        self.assertEqual((old / 'frontend/assets/old-abcdefgh.js').read_text(), 'old chunk')
        self.assertEqual((old / 'frontend/index.html').read_text(), 'old')
        swap.assert_not_called()

    def test_login_port_conflict_never_executes_gateway(self):
        release = self.release('new')
        service.link(self.app.root / 'current', release)
        with patch.object(service, 'check_port', side_effect=service.ServiceError('already in use')), \
             patch.object(service.os, 'execve') as execute:
            self.app.execute()
        execute.assert_not_called()

    def test_stop_waits_for_owned_process_without_killing_listener(self):
        with patch.object(self.app, 'job', return_value={'pid': 123}), \
             patch.object(service, 'run') as commands, \
             patch.object(service.os, 'kill', side_effect=[None, ProcessLookupError]) as probe, \
             patch.object(service.time, 'sleep'):
            self.app.stop()
        commands.assert_called_once_with([service.LAUNCHCTL, 'bootout', self.app.target])
        self.assertEqual(probe.call_args_list, [unittest.mock.call(123, 0), unittest.mock.call(123, 0)])

    def test_wrong_native_version_refuses_build_before_commands(self):
        repo = self.root / 'repo'
        (repo / 'apps/gateway/src').mkdir(parents=True)
        (repo / 'apps/gateway/src/schema.rs').write_text('APP_SERVER_SCHEMA_VERSION: &str = "0.160.0"')
        with patch.object(service, 'acquire_native', side_effect=service.ServiceError('version mismatch')), \
             patch.object(service, 'run') as commands:
            with self.assertRaisesRegex(service.ServiceError, 'version mismatch'):
                self.app.build(repo)
        commands.assert_not_called()

    def health_fixture(self, instance='owned', ready=True):
        import io
        from types import SimpleNamespace
        release = self.release('health')
        (self.root / 'data').mkdir()
        (self.root / 'data/instance.json').write_text(json.dumps({'id': 'owned'}))
        responses = {
            '/v1/capabilities': json.dumps({'gateway': {'instanceId': instance, 'apiVersion': '1'}, 'appServer': {
                'schemaVersion': '0.160.0', 'detectedVersionMatchesSchema': True}}).encode(),
            '/readyz': json.dumps({'ready': ready}).encode(), '/': b'health',
        }
        opener = SimpleNamespace(open=lambda url, timeout: io.BytesIO(responses[urllib.parse.urlparse(url).path]))
        return release, opener

    def test_health_requires_ready_native_and_exact_instance(self):
        from types import SimpleNamespace
        for instance, ready in [('other', True), ('owned', False)]:
            with self.subTest(instance=instance, ready=ready):
                if (self.root / 'data').exists():
                    service.shutil.rmtree(self.root / 'data')
                    service.shutil.rmtree(self.app.root / 'releases/health')
                release, opener = self.health_fixture(instance, ready)
                with patch.object(self.app, 'job', return_value={'pid': 42}), \
                     patch.object(service.subprocess, 'run', return_value=SimpleNamespace(stdout='42')), \
                     patch.object(service.urllib.request, 'build_opener', return_value=opener), \
                     patch.object(service.time, 'monotonic', side_effect=[0, 0, 61]), \
                     patch.object(service.time, 'sleep'):
                    with self.assertRaisesRegex(service.ServiceError, 'Health check failed'):
                        self.app.health(release)

    def test_frontend_api_mismatch_fails_before_build(self):
        from types import SimpleNamespace
        release, opener = self.health_fixture()
        service.link(self.app.root / 'current', release)
        repo = self.root / 'repo'
        (repo / 'apps/gateway/src').mkdir(parents=True)
        (repo / 'apps/web/src/api').mkdir(parents=True)
        (repo / 'apps/gateway/src/schema.rs').write_text('APP_SERVER_SCHEMA_VERSION: &str = "0.160.0"')
        (repo / 'apps/web/src/api/compatibility.ts').write_text('const API_VERSION = "future";')
        with patch.object(self.app, 'job', return_value={'pid': 42}), \
             patch.object(service.subprocess, 'run', return_value=SimpleNamespace(stdout='42')), \
             patch.object(service.urllib.request, 'build_opener', return_value=opener), \
             patch.object(service, 'run') as commands:
            with self.assertRaisesRegex(service.ServiceError, 'API version'):
                self.app.update_frontend(repo)
        commands.assert_not_called()
        self.assertEqual((release / 'frontend/index.html').read_text(), 'health')

    def test_frontend_health_rejects_pid_change_immediately(self):
        release, opener = self.health_fixture()
        with patch.object(self.app, 'job', return_value={'pid': 43}), \
             patch.object(service.urllib.request, 'build_opener', return_value=opener), \
             patch.object(service.time, 'sleep') as sleep:
            with self.assertRaisesRegex(service.ServiceError, 'PID changed'):
                self.app.health(release, expected_pid=42, api_version='1')
        sleep.assert_not_called()

    @unittest.skipUnless(service.sys.platform == 'darwin', 'macOS atomic exchange')
    def test_real_atomic_exchange_of_existing_frontend_directories(self):
        left, right = self.root / 'frontend', self.root / 'stage'
        left.mkdir()
        right.mkdir()
        (left / 'index.html').write_text('old')
        (right / 'index.html').write_text('new')
        service.swap_directories(left, right)
        self.assertEqual((left / 'index.html').read_text(), 'new')
        self.assertEqual((right / 'index.html').read_text(), 'old')
        service.swap_directories(left, right)
        self.assertEqual((left / 'index.html').read_text(), 'old')

    def test_frontend_interrupt_after_swap_restores_frontend(self):
        old, _, repo = self.frontend_fixture()
        with patch.object(self.app, 'health', side_effect=[42, 42, KeyboardInterrupt(), 42]), \
             patch.object(self.app, 'job', return_value={'pid': 42}), \
             patch.object(service, 'swap_directories', side_effect=self.fake_swap) as swap, \
             patch.object(service, 'run'), patch.object(self.app, 'stop') as stop:
            with self.assertRaises(KeyboardInterrupt):
                self.app.update_frontend(repo)
        self.assertEqual(swap.call_count, 2)
        self.assertEqual((old / 'frontend/index.html').read_text(), 'old')
        stop.assert_not_called()

    def test_frontend_failed_rollback_keeps_original_frontend_backup(self):
        old, _, repo = self.frontend_fixture()
        def swap(left, right):
            if self.actions:
                raise OSError('exchange refused')
            self.fake_swap(left, right)
            self.actions.append('swapped')
        with patch.object(self.app, 'health', side_effect=[42, 42, service.ServiceError('unhealthy')]), \
             patch.object(self.app, 'job', return_value={'pid': 42}), \
             patch.object(service, 'swap_directories', side_effect=swap), patch.object(service, 'run'):
            with self.assertRaisesRegex(service.ServiceError, 'rollback failed'):
                self.app.update_frontend(repo)
        backups = list(old.glob('.frontend-*/frontend/index.html'))
        self.assertEqual(len(backups), 1)
        self.assertEqual(backups[0].read_text(), 'old')
        self.assertEqual((old / 'frontend/index.html').read_text(), 'new frontend')

    def test_health_accepts_owned_ready_release(self):
        from types import SimpleNamespace
        release, opener = self.health_fixture()
        with patch.object(self.app, 'job', return_value={'pid': 42}), \
             patch.object(service.subprocess, 'run', return_value=SimpleNamespace(stdout='42')), \
             patch.object(service.urllib.request, 'build_opener', return_value=opener):
            self.app.health(release)

    def official_archive(self, missing_host=False, unsafe=False):
        stream = io.BytesIO()
        with tarfile.open(fileobj=stream, mode='w:gz') as archive:
            files = {
                'codex-package.json': json.dumps({'layoutVersion':1,'version':'0.160.0',
                    'target':'aarch64-apple-darwin','variant':'codex','entrypoint':'bin/codex',
                    'resourcesDir':'codex-resources','pathDir':'codex-path'}),
                'bin/codex':'native executable', 'codex-path/rg':'search',
                'codex-resources/zsh/bin/zsh':'shell',
            }
            if not missing_host: files['bin/codex-code-mode-host'] = 'helper'
            if unsafe: files['../escape'] = 'escape'
            for name, content in files.items():
                data = content.encode()
                info = tarfile.TarInfo(name); info.size = len(data); info.mode = 0o755
                archive.addfile(info, io.BytesIO(data))
        return stream.getvalue()

    def acquire_fixture(self, data, digest=None):
        stage = self.root / 'stage'; stage.mkdir()
        expected = digest or hashlib.sha256(data).hexdigest()
        with patch.object(service.platform, 'machine', return_value='arm64'), \
             patch.dict(service.OFFICIAL_PACKAGE_SHA256, {'0.160.0': {'aarch64-apple-darwin': expected}}), \
             patch.object(service.urllib.request, 'urlopen', return_value=io.BytesIO(data)) as download, \
             patch.object(service, 'native_version', return_value='0.160.0'), \
             patch.object(service, 'run') as run:
            provenance = service.acquire_native('0.160.0', stage)
        return stage, provenance, download, run

    def test_official_pinned_distribution_includes_helper_and_native_resources(self):
        data = self.official_archive()
        stage, provenance, download, run = self.acquire_fixture(data)
        self.assertEqual((stage / 'codex').resolve(), stage / 'native/bin/codex')
        self.assertEqual((stage / 'native/bin/codex-code-mode-host').read_text(), 'helper')
        self.assertEqual((stage / 'native/codex-path/rg').read_text(), 'search')
        self.assertEqual((stage / 'native/codex-resources/zsh/bin/zsh').read_text(), 'shell')
        self.assertEqual(provenance['asset'], 'codex-package-aarch64-apple-darwin.tar.gz')
        self.assertEqual(provenance['sha256'], hashlib.sha256(data).hexdigest())
        self.assertIn('/openai/codex/releases/download/rust-v0.160.0/', download.call_args.args[0])
        self.assertEqual(run.call_args.args[0], [stage / 'native/bin/codex-code-mode-host', '--help'])
        self.assertEqual(run.call_args.kwargs['env']['CODEX_HOME'].startswith(str(stage)), False)

    def test_corrupt_download_is_rejected_before_extraction_or_execution(self):
        with self.assertRaisesRegex(service.ServiceError, 'checksum'):
            self.acquire_fixture(self.official_archive(), '0' * 64)
        self.assertFalse((self.root / 'stage/native').exists())

    def test_official_package_without_helper_is_rejected(self):
        with self.assertRaisesRegex(service.ServiceError, 'codex-code-mode-host'):
            self.acquire_fixture(self.official_archive(missing_host=True))

    def test_unsafe_official_archive_path_is_rejected(self):
        with self.assertRaisesRegex(service.ServiceError, 'archive'):
            self.acquire_fixture(self.official_archive(unsafe=True))
        self.assertFalse((self.root / 'escape').exists())

    def test_unpinned_version_never_downloads(self):
        with patch.object(service.urllib.request, 'urlopen') as download:
            with self.assertRaisesRegex(service.ServiceError, 'pinned'):
                service.acquire_native('0.999.0', self.root)
        download.assert_not_called()

    def test_corrupt_download_leaves_the_live_release_running(self):
        old = self.release('old')
        service.link(self.app.root / 'current', old)
        repo = self.root / 'repo'
        (repo / 'apps/gateway/src').mkdir(parents=True)
        (repo / 'apps/gateway/src/schema.rs').write_text('APP_SERVER_SCHEMA_VERSION: &str = "0.160.0"')
        with patch.object(service.platform, 'machine', return_value='arm64'), \
             patch.object(service.urllib.request, 'urlopen', return_value=io.BytesIO(b'corrupt')), \
             patch.object(self.app, 'stop') as stop:
            with self.assertRaisesRegex(service.ServiceError, 'checksum'):
                self.app.update(repo)
        stop.assert_not_called()
        self.assertEqual((self.app.root / 'current').resolve(), old)
        self.assertFalse(any(path.name.startswith('.stage-') for path in old.parent.iterdir()))

    def test_failed_helper_startup_leaves_the_live_release_running(self):
        old = self.release('old')
        service.link(self.app.root / 'current', old)
        repo = self.root / 'repo'
        (repo / 'apps/gateway/src').mkdir(parents=True)
        (repo / 'apps/gateway/src/schema.rs').write_text('APP_SERVER_SCHEMA_VERSION: &str = "0.160.0"')
        data = self.official_archive()
        with patch.object(service.platform, 'machine', return_value='arm64'), \
             patch.dict(service.OFFICIAL_PACKAGE_SHA256, {'0.160.0': {'aarch64-apple-darwin': hashlib.sha256(data).hexdigest()}}), \
             patch.object(service.urllib.request, 'urlopen', return_value=io.BytesIO(data)), \
             patch.object(service, 'native_version', return_value='0.160.0'), \
             patch.object(service, 'run', side_effect=service.subprocess.CalledProcessError(1, 'host')), \
             patch.object(self.app, 'stop') as stop:
            with self.assertRaises(service.subprocess.CalledProcessError):
                self.app.update(repo)
        stop.assert_not_called()
        self.assertEqual((self.app.root / 'current').resolve(), old)

    def test_explicit_rollback_swaps_releases_without_touching_data(self):
        old, new = self.release('old'), self.release('new')
        service.link(self.app.root / 'previous', old)
        service.link(self.app.root / 'current', new)
        data = self.root / 'data'
        data.mkdir()
        (data / 'gateway.db').write_bytes(b'preserve current storage')
        with patch.object(self.app, 'stop', side_effect=lambda: self.actions.append('stop')), \
             patch.object(self.app, 'start', side_effect=lambda: self.actions.append('start')):
            self.app.rollback(True)
        self.assertEqual(self.actions, ['stop', 'start'])
        self.assertEqual((self.app.root / 'current').resolve(), old)
        self.assertEqual((self.app.root / 'previous').resolve(), new)
        self.assertEqual((data / 'gateway.db').read_bytes(), b'preserve current storage')


if __name__ == '__main__':
    unittest.main()
