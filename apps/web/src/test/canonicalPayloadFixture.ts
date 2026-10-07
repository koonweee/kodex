import type { ThreadTimelineSnapshotItem, TimelineFileAttachment, TimelineSkillMention } from "../api/client";

// Build the compact gateway projection from native-shaped test input.
export function compactCanonicalPayload(rawItem: unknown, metadata: unknown = {}): ThreadTimelineSnapshotItem["payload"] {
  const raw = rawItem && typeof rawItem === "object" ? rawItem as Record<string, unknown> : {};
  const annotations = metadata && typeof metadata === "object" ? metadata as Record<string, unknown> : {};
  const { id: _id, type: _type, kind: _kind, itemType: _itemType,
    clientId: rawClientId, fileAttachments: rawAttachments, ...item } = raw;
  const clientId = annotations.clientId ?? rawClientId;
  const skillMentions = annotations.skillMentions ?? raw.skillMentions;
  const fileAttachments = annotations.fileAttachments ?? rawAttachments;
  return {
    item,
    ...(typeof clientId === "string" ? { clientId } : {}),
    ...(Array.isArray(skillMentions) && skillMentions.length ? { skillMentions: skillMentions as TimelineSkillMention[] } : {}),
    ...(Array.isArray(fileAttachments) && fileAttachments.length ? { fileAttachments: fileAttachments as TimelineFileAttachment[] } : {}),
  };
}
