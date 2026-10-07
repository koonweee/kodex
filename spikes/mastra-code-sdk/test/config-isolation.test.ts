import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { activateProfile, resolveProfile } from '../src/profile.js';
import { createProjectRuntime, type ProjectRuntime } from '../src/runtime.js';

const configDirectories = ['.kodex-mastra-spike', '.claude', '.agents'];

async function writeSkills(root: string, prefix: string) {
  return Promise.all(configDirectories.map(async (directory, index) => {
    const name = `${prefix}-${index}`;
    const skillPath = join(root, directory, 'skills', name);
    await mkdir(skillPath, { recursive: true });
    await writeFile(join(skillPath, 'SKILL.md'), `---\nname: ${name}\ndescription: Isolation fixture ${name}.\n---\n\nOnly ${name} belongs to this skill.\n`);
    return name;
  }));
}

async function inspectNativeDiscovery(root: string) {
  // This synthetic HOME belongs only to the subprocess fixture. Production
  // keeps HOME unchanged; only supported native homeDir settings are supplied.
  assert.equal(homedir(), join(root, 'outside-home'));
  const profile = activateProfile(resolveProfile(join(root, 'profile')));
  await writeFile(profile.settingsPath, JSON.stringify({ lsp: false, observability: { enabled: false } }));
  const [outsideNames, globalNames] = await Promise.all([
    writeSkills(homedir(), 'outside-home'),
    writeSkills(profile.homeDir, 'profile-global'),
  ]);
  const projects = await Promise.all(['a', 'b'].map(async name => {
    const projectPath = join(root, `project-${name}`);
    const names = await writeSkills(projectPath, `project-${name}`);
    return { projectPath, names, runtimeRoot: join(root, `runtime-${name}`) };
  }));
  const runtimes: ProjectRuntime[] = [];
  try {
    // Both controllers and their sessions coexist in one dedicated profile.
    const results = await Promise.allSettled(projects.map(async project => {
      const runtime = await createProjectRuntime({ projectPath: project.projectPath, runtimeRoot: project.runtimeRoot, profile });
      runtimes.push(runtime);
      const session = await runtime.createSession({
        resourceId: `resource-${project.names[0]}`,
        threadId: `thread-${project.names[0]}`,
      });
      const workspace = session.getWorkspace();
      assert.ok(workspace?.skills, 'the actual native session exposes workspace skills');
      const discovered = await workspace.skills.list();
      const names = discovered.map(skill => skill.name).sort();
      assert.ok(outsideNames.every(name => !names.includes(name)), `outside-home skills leaked into ${project.projectPath}: ${names.join(', ')}`);
      assert.deepEqual(names, [...globalNames, ...project.names].sort(), 'profile globals and only this project’s skills remain discoverable');
      for (const name of names) {
        const skill = await workspace.skills.get(name);
        assert.ok(skill, `native skill ${name} is readable`);
        assert.match(skill.instructions, new RegExp(`Only ${name} belongs`));
      }
      assert.equal(session.state.get().homeDir, profile.homeDir);
      assert.equal(session.state.get().projectPath, project.projectPath);
    }));
    for (const result of results) if (result.status === 'rejected') throw result.reason;
  } finally {
    for (const runtime of runtimes.reverse()) await runtime.dispose();
  }
}

if (process.env.KODEX_SKILL_ISOLATION_FIXTURE === '1') {
  await inspectNativeDiscovery(process.argv[2]!);
} else {
  test('native project sessions discover dedicated profile skills and exclude outside-home skills', { timeout: 60_000 }, async t => {
    const root = await mkdtemp(join(tmpdir(), 'kodex-mastra-skill-isolation-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    await mkdir(join(root, 'outside-home'));
    await promisify(execFile)(process.execPath, ['--import', 'tsx', fileURLToPath(import.meta.url), root], {
      env: { ...process.env, HOME: join(root, 'outside-home'), KODEX_SKILL_ISOLATION_FIXTURE: '1' },
      timeout: 50_000,
      maxBuffer: 1024 * 1024,
    });
  });
}
