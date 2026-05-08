import { skillIconUrl } from "../api/client";
import type { SkillMetadata, TextElement, TimelineSkillMention, UserInput } from "../api/client";

export type SkillMentionToken = {
  end: number;
  query: string;
  start: number;
};

export type SkillMentionBinding = {
  brandColor?: string | null;
  displayName?: string | null;
  end: number;
  iconSmallUrl?: string | null;
  name: string;
  path: string;
  scope?: string | null;
  shortDescription?: string | null;
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
      displayName: trimmed(skill.interface?.displayName),
      name: skill.name,
      path: skill.path,
      scope: trimmed(skill.scope),
      shortDescription: skillDescription(skill),
      brandColor: trimmed(skill.interface?.brandColor),
      iconSmallUrl: trimmed(skill.interface?.iconSmall) ? skillIconUrl(skill.interface!.iconSmall!) : undefined,
    },
    cursor: token.start + replacement.length,
    text: nextText,
  };
}

export function validSkillMentionBindings(text: string, bindings: SkillMentionBinding[]): SkillMentionBinding[] {
  return bindings.filter((binding) => text.slice(binding.start, binding.end) === `$${binding.name}`);
}

export function trimmedSkillMentionBindings(text: string, bindings: SkillMentionBinding[]): {
  bindings: SkillMentionBinding[];
  text: string;
} {
  const trimmedText = text.trim();
  if (!trimmedText) {
    return { bindings: [], text: trimmedText };
  }
  const leadingTrimLength = text.search(/\S/);
  const shifted = validSkillMentionBindings(text, bindings)
    .map((binding) => ({
      ...binding,
      start: binding.start - leadingTrimLength,
      end: binding.end - leadingTrimLength,
    }))
    .filter((binding) => binding.start >= 0 && binding.end <= trimmedText.length);
  return {
    bindings: validSkillMentionBindings(trimmedText, shifted),
    text: trimmedText,
  };
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

export function skillTextElementsFromBindings(text: string, bindings: SkillMentionBinding[]): TextElement[] {
  return validSkillMentionBindings(text, bindings).map((binding) => ({
    byteRange: {
      start: utf8ByteLength(text.slice(0, binding.start)),
      end: utf8ByteLength(text.slice(0, binding.end)),
    },
    placeholder: `$${binding.name}`,
  }));
}

export function timelineSkillMentionsFromBindings(
  text: string,
  bindings: SkillMentionBinding[],
): TimelineSkillMention[] {
  return validSkillMentionBindings(text, bindings).map((binding) => {
    const mention: TimelineSkillMention = {
      start: binding.start,
      end: binding.end,
      name: binding.name,
      path: binding.path,
    };
    assignOptional(mention, "displayName", binding.displayName);
    assignOptional(mention, "scope", binding.scope);
    assignOptional(mention, "shortDescription", binding.shortDescription);
    assignOptional(mention, "brandColor", binding.brandColor);
    assignOptional(mention, "iconSmallUrl", binding.iconSmallUrl);
    return mention;
  });
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
  return trimmed(skill.interface?.shortDescription) || trimmed(skill.shortDescription) || skill.description;
}

export function skillBrandColor(skill: SkillMetadata): string | undefined {
  return trimmed(skill.interface?.brandColor);
}

export function skillSmallIconUrl(skill: SkillMetadata): string | undefined {
  const iconSmall = trimmed(skill.interface?.iconSmall);
  return iconSmall ? skillIconUrl(iconSmall) : undefined;
}

export function skillIconUrlIsSvg(url?: string | null): boolean {
  return Boolean(url?.toLocaleLowerCase().includes(".svg"));
}

export function cssUrl(value: string): string {
  return `url("${value.replace(/["\\]/g, "\\$&")}")`;
}

export function skillFallbackIconLabel(skill: SkillMetadata): string {
  const source = skillDisplayName(skill).trim() || skill.name.trim();
  return source.match(/[A-Za-z0-9]/)?.[0]?.toLocaleUpperCase() ?? "$";
}

function trimmed(value?: string | null): string | undefined {
  const output = value?.trim();
  return output || undefined;
}

function assignOptional<T extends object, K extends keyof T>(target: T, key: K, value: T[K] | undefined | null): void {
  if (value !== undefined && value !== null) {
    target[key] = value;
  }
}

function skillMatchScore(skill: SkillMetadata, normalizedQuery: string): number | null {
  const terms = [skillDisplayName(skill), skill.name, skillDescription(skill)]
    .filter(Boolean)
    .map((term) => term.toLocaleLowerCase());
  let best: number | null = null;
  for (const term of terms) {
    const index = term.indexOf(normalizedQuery);
    const fuzzyIndex = index === -1 ? fuzzySubsequenceStart(term, normalizedQuery) : null;
    if (index === -1 && fuzzyIndex === null) {
      continue;
    }
    const matchIndex = index === -1 ? fuzzyIndex! : index;
    const score =
      matchIndex +
      (term === skill.name.toLocaleLowerCase() ? 0 : 2) +
      (index === -1 ? 20 : 0);
    best = best === null ? score : Math.min(best, score);
  }
  return best;
}

function fuzzySubsequenceStart(term: string, query: string): number | null {
  let queryIndex = 0;
  let firstMatchIndex: number | null = null;
  for (let termIndex = 0; termIndex < term.length && queryIndex < query.length; termIndex += 1) {
    if (term[termIndex] !== query[queryIndex]) {
      continue;
    }
    firstMatchIndex ??= termIndex;
    queryIndex += 1;
  }
  return queryIndex === query.length ? firstMatchIndex : null;
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
  return value !== undefined && /[A-Za-z0-9_:-]/.test(value);
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}
