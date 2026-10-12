"""Command dispatch; disruptive actions always belong to independent workers."""
import argparse
import json
import os
from pathlib import Path
import sys


def main(runtime, argv=None):
    parser = argparse.ArgumentParser(description=runtime['__doc__'])
    parser.add_argument('--root', type=Path)
    parser.add_argument('--role', choices=['executor', 'federator'])
    commands = parser.add_subparsers(dest='command', required=True)
    install = commands.add_parser('install', help='configure and schedule initial build/start; autostart initially off')
    install.add_argument('--port', type=int)
    install.add_argument('--sandbox-port', type=int, default=8790)
    install.add_argument('--public-origin')
    install.add_argument('--sandbox-public-url')
    install.add_argument('--data-dir', type=Path)
    for command in ('install', 'update', 'update-frontend'):
        sub = install if command == 'install' else commands.add_parser(command)
        sub.add_argument('--repo', type=Path)
        if command != 'update-frontend':
            sub.add_argument('--wait', action='store_true', help='follow logs until the independent job completes')
    for command in ('start', 'stop', 'status', 'logs', '_run'):
        commands.add_parser(command)
    commands.add_parser('restart').add_argument('--wait', action='store_true')
    commands.add_parser('autostart').add_argument('setting', choices=['on', 'off'])
    rollback = commands.add_parser('rollback')
    rollback.add_argument('--data-compatible', action='store_true')
    rollback.add_argument('--wait', action='store_true')
    commands.add_parser('operation-status').add_argument('id', nargs='?')
    commands.add_parser('operation-wait').add_argument('id', nargs='?')
    commands.add_parser('_operation-run', help=argparse.SUPPRESS).add_argument('id')
    args = parser.parse_args(argv)
    error = runtime['ServiceError']
    if sys.platform not in ('darwin', 'linux') or os.getuid() == 0:
        raise error('Run as your normal macOS or Linux user, not root')
    root = args.root
    if root is None:
        invoked_root = Path(sys.argv[0]).expanduser().absolute().parent
        if (invoked_root / 'config.json').exists():
            root = invoked_root
        else:
            if args.role is None:
                raise error('--role executor or --role federator is required for a fresh installation')
            root = Path.home() / '.local/share/kodex' / args.role
    role = args.role
    config_path = root.expanduser() / 'config.json'
    if role is None and config_path.exists():
        role = json.loads(config_path.read_text()).get('role')
    if role is None:
        raise error('--role executor or --role federator is required')
    if args.command == 'install':
        args.port = args.port or (8789 if role == 'executor' else 8787)
        args.data_dir = args.data_dir or Path.home() / '.kodex' / f'federated-v1/{role}'
    app = runtime['Service'](root, role=role)
    operations = runtime['Operations'](app, Path(runtime['__file__']), runtime)
    if args.command == '_run':
        app.execute()
        return
    if args.command == '_operation-run':
        job = operations.execute(args.id)
        if job['state'] != 'succeeded':
            raise error(job['error'])
        return
    if args.command in ('operation-status', 'operation-wait'):
        job = operations.status(args.id)
        if args.command == 'operation-wait':
            if job is None:
                raise error('No service operation has been submitted')
            job = operations.wait(job['id'])
        print(json.dumps(job, indent=2))
        if args.command == 'operation-wait' and job['state'] != 'succeeded':
            raise error(job['error'])
        return
    if args.command == 'logs':
        names = ('service.log', 'service-error.log')
        runtime['run'](['/usr/bin/tail', '-n', '100', '-F',
                        app.root / 'logs' / names[0], app.root / 'logs' / names[1]])
        return
    if args.command == 'status':
        config = app.config()
        url = (config['public_origin'] if app.role == 'federator'
               else f"http://127.0.0.1:{config['port']}")
        print(json.dumps({'role': app.role, 'job': app.job(), 'autostart': app.autostart_enabled(),
                          'current': str((app.root / 'current').resolve()),
                          'url': url}, indent=2))
        return
    with runtime['locked'](app.root):
        if args.command == 'install':
            operations.assert_idle()
            if app.config_path.exists():
                raise error('Already configured; use update --repo /path/to/kodex')
            if app.job() is not None or app.login_plist.exists():
                raise error('A Kodex service-manager installation already exists; use its management command')
            runtime['check_port'](args.port)
            if role == 'federator':
                runtime['check_port'](args.sandbox_port)
            config = {
                'role': role, 'port': args.port, 'data_dir': str(args.data_dir.expanduser().resolve()),
                'path': os.environ.get('PATH', '/usr/bin:/bin'), 'environment': {},
                'repo': str((args.repo or Path(runtime['__file__']).resolve().parent.parent).resolve()),
                **({'sandbox_port': args.sandbox_port,
                    'public_origin': args.public_origin or f'http://localhost:{args.port}',
                    'sandbox_public_url': args.sandbox_public_url
                        or f'http://localhost:{args.sandbox_port}/app-surface-sandbox.html'}
                   if role == 'federator' else {}),
            }
            app.validate_config(config)
            bootstrapped = False
            try:
                app.bootstrap_controller(runtime['__file__'])
                bootstrapped = True
                staged_config = app.config_path.with_suffix('.new')
                staged_config.write_text(json.dumps(config, indent=2) + '\n')
                staged_config.chmod(0o600)
                staged_config.replace(app.config_path)
                app.write_plist()
            except BaseException:
                app.config_path.unlink(missing_ok=True)
                app.config_path.with_suffix('.new').unlink(missing_ok=True)
                app.definition.unlink(missing_ok=True)
                if bootstrapped:
                    app.remove_bootstrap_controller()
                raise
        if args.command in ('install', 'update', 'restart', 'rollback'):
            action = 'update' if args.command == 'install' else args.command
            repo = (args.repo or Path(app.config()['repo'])) if action == 'update' else None
            job = operations.submit(action, repo=repo, data_compatible=getattr(args, 'data_compatible', False))
        else:
            operations.assert_idle()
            if args.command == 'update-frontend':
                app.update_frontend(args.repo or Path(app.config()['repo']))
            elif args.command == 'start':
                app.start()
            elif args.command == 'stop':
                app.stop()
            elif args.command == 'autostart':
                app.autostart(args.setting == 'on')
            return
    print(json.dumps(job, indent=2), flush=True)
    if args.wait:
        result = operations.wait(job['id'])
        print(json.dumps(result, indent=2))
        if result['state'] != 'succeeded':
            raise error(result['error'])
