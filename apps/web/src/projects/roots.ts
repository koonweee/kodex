import type { Project } from "../api/client";

export function singleProjectRoot(project: Project | null | undefined): string | null {
  return project?.roots.length === 1 ? project.roots[0].path || null : null;
}

export function projectRootsFromText(text: string): Project["roots"] {
  return text.split("\n").map((path) => path.trim()).filter(Boolean).map((path) => ({ path }));
}
