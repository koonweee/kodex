"""Command dispatch; disruptive actions always belong to independent workers."""
import argparse
import json
import os
from pathlib import Path
import sys


def main(runtime, argv=None):
    parser = argparse.ArgumentParser(description=runtime['__doc__'])
    parser.add_argument('--root', type=Path, default=Path.home() / '.local/share/kodex')
    commands = parser.add_subparsers(dest='command', required=True)
    install = commands.add_parser('install', help='configure and schedule initial build/start; autostart initially off')
    install.add_argument('--port', type=int, default=8787)
    install.add_argument('--data-dir', type=Path, default=Path.home() / '.kodex/native-v1')
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
    if sys.platform != 'darwin' or os.getuid() == 0:
        raise error('Run as your normal logged-in macOS user, not root')
    app = runtime['Service'](args.root)
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
        runtime['run'](['/usr/bin/tail', '-n', '100', '-F', app.root / 'logs/gateway.log',
                        app.root / 'logs/gateway-error.log'])
        return
    if args.command == 'status':
        print(json.dumps({'job': app.job(), 'autostart': app.login_plist.exists(),
                          'current': str((app.root / 'current').resolve()),
                          'url': f"http://127.0.0.1:{app.config()['port']}"}, indent=2))
        return
    with runtime['locked'](app.root):
        if args.command == 'install':
            operations.assert_idle()
            if app.config_path.exists():
                raise error('Already configured; use update --repo /path/to/kodex')
            if app.job() is not None or app.login_plist.exists():
                raise error('A Kodex launchd installation already exists; use its management command')
            runtime['check_port'](args.port)
            app.config_path.write_text(json.dumps({
                'port': args.port, 'data_dir': str(args.data_dir.expanduser().resolve()),
                'path': os.environ.get('PATH', '/usr/bin:/bin'), 'environment': {},
                'repo': str((args.repo or Path(runtime['__file__']).resolve().parent.parent).resolve()),
            }, indent=2) + '\n')
            app.config_path.chmod(0o600)
            app.config()
            runtime['link'](app.root / 'kodex-service', app.root / 'controller/kodex-service')
            app.write_plist()
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
