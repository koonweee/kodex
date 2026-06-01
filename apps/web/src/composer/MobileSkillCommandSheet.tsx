import { Group } from "@mantine/core";
import type { CSSProperties } from "react";

import type { SkillMetadata } from "../api/client";
import {
  cssUrl,
  skillBrandColor,
  skillDisplayName,
  skillFallbackIconLabel,
  skillIconUrlIsSvg,
  skillSmallIconUrl,
} from "./skillMentions";
import { MobileTriggerCommandSheet } from "./MobileTriggerCommandSheet";
import type { TriggerSuggestionItem } from "./TriggerSuggestionPopup";

type MobileSkillCommandSheetProps = {
  activeIndex: number;
  error: string | null;
  loading: boolean;
  onSelect: (skill: SkillMetadata) => void;
  skills: SkillMetadata[];
};

export function MobileSkillCommandSheet({
  activeIndex,
  error,
  loading,
  onSelect,
  skills,
}: MobileSkillCommandSheetProps) {
  return (
    <MobileTriggerCommandSheet
      activeIndex={activeIndex}
      ariaLabel="Skill suggestions"
      emptyLabel="No matching skills"
      error={error}
      itemIndexAttribute="data-skill-option-index"
      items={skills.map(skillSuggestionItem)}
      loading={loading}
      loadingLabel="Loading skills..."
      onSelect={(item) => onSelect(item.skill)}
      renderItem={(item) => <MobileSkillSuggestionContent skill={item.skill} />}
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

function MobileSkillSuggestionContent({ skill }: { skill: SkillMetadata }) {
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
      <Group className="kodex-mobile-skill-command-copy" justify="space-between" gap={10} wrap="nowrap">
        <span className="kodex-mobile-skill-command-name">{skillDisplayName(skill)}</span>
        <span className="kodex-mobile-skill-command-token">${skill.name}</span>
      </Group>
    </>
  );
}
