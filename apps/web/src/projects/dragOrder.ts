export function moveProjectInSidebarOrderAt(
  orderIds: string[],
  sourceProjectId: string,
  targetProjectId: string,
  placement: "before" | "after",
): string[] {
  if (sourceProjectId === targetProjectId) {
    return orderIds;
  }

  const next = orderIds.filter((projectId) => projectId !== sourceProjectId);
  const targetIndex = next.indexOf(targetProjectId);
  if (targetIndex === -1) {
    return orderIds;
  }
  next.splice(placement === "after" ? targetIndex + 1 : targetIndex, 0, sourceProjectId);
  return next;
}
