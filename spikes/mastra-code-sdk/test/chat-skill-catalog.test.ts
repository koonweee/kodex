import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { activateProfile, resolveProfile } from '../src/profile.js';
import { createChatService } from '../src/chat-service.js';

test('draft catalogs use native discovery in their authoritative scope without creating agent runtimes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'kodex-skill-catalog-'));
  const profile = activateProfile(resolveProfile(join(root, 'profile')));
  const cwd = join(root, 'project'), standalone = join(root, 'standalone');
  await mkdir(cwd); await mkdir(standalone);
  const skill = async (base: string, name: string, description = name) => {
    const path = join(base, '.agents', 'skills', name); await mkdir(path, { recursive: true });
    await writeFile(join(path, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\nPrivate instructions for ${name}.`);
    return path;
  };
  await skill(profile.homeDir, 'global-skill');
  await skill(cwd, 'project-skill');
  await skill(standalone, 'standalone-skill');
  const service = createChatService({ profile, instanceId: 'skills-fixture', directoryHome: standalone,
    projects: [{ id: 'project', name: 'Project', path: cwd, runtimeRoot: join(root, 'runtime') }],
    runtimeFactory: async () => { throw new Error('Draft catalog must not create a runtime'); },
  });
  t.after(async () => { await service.dispose(); await rm(root, { recursive: true, force: true }); });
  const project = await service.listSkills({ projectId: 'project' });
  assert.deepEqual(project.skills.map(row => row.name).sort(), ['global-skill', 'project-skill']);
  assert.doesNotMatch(JSON.stringify(project), /Private instructions/);
  assert.deepEqual((await service.listSkills({ projectId: null })).skills.map(row => row.name).sort(), ['global-skill', 'standalone-skill']);
  await skill(cwd, 'new-skill');
  assert.ok((await service.listSkills({ projectId: 'project' })).skills.some(row => row.name === 'new-skill'), 'subsequent reads refresh from native disk discovery');
  await assert.rejects(service.listSkills({ projectId: 'missing' }), { code: 'NOT_FOUND' });
});
