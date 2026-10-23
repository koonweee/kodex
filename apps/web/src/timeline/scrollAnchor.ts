export type TimelineScrollAnchor = { key: string; offset: number };

export function captureTimelineScrollAnchor(scroll: HTMLElement): TimelineScrollAnchor | null {
  const viewport = scroll.getBoundingClientRect();
  const row = [...scroll.querySelectorAll<HTMLElement>(".kodex-timeline-virtual-row")].find(candidate => {
    const bounds = candidate.getBoundingClientRect();
    return bounds.bottom > viewport.top && bounds.top < viewport.bottom;
  });
  return row?.dataset.rowKey
    ? { key: row.dataset.rowKey, offset: row.getBoundingClientRect().top - viewport.top }
    : null;
}

export function restoreTimelineScrollAnchor(scroll: HTMLElement, anchor: TimelineScrollAnchor) {
  const row = [...scroll.querySelectorAll<HTMLElement>(".kodex-timeline-virtual-row")]
    .find(candidate => candidate.dataset.rowKey === anchor.key);
  if (!row) return;
  const offset = row.getBoundingClientRect().top - scroll.getBoundingClientRect().top;
  const correction = offset - anchor.offset;
  if (Math.abs(correction) >= 0.5) scroll.scrollTop += correction;
}
