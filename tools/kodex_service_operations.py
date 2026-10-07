"""Durable one-shot launchd jobs, independent of the gateway and its callers."""
import json
import os
from pathlib import Path
import plistlib
import re
import shutil
import subprocess
import sys
import time
import uuid

CONTROLLER_FILES = ('kodex-service', 'kodex_service_cli.py', 'kodex_service_operations.py')
TERMINAL = ('succeeded', 'failed')


class Operations:
    def __init__(self, app, controller, runtime):
        self.app = app
        self.controller = Path(controller).resolve()
        self.runtime = runtime
        self.directory = app.root / 'operations'

    def _path(self, job_id):
        if not re.fullmatch(r'[a-f0-9]{32}', job_id):
            raise self.runtime['ServiceError']('Invalid operation ID')
        return self.directory / job_id

    def _save(self, job):
        path = self._path(job['id']) / 'job.json'
        temporary = path.with_suffix('.new')
        temporary.write_text(json.dumps(job, indent=2) + '\n')
        temporary.chmod(0o600)
        temporary.replace(path)

    def status(self, job_id=None):
        if job_id is None:
            latest = self.directory / 'latest'
            if not latest.exists():
                return None
            job_id = latest.read_text().strip()
        job = json.loads((self._path(job_id) / 'job.json').read_text())
        if job['state'] not in TERMINAL:
            try:
                with self.runtime['locked'](self.app.root):
                    job = json.loads((self._path(job_id) / 'job.json').read_text())
                    self._recover(job)
            except self.runtime['ServiceError']:
                pass
        return job

    def _recover(self, job):
        # Owning the management lock proves a worker is not executing an action.
        if job['state'] == 'running':
            job.update(state='failed', error='Operation worker was interrupted; inspect logs before retrying')
            self._save(job)
        elif job['state'] == 'queued' and time.time() - job['createdAt'] > 30:
            probe = subprocess.run([self.runtime['LAUNCHCTL'], 'print',
                                    f"{self.app.domain}/{job['label']}"],
                                   capture_output=True, text=True)
            if probe.returncode or not re.search(r'\bpid = \d+', probe.stdout):
                job.update(state='failed', error='Operation worker is unavailable; no automatic retry')
                self._save(job)

    def assert_idle(self):
        job = self.status()
        if job and job['state'] not in TERMINAL:
            self._recover(job)
            if job['state'] not in TERMINAL:
                raise self.runtime['ServiceError'](
                    f"Service operation {job['id']} is in progress; use operation-status {job['id']}")

    def submit(self, action, repo=None, data_compatible=False):
        if action not in ('update', 'restart', 'rollback'):
            raise self.runtime['ServiceError']('Unknown service operation')
        if action == 'rollback' and not data_compatible:
            raise self.runtime['ServiceError']('Rollback requires --data-compatible after reviewing storage compatibility')
        if action == 'update' and repo is None:
            raise self.runtime['ServiceError']('Update requires a source checkout')
        self.assert_idle()
        config = self.app.config()
        job_id = uuid.uuid4().hex
        path = self._path(job_id)
        path.mkdir(parents=True, mode=0o700)
        self.directory.chmod(0o700)
        for name in CONTROLLER_FILES:
            shutil.copy2(self.controller.parent / name, path / name)
        log = path / 'job.log'
        log.touch(mode=0o600)
        job = {'id': job_id, 'action': action, 'state': 'queued',
               'repo': str(Path(repo).expanduser().resolve()) if repo is not None else None,
               'dataCompatible': data_compatible, 'logPath': str(log),
               'error': None, 'release': None, 'createdAt': time.time(),
               'label': f'dev.kodex.operation.{job_id}'}
        self._save(job)
        latest = self.directory / 'latest.new'
        latest.write_text(job_id + '\n')
        latest.replace(self.directory / 'latest')
        environment = {key: os.environ[key] for key in ('HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG')
                       if key in os.environ}
        environment.update(PATH=config['path'], PYTHONUNBUFFERED='1')
        plist = {'Label': job['label'], 'RunAtLoad': True, 'KeepAlive': False,
                 'ProgramArguments': [sys.executable, str(path / 'kodex-service'),
                                      '--root', str(self.app.root), '_operation-run', job_id],
                 'WorkingDirectory': str(self.app.root), 'EnvironmentVariables': environment,
                 'StandardOutPath': str(log), 'StandardErrorPath': str(log)}
        definition = path / 'worker.plist'
        definition.write_bytes(plistlib.dumps(plist))
        definition.chmod(0o600)
        try:
            self.runtime['run']([self.runtime['LAUNCHCTL'], 'bootstrap', self.app.domain, definition])
        except BaseException as error:
            # An interrupted observer does not cancel an already accepted worker.
            probe = subprocess.run([self.runtime['LAUNCHCTL'], 'print',
                                    f"{self.app.domain}/{job['label']}"], capture_output=True)
            if probe.returncode:
                job.update(state='failed', error=str(error) or type(error).__name__)
                self._save(job)
            raise
        return job

    def execute(self, job_id):
        with self.runtime['locked'](self.app.root, wait=True):
            job = self.status(job_id)
            if job['state'] in TERMINAL:
                return job
            if job['state'] != 'queued':
                job.update(state='failed', error='Operation worker was interrupted; no automatic retry')
                self._save(job)
                return job
            job.update(state='running', startedAt=time.time())
            self._save(job)
            try:
                print(f"Starting {job['action']} operation {job_id}", flush=True)
                if job['action'] == 'update':
                    self.app.update(Path(job['repo']))
                elif job['action'] == 'restart':
                    self.app.stop()
                    self.app.start()
                elif job['action'] == 'rollback':
                    self.app.rollback(job['dataCompatible'])
                else:
                    raise self.runtime['ServiceError']('Unknown service operation')
                job.update(state='succeeded')
            except BaseException as error:
                job.update(state='failed', error=str(error) or type(error).__name__)
                print(f"Operation failed: {job['error']}", file=sys.stderr, flush=True)
            current = self.app.root / 'current'
            job.update(release=str(current.resolve()) if current.exists() else None,
                       finishedAt=time.time())
            self._save(job)
            print(f"Operation {job_id}: {job['state']}", flush=True)
            return job

    def wait(self, job_id):
        # Observing a job never owns the service lock or its lifetime.
        log = Path(self.status(job_id)['logPath'])
        with log.open(errors='replace') as output:
            while True:
                chunk = output.read()
                if chunk:
                    print(chunk, end='', flush=True)
                job = self.status(job_id)
                if job['state'] in TERMINAL:
                    print(output.read(), end='', flush=True)
                    return job
                time.sleep(0.5)
