import type { TimelineItem } from '../timeline/state';
import type { TimelineSkillMention } from '../api/client';
import { payloadRecord } from '../timeline/presentationShared';

/** The native signal stores original display text beside its actual formatted
 * skill activation. Restore it only with valid owned references and bindings.
 */
export function nativeInputSkillFields(metadata: unknown): Pick<TimelineItem, 'text' | 'skillMentions'> | null {
  const signal = payloadRecord(payloadRecord(metadata)?.signal);
  const input = payloadRecord(payloadRecord(signal?.metadata)?.kodexSkillInput);
  if (!input || typeof input.text !== 'string' || !Array.isArray(input.skills) || !input.skills.length || !Array.isArray(input.mentions)) return null;
  const references = input.skills.map(payloadRecord);
  if (references.some(reference => !reference || typeof reference.name !== 'string' || !reference.name.trim()
    || typeof reference.path !== 'string' || !reference.path.trim())) return null;
  const mentions: TimelineSkillMention[] = [];
  for (const value of input.mentions) {
    const mention = payloadRecord(value);
    if (!mention || typeof mention.name !== 'string' || typeof mention.path !== 'string'
      || !Number.isInteger(mention.start) || !Number.isInteger(mention.end)) return null;
    const start = mention.start as number, end = mention.end as number;
    if (start < 0 || end <= start || end > input.text.length || input.text.slice(start, end) !== `$${mention.name}`
      || !references.some(reference => reference!.name === mention.name && reference!.path === mention.path)) return null;
    mentions.push({ name: mention.name, path: mention.path, start, end });
  }
  const ordered = [...mentions].sort((left, right) => left.start - right.start);
  if (ordered.some((mention, index) => index > 0 && ordered[index - 1]!.end > mention.start)) return null;
  return { text: input.text, skillMentions: mentions };
}
