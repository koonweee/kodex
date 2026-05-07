import type { SkillMetadata, UserInput } from "../api/client";

export type SkillMentionToken = {
  end: number;
  query: string;
  start: number;
};

export type SkillMentionBinding = {
  end: number;
  name: string;
  path: string;
  start: number;
};

export type SkillMentionDeletion = {
  bindings: SkillMentionBinding[];
  cursor: number;
  text: string;
};

const COMMON_ENV_VARS = new Set([
  "PATH",
  "HOME",
  "USER",
  "SHELL",
  "PWD",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "TERM",
  "XDG_CONFIG_HOME",
]);

export function activeSkillMentionToken(text: string, cursor: number): SkillMentionToken | null {
  const boundedCursor = Math.max(0, Math.min(cursor, text.length));
  let start = boundedCursor - 1;
  while (start >= 0 && isMentionNameChar(text[start])) {
    start -= 1;
  }
  if (text[start] !== "$") {
    return null;
  }
  const queryStart = start + 1;
  let end = queryStart;
  while (end < text.length && isMentionNameChar(text[end])) {
    end += 1;
  }
  if (boundedCursor < queryStart || boundedCursor > end) {
    return null;
  }
  const query = text.slice(queryStart, boundedCursor);
  if (isCommonEnvVar(query)) {
    return null;
  }
  return { start, end, query };
}

export function replaceSkillMentionToken(
  text: string,
  token: SkillMentionToken,
  skill: SkillMetadata,
): { binding: SkillMentionBinding; cursor: number; text: string } {
  const insertText = `$${skill.name}`;
  const needsTrailingSpace = token.end >= text.length || !/\s/.test(text[token.end] ?? "");
  const replacement = `${insertText}${needsTrailingSpace ? " " : ""}`;
  const nextText = `${text.slice(0, token.start)}${replacement}${text.slice(token.end)}`;
  const end = token.start + insertText.length;
  return {
    binding: {
      start: token.start,
      end,
      name: skill.name,
      path: skill.path,
    },
    cursor: token.start + replacement.length,
    text: nextText,
  };
}

export function validSkillMentionBindings(text: string, bindings: SkillMentionBinding[]): SkillMentionBinding[] {
  return bindings.filter((binding) => text.slice(binding.start, binding.end) === `$${binding.name}`);
}

export function deleteSkillMentionBeforeCursor(
  text: string,
  bindings: SkillMentionBinding[],
  cursor: number,
): SkillMentionDeletion | null {
  const boundedCursor = Math.max(0, Math.min(cursor, text.length));
  const validBindings = validSkillMentionBindings(text, bindings);
  const binding = validBindings.find((candidate) =>
    cursorDeletesBinding(text, candidate, boundedCursor),
  );
  if (!binding) {
    return null;
  }

  const deleteEnd =
    boundedCursor === binding.end + 1 && /\s/.test(text[binding.end] ?? "") ? boundedCursor : binding.end;
  const removedLength = deleteEnd - binding.start;
  return {
    cursor: binding.start,
    text: `${text.slice(0, binding.start)}${text.slice(deleteEnd)}`,
    bindings: validBindings
      .filter((candidate) => candidate !== binding)
      .map((candidate) =>
        candidate.start >= deleteEnd
          ? {
              ...candidate,
              start: candidate.start - removedLength,
              end: candidate.end - removedLength,
            }
          : candidate,
      ),
  };
}

export function skillInputsFromBindings(bindings: SkillMentionBinding[]): UserInput[] {
  const seen = new Set<string>();
  const inputs: UserInput[] = [];
  for (const binding of bindings) {
    if (seen.has(binding.path)) {
      continue;
    }
    seen.add(binding.path);
    inputs.push({ type: "skill", name: binding.name, path: binding.path });
  }
  return inputs;
}

export function filterSkillsForQuery(skills: SkillMetadata[], query: string): SkillMetadata[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const enabled = skills.filter((skill) => skill.enabled);
  if (!normalizedQuery) {
    return [...enabled].sort(compareSkills);
  }
  return enabled
    .map((skill) => ({ score: skillMatchScore(skill, normalizedQuery), skill }))
    .filter((item) => item.score !== null)
    .sort((left, right) => left.score! - right.score! || compareSkills(left.skill, right.skill))
    .map((item) => item.skill);
}

export function skillDisplayName(skill: SkillMetadata): string {
  return skill.interface?.displayName?.trim() || skill.name;
}

export function skillDescription(skill: SkillMetadata): string {
  return skill.interface?.shortDescription?.trim() || skill.shortDescription?.trim() || skill.description;
}

function skillMatchScore(skill: SkillMetadata, normalizedQuery: string): number | null {
  const terms = [skillDisplayName(skill), skill.name, skillDescription(skill)]
    .filter(Boolean)
    .map((term) => term.toLocaleLowerCase());
  let best: number | null = null;
  for (const term of terms) {
    const index = term.indexOf(normalizedQuery);
    if (index === -1) {
      continue;
    }
    const score = index + (term === skill.name.toLocaleLowerCase() ? 0 : 2);
    best = best === null ? score : Math.min(best, score);
  }
  return best;
}

function compareSkills(left: SkillMetadata, right: SkillMetadata): number {
  return scopeRank(left.scope) - scopeRank(right.scope) || skillDisplayName(left).localeCompare(skillDisplayName(right));
}

function cursorDeletesBinding(text: string, binding: SkillMentionBinding, cursor: number): boolean {
  if (cursor > binding.start && cursor <= binding.end) {
    return true;
  }
  return cursor === binding.end + 1 && /\s/.test(text[binding.end] ?? "");
}

function scopeRank(scope: string): number {
  switch (scope) {
    case "repo":
      return 0;
    case "user":
      return 1;
    case "admin":
      return 2;
    case "system":
      return 3;
    default:
      return 4;
  }
}

function isCommonEnvVar(value: string): boolean {
  return value.length > 0 && COMMON_ENV_VARS.has(value.toLocaleUpperCase());
}

function isMentionNameChar(value: string | undefined): boolean {
  return value !== undefined && /[A-Za-z0-9_-]/.test(value);
}
