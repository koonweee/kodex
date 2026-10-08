/** A read-only native catalog needs no agent Session or conversation history.
 * Reconstruct it for each read so project/profile changes use native discovery
 * directly, without a second cache or a Kodex filesystem watcher.
 */
export async function readNativeSkills(cwd: string, homeDir: string) {
  const { Workspace, LocalSkillSource } = await import('@mastra/core/workspace');
  const { buildSkillPaths } = await import('@mastra/code-sdk/agents/workspace');
  const workspace = new Workspace({
    skills: () => buildSkillPaths(cwd, '.kodex-mastra-spike', homeDir),
    skillSource: new LocalSkillSource({ basePath: cwd }),
  });
  const rows = await workspace.skills!.list();
  return rows.filter(skill => skill['user-invocable'] !== false)
    .map(({ name, description, path }) => ({ name, description, path }));
}

export interface NativeSkillReference { name: string; path: string }
export interface NativeSkillMention extends NativeSkillReference { start: number; end: number }
export interface PreparedNativeSkills { references: NativeSkillReference[]; activation: string }

export async function prepareNativeSkills(session: import('./runtime.js').NativeSession, references: NativeSkillReference[]): Promise<PreparedNativeSkills> {
  const { ORPCError } = await import('@orpc/server');
  const { formatSkillActivation } = await import('@mastra/core/workspace');
  const skills = session.getWorkspace()?.skills;
  if (!skills) throw new ORPCError('BAD_REQUEST', { message: 'Skills are unavailable for this chat.' });
  // Public list initializes the dynamic skill roots; refresh alone does not.
  await skills.list();
  await skills.refresh();
  const available = await skills.list();
  const selected: NativeSkillReference[] = [], activations: string[] = [];
  for (const reference of references) {
    const metadata = available.find(row => row.path === reference.path && row.name === reference.name && row['user-invocable'] !== false);
    const skill = metadata ? await skills.get(metadata.path) : null;
    if (!skill || skill['user-invocable'] === false) throw new ORPCError('BAD_REQUEST', { message: 'A selected skill is no longer available. Select it again before sending.' });
    if (selected.some(row => row.path === reference.path)) continue;
    selected.push({ name: skill.name, path: skill.path });
    // Same native activation formatter and wrapper as the SDK's ACP client.
    activations.push(`<skill name="${skill.name}">\n${formatSkillActivation(skill).replaceAll('</skill>', '&lt;/skill&gt;')}\n</skill>`);
  }
  return { references: selected, activation: activations.join('\n\n') };
}
