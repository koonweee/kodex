import { Box, Group } from "@mantine/core";
import { useEffect, useRef } from "react";
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
  const scrollAreaRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const scrollArea = scrollAreaRef.current;
    const option = scrollArea?.querySelector<HTMLElement>(
      `[data-skill-option-index="${activeIndex}"]`,
    );
    if (!scrollArea || !option) {
      return;
    }

    const optionTop = option.offsetTop;
    const optionBottom = optionTop + option.offsetHeight;
    const visibleTop = scrollArea.scrollTop;
    const visibleBottom = visibleTop + scrollArea.clientHeight;
    if (optionTop < visibleTop) {
      scrollArea.scrollTop = optionTop;
    } else if (optionBottom > visibleBottom) {
      scrollArea.scrollTop = optionBottom - scrollArea.clientHeight;
    }
  }, [activeIndex]);

  return (
    <Box
      className="kodex-skill-popup"
    >
      <Box
        ref={scrollAreaRef}
        className="kodex-skill-popup-scroll"
        role="listbox"
        aria-label="Skill suggestions"
      >
        {loading ? <Box className="kodex-skill-popup-status">Loading skills...</Box> : null}
        {!loading && error ? <Box className="kodex-skill-popup-status">{error}</Box> : null}
        {!loading && !error && skills.length === 0 ? (
          <Box className="kodex-skill-popup-status">No matching skills</Box>
        ) : null}
        {!loading && !error
          ? skills.map((skill, index) => {
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
                <Box
                  key={skill.path}
                  aria-selected={index === activeIndex}
                  className="kodex-skill-popup-row"
                  data-skill-option-index={index}
                  role="option"
                  onClick={() => onSelect(skill)}
                >
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
                    <Group
                      className="kodex-skill-popup-title"
                      justify="space-between"
                      gap={8}
                      wrap="nowrap"
                    >
                      <span className="kodex-skill-popup-name">{skillDisplayName(skill)}</span>
                      <span className="kodex-skill-popup-scope">{skill.scope}</span>
                    </Group>
                    <Group className="kodex-skill-popup-meta" gap={8} wrap="nowrap">
                      <span>${skill.name}</span>
                      <span>{skillDescription(skill)}</span>
                    </Group>
                  </span>
                </Box>
              );
            })
          : null}
      </Box>
    </Box>
  );
}
