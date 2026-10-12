"""Role/platform packaging tests; no host service manager is touched."""
import importlib.machinery
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
import urllib.parse
import urllib.request
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[1] / 'kodex-service'
loader = importlib.machinery.SourceFileLoader('kodex_service_roles', str(SOURCE))
spec = importlib.util.spec_from_loader(loader.name, loader)
service = importlib.util.module_from_spec(spec)
loader.exec_module(service)


class RoleLifecycleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()

    def app(self, role, platform_name='darwin'):
        root = self.root / role
        root.mkdir()
        agents = self.root / 'agents'
        units = self.root / 'units'
        app = service.Service(root, agents, platform_name=platform_name, role=role,
                              units=units)
        config = {
            'role': role,
            'port': 18787 if role == 'executor' else 18789,
            'data_dir': str(self.root / f'{role}-data'),
            'path': '/usr/bin:/bin',
            'environment': {},
        }
        if role == 'federator':
            config.update(sandbox_port=18790,
                          public_origin='https://kodex.example.ts.net',
                          sandbox_public_url='https://kodex-sandbox.example.ts.net/app-surface-sandbox.html')
        app.config_path.write_text(json.dumps(config))
        return app

    def release(self, app):
        release = app.root / 'releases/release'
        release.mkdir(parents=True)
        (release / 'manifest.json').write_text(json.dumps({'role': app.role,
                                                            'schema_version': '0.160.0'}))
        if app.role == 'executor':
            (release / 'kodex-gateway').write_text('gateway')
            (release / 'codex').write_text('codex')
        else:
            (release / 'kodex-federator').write_text('federator')
            (release / 'frontend').mkdir()
            (release / 'frontend/index.html').write_text('frontend')
            (release / 'frontend/app-surface-sandbox.html').write_text('sandbox')
        return release

    def federator_opener(self, expected_primary_host, expected_sandbox_host):
        requests = []
        responses = {
            '/healthz': json.dumps({'ready': True, 'service': 'kodex-federator'}).encode(),
            '/': b'frontend',
            '/app-surface-sandbox.html': b'sandbox',
        }

        class Opener:
            def open(self, request, timeout):
                requests.append(request)
                path = urllib.parse.urlsplit(request.full_url).path
                expected = expected_sandbox_host if path == '/app-surface-sandbox.html' \
                    else expected_primary_host
                if request.get_header('Host') != expected:
                    raise AssertionError(f'wrong Host for {path}: {request.get_header("Host")}')
                return io.BytesIO(responses[path])

        return Opener(), requests

    def test_roles_have_distinct_labels_commands_assets_and_environments(self):
        executor = self.app('executor')
        federator = self.app('federator')
        executor_release = self.release(executor)
        federator_release = self.release(federator)

        self.assertEqual(executor.label, 'dev.kodex.executor')
        self.assertEqual(federator.label, 'dev.kodex.federator')
        self.assertEqual(executor.command(executor_release), [executor_release / 'kodex-gateway'])
        self.assertEqual(federator.command(federator_release), [federator_release / 'kodex-federator'])
        executor_env = executor.environment(executor_release)
        federator_env = federator.environment(federator_release)
        self.assertIn('KODEX_CODEX_BINARY', executor_env)
        self.assertNotIn('KODEX_FRONTEND_DIST', executor_env)
        self.assertNotIn('KODEX_CODEX_BINARY', federator_env)
        self.assertEqual(federator_env['KODEX_FRONTEND_DIST'], str(federator_release / 'frontend'))
        self.assertEqual(federator_env['KODEX_FEDERATOR_SANDBOX_BIND'], '127.0.0.1:18790')

    def test_macos_roles_write_independent_launch_agents(self):
        executor = self.app('executor')
        federator = self.app('federator')
        executor.write_service_definition()
        federator.write_service_definition()
        self.assertEqual(executor.definition.name, 'dev.kodex.executor.plist')
        self.assertEqual(federator.definition.name, 'dev.kodex.federator.plist')
        self.assertNotEqual(executor.login_definition, federator.login_definition)

    def test_linux_roles_write_hardened_systemd_user_units(self):
        app = self.app('executor', 'linux')
        app.write_service_definition()
        unit = app.definition.read_text()
        self.assertIn('ExecStart=', unit)
        self.assertIn('Restart=on-failure', unit)
        self.assertIn('WantedBy=default.target', unit)
        self.assertIn('--role executor', unit)
        self.assertNotIn('sudo', unit)

    def test_linux_runtime_packages_are_pinned_for_both_candidate_architectures(self):
        pins = service.OFFICIAL_PACKAGE_SHA256['0.160.0']
        self.assertEqual(len(pins['aarch64-unknown-linux-musl']), 64)
        self.assertEqual(len(pins['x86_64-unknown-linux-musl']), 64)
        with patch.object(service.platform, 'system', return_value='Linux'), \
             patch.object(service.platform, 'machine', return_value='x86_64'):
            self.assertEqual(service.native_target(), 'x86_64-unknown-linux-musl')

    def test_executor_and_federator_build_only_their_owned_artifacts(self):
        repo = self.root / 'repo'
        for folder in ('tools', 'apps/gateway/src', 'apps/federator/src', 'apps/web/dist', 'target/release'):
            (repo / folder).mkdir(parents=True, exist_ok=True)
        (repo / 'apps/gateway/src/schema.rs').write_text(
            'APP_SERVER_SCHEMA_VERSION: &str = "0.160.0"')
        (repo / 'apps/federator/src/trust.rs').write_text(
            'pub const FEDERATOR_API_VERSION: &str = "4";')
        for name in service.CONTROLLER_FILES:
            (repo / 'tools' / name).write_text('controller')
        (repo / 'target/release/kodex-gateway').write_text('gateway')
        (repo / 'target/release/kodex-federator').write_text('federator')
        (repo / 'apps/web/dist/index.html').write_text('frontend')

        executor = self.app('executor')
        with patch.object(service, 'acquire_native', return_value={'asset': 'native'}), \
             patch.object(service, 'run') as commands:
            executor_release = executor.build(repo)
        self.assertTrue((executor_release / 'kodex-gateway').is_file())
        self.assertFalse((executor_release / 'frontend').exists())
        self.assertFalse(any(call.args[0][0] == 'npm' for call in commands.call_args_list))

        federator = self.app('federator')
        with patch.object(service, 'acquire_native') as acquire, \
             patch.object(service, 'run') as commands:
            federator_release = federator.build(repo)
        acquire.assert_not_called()
        self.assertTrue((federator_release / 'kodex-federator').is_file())
        self.assertTrue((federator_release / 'frontend/index.html').is_file())
        self.assertFalse((federator_release / 'codex').exists())
        cargo = [call.args[0] for call in commands.call_args_list if call.args[0][0] == 'cargo']
        self.assertEqual(cargo[0][cargo[0].index('-p') + 1], 'kodex-federator')

    def test_linux_start_and_autostart_use_systemd_user_scope(self):
        app = self.app('executor', 'linux')
        release = self.release(app)
        service.link(app.root / 'current', release)
        with patch.object(app, 'job', return_value=None), \
             patch.object(app, 'health'), patch.object(service, 'check_port'), \
             patch.object(service, 'run') as commands:
            app.start()
        command_args = [call.args[0] for call in commands.call_args_list]
        self.assertIn([service.SYSTEMCTL, '--user', 'daemon-reload'], command_args)
        self.assertIn([service.SYSTEMCTL, '--user', 'start', app.target], command_args)
        with patch.object(service, 'run') as commands:
            app.autostart(True)
        self.assertIn([service.SYSTEMCTL, '--user', 'enable', app.target],
                      [call.args[0] for call in commands.call_args_list])

    def test_linux_update_operation_is_handed_to_systemd_run_with_role(self):
        app = self.app('executor', 'linux')
        app.config_path.write_text(json.dumps({**json.loads(app.config_path.read_text()),
                                               'repo': str(self.root)}))
        operations = service.Operations(app, SOURCE, service.__dict__)
        with patch.object(service, 'run') as launch:
            job = operations.submit('update', repo=self.root)
        command = launch.call_args.args[0]
        self.assertEqual(command[0], '/usr/bin/systemd-run')
        self.assertIn(f'--unit={job["label"]}', command)
        self.assertIn('--role', command)
        self.assertIn('executor', command)

    def test_federator_config_requires_distinct_exact_primary_and_sandbox_origins(self):
        app = self.app('federator')
        base = json.loads(app.config_path.read_text())
        invalid = [
            {'public_origin': 'https://kodex.example.ts.net/path'},
            {'public_origin': 'https://user@kodex.example.ts.net'},
            {'sandbox_public_url': 'https://kodex-sandbox.example.ts.net/other.html'},
            {'sandbox_public_url': 'https://kodex-sandbox.example.ts.net/app-surface-sandbox.html#fragment'},
            {'sandbox_public_url': 'https://kodex.example.ts.net/app-surface-sandbox.html'},
        ]
        for changes in invalid:
            with self.subTest(changes=changes):
                app.config_path.write_text(json.dumps({**base, **changes}))
                with self.assertRaises(service.ServiceError):
                    app.config()

    def test_federator_health_uses_configured_host_headers(self):
        cases = [
            ('https://kodex.example.ts.net',
             'https://kodex-sandbox.example.ts.net/app-surface-sandbox.html',
             'kodex.example.ts.net', 'kodex-sandbox.example.ts.net'),
            ('http://localhost:18789',
             'http://localhost:18790/app-surface-sandbox.html',
             'localhost:18789', 'localhost:18790'),
        ]
        for index, (public, sandbox, primary_host, sandbox_host) in enumerate(cases):
            with self.subTest(public=public):
                root = self.root / f'federator-{index}'
                root.mkdir()
                app = service.Service(root, self.root / 'agents', platform_name='linux',
                                      role='federator', units=self.root / 'units')
                app.config_path.write_text(json.dumps({
                    'role': 'federator', 'port': 18789, 'sandbox_port': 18790,
                    'data_dir': str(self.root / f'federator-data-{index}'),
                    'path': '/usr/bin:/bin', 'environment': {},
                    'public_origin': public, 'sandbox_public_url': sandbox,
                }))
                release = self.release(app)
                opener, requests = self.federator_opener(primary_host, sandbox_host)
                with patch.object(app, 'job', return_value={'pid': 42}), \
                     patch.object(service.urllib.request, 'build_opener', return_value=opener):
                    self.assertEqual(app.health(release), 42)
                self.assertEqual(len(requests), 3)
                self.assertTrue(all(isinstance(request, urllib.request.Request)
                                    for request in requests))

    def test_linux_federator_start_health_does_not_require_lsof(self):
        app = self.app('federator', 'linux')
        release = self.release(app)
        service.link(app.root / 'current', release)
        opener, _ = self.federator_opener('kodex.example.ts.net',
                                          'kodex-sandbox.example.ts.net')
        with patch.object(app, 'job', side_effect=[None, {'pid': 42}]), \
             patch.object(service, 'check_port'), patch.object(service, 'run'), \
             patch.object(service.shutil, 'which', return_value=None), \
             patch.object(service.urllib.request, 'build_opener', return_value=opener):
            app.start()

    def test_supervisor_federator_run_preflights_both_listener_ports(self):
        app = self.app('federator')
        release = self.release(app)
        service.link(app.root / 'current', release)
        with patch.object(service, 'check_port',
                          side_effect=[None, service.ServiceError('sandbox occupied')]) as check, \
             patch.object(service.os, 'execve') as execute:
            app.execute()
        self.assertEqual([call.args[0] for call in check.call_args_list], [18789, 18790])
        execute.assert_not_called()

    def test_frontend_revision_changes_for_sandbox_only_update(self):
        first = self.root / 'first'
        second = self.root / 'second'
        first.mkdir()
        second.mkdir()
        for folder in (first, second):
            (folder / 'index.html').write_text('same primary')
        (first / 'app-surface-sandbox.html').write_text('old sandbox')
        (second / 'app-surface-sandbox.html').write_text('new sandbox')
        self.assertNotEqual(service.frontend_revision(first), service.frontend_revision(second))


if __name__ == '__main__':
    unittest.main()
