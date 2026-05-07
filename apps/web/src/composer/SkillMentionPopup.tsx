import { Box, Group } from "@mantine/core";
import { useEffect, useRef } from "react";

import type { SkillMetadata } from "../api/client";
import { skillDescription, skillDisplayName } from "./skillMentions";

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
          ? skills.map((skill, index) => (
              <Box
                key={skill.path}
                aria-selected={index === activeIndex}
                className="kodex-skill-popup-row"
                data-skill-option-index={index}
                role="option"
                onClick={() => onSelect(skill)}
              >
                <Group justify="space-between" gap={8} wrap="nowrap">
                  <span className="kodex-skill-popup-name">{skillDisplayName(skill)}</span>
                  <span className="kodex-skill-popup-scope">{skill.scope}</span>
                </Group>
                <Group className="kodex-skill-popup-meta" gap={8} wrap="nowrap">
                  <span>${skill.name}</span>
                  <span>{skillDescription(skill)}</span>
                </Group>
              </Box>
            ))
          : null}
      </Box>
    </Box>
  );
}
