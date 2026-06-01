import { Group } from "@mantine/core";
import type { CSSProperties } from "react";

import type { SkillMetadata } from "../api/client";
import {
  cssUrl,
  skillBrandColor,
  skillDescription,
  skillDisplayName,
  skillFallbackIconLabel,
  skillIconUrlIsSvg,
  skillSmallIconUrl,
} from "./skillMentions";
import { TriggerSuggestionPopup, type TriggerSuggestionItem } from "./TriggerSuggestionPopup";

export function SkillMentionPopup({
  activeIndex,
  error,
  loading,
  onSelect,
  skills,
}: {
  activeIndex: number;
  error: string | null;
  loading: boolean;
  onSelect: (skill: SkillMetadata) => void;
  skills: SkillMetadata[];
}) {
  return (
    <TriggerSuggestionPopup
      activeIndex={activeIndex}
      ariaLabel="Skill suggestions"
      emptyLabel="No matching skills"
      error={error}
      itemIndexAttribute="data-skill-option-index"
      items={skills.map(skillSuggestionItem)}
      loading={loading}
      loadingLabel="Loading skills..."
      onSelect={(item) => onSelect(item.skill)}
      renderItem={(item) => <SkillSuggestionContent skill={item.skill} />}
    />
  );
}

type SkillSuggestionItem = TriggerSuggestionItem & {
  skill: SkillMetadata;
};

function skillSuggestionItem(skill: SkillMetadata): SkillSuggestionItem {
  return {
    id: skill.path,
    skill,
  };
}

function SkillSuggestionContent({ skill }: { skill: SkillMetadata }) {
  const brandColor = skillBrandColor(skill);
  const iconUrl = skillSmallIconUrl(skill);
  const isSvgIcon = skillIconUrlIsSvg(iconUrl);
  const fallbackLabel = skillFallbackIconLabel(skill);
  const iconStyle = brandColor ? ({ "--skill-brand-color": brandColor } as CSSProperties) : undefined;
  const svgIconStyle =
    iconUrl && isSvgIcon
      ? ({
          "--skill-icon-mask": cssUrl(iconUrl),
        } as CSSProperties)
      : undefined;
  return (
    <>
      <span
        aria-hidden="true"
        className="kodex-skill-option-icon"
        data-has-accent={brandColor ? "true" : undefined}
        style={iconStyle}
      >
        {iconUrl && isSvgIcon ? (
          <span className="kodex-skill-option-icon-svg" style={svgIconStyle} />
        ) : iconUrl ? (
          <img alt="" src={iconUrl} />
        ) : (
          <span className="kodex-skill-option-icon-label">{fallbackLabel}</span>
        )}
      </span>
      <span className="kodex-skill-popup-body">
        <Group className="kodex-skill-popup-title" justify="space-between" gap={8} wrap="nowrap">
          <span className="kodex-skill-popup-name">{skillDisplayName(skill)}</span>
          <span className="kodex-skill-popup-scope">{skill.scope}</span>
        </Group>
        <Group className="kodex-skill-popup-meta" gap={8} wrap="nowrap">
          <span>${skill.name}</span>
          <span>{skillDescription(skill)}</span>
        </Group>
      </span>
    </>
  );
}
