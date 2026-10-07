import type { ProjectListEntry } from '../threads/viewTypes';

/** UI form values and visible directory rows, not a backend wire contract. */
export type ProjectCreationFields = Pick<ProjectListEntry, 'name' | 'roots'> & { idempotencyKey: string };
export type ProjectFormPatch = Partial<Pick<ProjectListEntry, 'name' | 'roots'>>;
export interface DirectoryListingView { path: string; parentPath?: string | null; directories: { name: string; path: string }[] }
export type DirectoryLoader = (path: string | undefined, signal: AbortSignal) => Promise<DirectoryListingView>;
export interface ProjectEditorActions {
  update: (patch: ProjectFormPatch) => Promise<unknown>;
  remove: () => Promise<unknown>;
}
