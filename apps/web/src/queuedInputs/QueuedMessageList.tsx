import { Box, Button, Text, VisuallyHidden } from "@mantine/core";
import { CornerDownRight, GripVertical, Pencil, Trash2 } from "lucide-react";
import { useEffect, useId, useRef, useState, type PointerEvent } from "react";

import type { QueuedInput } from "../api/client";
import { AdaptiveIconButton } from "../ui/AdaptiveIconButton";
import { queueInputPreview } from "./input";

type Drag = { id: string; ids: string[]; pointerId: number; startY: number; y: number; target: number; moved: boolean };

export function QueuedMessageList({ rows, busy, partial, isActive, onReorder, onSteer, onEdit, onRemove }: {
  rows: QueuedInput[];
  busy: boolean;
  partial: boolean;
  isActive: boolean;
  onReorder: (ids: string[]) => void;
  onSteer: (row: QueuedInput) => void;
  onEdit: (row: QueuedInput) => void;
  onRemove: (row: QueuedInput) => void;
}) {
  const instructionsId = useId();
  const list = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const scrollFrame = useRef<number | null>(null);
  const [preview, setPreview] = useState<{ id: string; target: number } | null>(null);
  const [suppressedHandleId, setSuppressedHandleId] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const ids = rows.map((row) => row.id);
  const order = JSON.stringify(ids);
  const disabled = busy || partial || rows.length < 2 || !isActive;

  function cancel() {
    drag.current = null;
    if (scrollFrame.current !== null) cancelAnimationFrame(scrollFrame.current);
    scrollFrame.current = null;
    setPreview(null);
  }

  // A gesture is local UI state; it must never reorder a superseded native list.
  useEffect(() => { cancel(); }, [order, disabled]);
  useEffect(() => () => {
    if (scrollFrame.current !== null) cancelAnimationFrame(scrollFrame.current);
  }, []);

  function move(id: string, target: number) {
    const source = ids.indexOf(id);
    if (disabled || source < 0 || target < 0 || target >= ids.length || source === target) return;
    const next = [...ids];
    next.splice(source, 1);
    next.splice(target, 0, id);
    onReorder(next);
    setAnnouncement(`Moved queued message to position ${target + 1} of ${ids.length}.`);
  }

  function updateTarget(current: Drag) {
    const elements = list.current?.querySelectorAll<HTMLElement>('[data-queue-row]');
    let distance = Infinity;
    elements?.forEach((element, index) => {
      const rect = element.getBoundingClientRect();
      const candidate = Math.abs(current.y - (rect.top + rect.height / 2));
      if (candidate < distance) { distance = candidate; current.target = index; }
    });
    setPreview({ id: current.id, target: current.target });
  }

  function edgeScroll() {
    const current = drag.current;
    const root = list.current;
    if (!current || !current.moved || !root) { scrollFrame.current = null; return; }
    const bounds = root.getBoundingClientRect();
    const delta = current.y < bounds.top + 24 ? -6 : current.y > bounds.bottom - 24 ? 6 : 0;
    const before = root.scrollTop;
    root.scrollTop += delta;
    if (root.scrollTop !== before) updateTarget(current);
    scrollFrame.current = requestAnimationFrame(edgeScroll);
  }

  function pointerMove(event: PointerEvent<HTMLButtonElement>) {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId || JSON.stringify(current.ids) !== order || disabled) return;
    if (!current.moved && Math.abs(event.clientY - current.startY) < 5) return;
    current.moved = true;
    current.y = event.clientY;
    updateTarget(current);
    if (scrollFrame.current === null) scrollFrame.current = requestAnimationFrame(edgeScroll);
  }

  function pointerUp(event: PointerEvent<HTMLButtonElement>) {
    const current = drag.current;
    const bounds = list.current?.getBoundingClientRect();
    cancel();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (!current || current.pointerId !== event.pointerId || !current.moved || JSON.stringify(current.ids) !== order || !bounds) return;
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) return;
    move(current.id, current.target);
  }

  return <Box role="region" aria-label="Queued messages" className="kodex-queued-messages">
    <VisuallyHidden id={instructionsId}>Drag to reorder, or use the up and down arrow keys. Escape cancels dragging.</VisuallyHidden>
    <VisuallyHidden role="status">{announcement}</VisuallyHidden>
    {partial ? <Text size="xs" className="kodex-queue-notice">Only part of the queue is shown. Reordering is unavailable.</Text> : null}
    <div ref={list} className="kodex-queue-list">
      {rows.map((row, index) => {
        const text = queueInputPreview(row.input);
        return <Box key={row.id} role="group" aria-label="Queued message" data-queue-row
          data-dragging={preview?.id === row.id || undefined}
          data-drop-target={preview && preview.target === index && preview.id !== row.id
            ? (index < ids.indexOf(preview.id) ? "before" : "after") : undefined}
          className="kodex-queue-row">
          <AdaptiveIconButton density="compact" label="Reorder queued message" tooltip="Drag to reorder · ↑/↓ to move" className="kodex-queue-handle"
            disabled={disabled} aria-describedby={instructionsId}
            data-hover-suppressed={suppressedHandleId === row.id || undefined}
            tooltipProps={{ disabled: disabled || suppressedHandleId === row.id }}
            onPointerEnter={(event) => {
              if (event.pointerType === "mouse" && !drag.current && event.buttons === 0) setSuppressedHandleId(null);
            }}
            onPointerDown={(event) => {
              if (disabled || event.button !== 0 || !event.isPrimary) return;
              // Pointer capture suppresses hover-exit events during the gesture.
              setSuppressedHandleId(row.id);
              event.preventDefault();
              event.currentTarget.focus({ preventScroll: true });
              event.currentTarget.setPointerCapture(event.pointerId);
              drag.current = { id: row.id, ids: [...ids], pointerId: event.pointerId, startY: event.clientY, y: event.clientY, target: index, moved: false };
            }}
            onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={cancel} onLostPointerCapture={cancel}
            onKeyDown={(event) => {
              if (event.key === "Escape") { event.preventDefault(); cancel(); }
              if (event.key === "ArrowUp" || event.key === "ArrowDown") {
                event.preventDefault(); cancel(); move(row.id, index + (event.key === "ArrowUp" ? -1 : 1));
              }
            }}><GripVertical /></AdaptiveIconButton>
          <div className="kodex-queue-preview" title={text}>
            <Text truncate className="kodex-queue-text">{text}</Text>
            {row.attachments.length > 0 ? <Text size="xs" className="kodex-queue-attachments">{row.attachments.length} attached file(s)</Text> : null}
          </div>
          <div className="kodex-queue-actions">
            {row.canSteer ? <Button size="compact-sm" variant="subtle" className="kodex-queue-steer" leftSection={<CornerDownRight size={16} />} disabled={busy}
              onClick={() => onSteer(row)}>Steer</Button> : null}
            <AdaptiveIconButton density="compact" label="Remove" disabled={busy} onClick={() => onRemove(row)}><Trash2 /></AdaptiveIconButton>
            <AdaptiveIconButton density="compact" label="Edit" disabled={busy} onClick={() => onEdit(row)}><Pencil /></AdaptiveIconButton>
          </div>
        </Box>;
      })}
    </div>
  </Box>;
}
