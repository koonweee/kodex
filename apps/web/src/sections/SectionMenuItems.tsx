import { Menu } from "@mantine/core";
import { ArrowDown, ArrowUp } from "lucide-react";
import type { ThreadSection, ThreadSummary } from "../api/client";
import { PINNED_SECTION_ID } from "./cache";

export type ThreadSectionActions = {
  sections?: ThreadSection[];
  onMoveThreadToSection?: (threadId: string, sectionId: string | null, beforeThreadId?: string | null) => void;
  sectionMovePending?: boolean;
};

export function SectionMenuItems({ thread, sections = [], onMoveThreadToSection, sectionMovePending = false,
  previousThreadId, followingThreadId, canMoveDown,
}: ThreadSectionActions & {
  thread: ThreadSummary;
  previousThreadId?: string;
  followingThreadId?: string | null;
  canMoveDown?: boolean;
}) {
  if (!onMoveThreadToSection) return null;
  const currentSectionId = thread.section?.id ?? null;
  return <>
    <Menu.Label>Move to section</Menu.Label>
    <Menu.Item disabled={sectionMovePending || currentSectionId === null} onClick={() => onMoveThreadToSection(thread.id, null)}>No section</Menu.Item>
    <Menu.Item disabled={sectionMovePending || currentSectionId === PINNED_SECTION_ID} onClick={() => onMoveThreadToSection(thread.id, PINNED_SECTION_ID)}>Pinned</Menu.Item>
    {sections.filter((section) => section.id !== PINNED_SECTION_ID).map((section) =>
      <Menu.Item key={section.id} disabled={sectionMovePending || currentSectionId === section.id} onClick={() => onMoveThreadToSection(thread.id, section.id)}>{section.name}</Menu.Item>,
    )}
    {currentSectionId && canMoveDown !== undefined ? <>
      <Menu.Item disabled={sectionMovePending || !previousThreadId} leftSection={<ArrowUp size={14} />} onClick={() => onMoveThreadToSection(thread.id, currentSectionId, previousThreadId)}>Move up</Menu.Item>
      <Menu.Item disabled={sectionMovePending || !canMoveDown} leftSection={<ArrowDown size={14} />} onClick={() => onMoveThreadToSection(thread.id, currentSectionId, followingThreadId)}>Move down</Menu.Item>
    </> : null}
  </>;
}
