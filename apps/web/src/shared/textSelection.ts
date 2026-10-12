type TextSelectionPoint = { rowKey: string | null; offset: number };
export type TextSelectionSnapshot = { start: TextSelectionPoint; end: TextSelectionPoint };

export function hasTextSelection(root: HTMLElement | null): boolean {
  const selection = window.getSelection();
  return Boolean(selection && !selection.isCollapsed && root &&
    (root.contains(selection.anchorNode) || root.contains(selection.focusNode)));
}

export function captureTextSelection(root: HTMLElement | null): TextSelectionSnapshot | null {
  const selection = window.getSelection();
  if (!root || !selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
  return {
    start: selectionPoint(root, range.startContainer, range.startOffset),
    end: selectionPoint(root, range.endContainer, range.endOffset),
  };
}

export function restoreTextSelection(root: HTMLElement, snapshot: TextSelectionSnapshot) {
  const selection = window.getSelection();
  const start = resolvePoint(root, snapshot.start);
  const end = resolvePoint(root, snapshot.end);
  if (!selection || !start || !end) return;
  const range = document.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset);
  selection.removeAllRanges();
  selection.addRange(range);
}

function selectionPoint(root: HTMLElement, node: Node, offset: number): TextSelectionPoint {
  const row = closestRow(root, node);
  const container = row ?? root;
  return {
    rowKey: row?.dataset.rowKey ?? null,
    offset: textOffset(container, node, offset),
  };
}

function resolvePoint(root: HTMLElement, point: TextSelectionPoint): { node: Node; offset: number } | null {
  const container = point.rowKey === null
    ? root
    : Array.from(root.querySelectorAll<HTMLElement>("[data-row-key]")).find((row) => row.dataset.rowKey === point.rowKey);
  if (!container || point.offset > (container.textContent?.length ?? 0)) return null;
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let consumed = 0;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const end = consumed + (node.textContent?.length ?? 0);
    if (point.offset <= end) return { node, offset: point.offset - consumed };
    consumed = end;
  }
  return null;
}

function closestRow(root: HTMLElement, node: Node): HTMLElement | null {
  let element = node instanceof HTMLElement ? node : node.parentElement;
  while (element && element !== root) {
    if (element.dataset.rowKey) return element;
    element = element.parentElement;
  }
  return null;
}

function textOffset(root: HTMLElement, node: Node, offset: number): number {
  const range = document.createRange();
  range.selectNodeContents(root);
  range.setEnd(node, offset);
  return range.toString().length;
}
