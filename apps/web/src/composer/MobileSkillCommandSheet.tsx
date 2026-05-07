import { Box, Group } from "@mantine/core";
import { useEffect, useRef } from "react";

import type { SkillMetadata } from "../api/client";
import { skillDisplayName } from "./skillMentions";

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
  const scrollAreaRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const scrollArea = scrollAreaRef.current;
    const option = scrollArea?.querySelector<HTMLElement>(`[data-skill-option-index="${activeIndex}"]`);
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

  if (loading || error || skills.length === 0) {
    return (
      <Box
        className="kodex-mobile-skill-command-list kodex-mobile-skill-command-status-list"
        onPointerDownCapture={(event) => event.stopPropagation()}
      >
        {loading ? <Box className="kodex-mobile-skill-command-status">Loading skills...</Box> : null}
        {!loading && error ? <Box className="kodex-mobile-skill-command-status">{error}</Box> : null}
        {!loading && !error && skills.length === 0 ? (
          <Box className="kodex-mobile-skill-command-status">No matching skills</Box>
        ) : null}
      </Box>
    );
  }

  return (
    <Box
      ref={scrollAreaRef}
      aria-label="Skill suggestions"
      className="kodex-mobile-skill-command-list"
      role="listbox"
      onPointerDownCapture={(event) => event.stopPropagation()}
    >
      {skills.map((skill, index) => (
        <Box
          component="button"
          key={skill.path}
          aria-selected={index === activeIndex}
          className="kodex-mobile-skill-command-row"
          data-skill-option-index={index}
          role="option"
          type="button"
          onClick={() => onSelect(skill)}
        >
          <Group justify="space-between" gap={10} wrap="nowrap">
            <span className="kodex-mobile-skill-command-name">{skillDisplayName(skill)}</span>
            <span className="kodex-mobile-skill-command-token">${skill.name}</span>
          </Group>
        </Box>
      ))}
    </Box>
  );
}
