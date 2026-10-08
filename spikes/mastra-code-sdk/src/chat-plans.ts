import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { isPlanFilePath, readPlanFile, resolvePlanPath, type LocalPlansOptions } from '@mastra/code-sdk/utils/plans';
import { ORPCError } from '@orpc/server';

export interface NativePlanReadInput extends LocalPlansOptions {
  projectPath: string;
  submittedPath: string;
}
export interface NativePlanPreview { path: string; title: string; plan: string; version: string }
const MAX_PLAN_BYTES = 1024 * 1024;
const invalid = (message: string) => new ORPCError('BAD_REQUEST', { message });

async function checkPlanFile(path: string) {
  const info = await stat(path).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') throw new ORPCError('NOT_FOUND', { message: 'The native plan file was not found.' });
    throw invalid('The native plan file could not be inspected.');
  });
  if (!info.isFile()) throw invalid('The native plan path must name a regular file.');
  if (info.size > MAX_PLAN_BYTES) throw invalid('The native plan file exceeds the 1 MiB preview limit.');
}

/** Native lexical plan scope and parser; this is a local file read, not a sandbox. */
export async function readNativePlan(input: NativePlanReadInput): Promise<NativePlanPreview> {
  if (!input || typeof input.projectPath !== 'string' || !input.projectPath.trim()
    || typeof input.submittedPath !== 'string' || !input.submittedPath.trim() || input.submittedPath.includes('\0')) {
    throw invalid('Provide a project path and a native plan file path.');
  }
  const projectPath = resolve(input.projectPath);
  if (!isPlanFilePath(projectPath, input.submittedPath, { factoryProjectId: input.factoryProjectId })) {
    throw invalid('The plan must be a markdown file directly inside the native project plan directory.');
  }
  const path = resolve(resolvePlanPath(projectPath, input.submittedPath)!);
  await checkPlanFile(path);
  const contents = await readPlanFile(path);
  if (!contents) throw invalid('The native plan file could not be read.');
  // Detect disappearance, nonregular replacement and size growth during the SDK read.
  // Files may still change afterward; no filesystem transaction or lock is implied.
  await checkPlanFile(path);
  if (Buffer.byteLength(contents.title + '\n' + contents.plan, 'utf8') > MAX_PLAN_BYTES) {
    throw invalid('The native plan file exceeds the 1 MiB preview limit.');
  }
  const version = createHash('sha256').update(JSON.stringify([path, contents.title, contents.plan])).digest('hex');
  return { path, ...contents, version };
}

/** Reread before claiming the native prompt, comparing the content actually shown. */
export async function rereadNativePlan(input: NativePlanReadInput, expectedVersion: string): Promise<NativePlanPreview> {
  if (typeof expectedVersion !== 'string' || !expectedVersion) throw invalid('Provide the reviewed native plan version.');
  const current = await readNativePlan(input);
  if (current.version !== expectedVersion) throw new ORPCError('CONFLICT', { message: 'The plan changed since you reviewed it. Refresh the plan before responding.' });
  return current;
}
