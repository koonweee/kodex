// Presentation only: keep visible neighbors stable and retain native order.
// Selecting a hidden panel replaces the last fitting header.
export function visibleWorkspaceTabs(
  panelIds: string[], activePanelId: string | undefined, capacity: number, previousVisibleIds: string[] = [],
) {
  const count = Math.min(panelIds.length, Math.max(1, capacity));
  const selected = new Set(previousVisibleIds.filter(id => panelIds.includes(id)).slice(0, count));
  for (const id of panelIds) {
    if (selected.size >= count) break;
    selected.add(id);
  }
  if (activePanelId && panelIds.includes(activePanelId) && !selected.has(activePanelId)) {
    const visible = panelIds.filter(id => selected.has(id));
    selected.delete(visible[visible.length - 1]);
    selected.add(activePanelId);
  }
  return panelIds.filter(id => selected.has(id));
}
