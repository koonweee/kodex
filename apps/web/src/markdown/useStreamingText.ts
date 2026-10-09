import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Options } from "react-markdown";

import { appendStreamingRuns, decorateStreamingText, STREAM_FADE_MS, type StreamingRun } from "./streamingText";

type Streaming = { identity: string; deltaStart?: number };
type RevealState = { text: string; identity?: string; deltaStart?: number; runs: StreamingRun[] };

export function useStreamingText(text: string, streaming?: Streaming) {
  const root = useRef<HTMLDivElement>(null);
  const selectionInside = useRef(false);
  const [selected, setSelected] = useState(false);
  const [allowed, setAllowed] = useState(() => !document.hidden && !window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  const [state, setState] = useState<RevealState>({ text, identity: streaming?.identity, deltaStart: streaming?.deltaStart, runs: [] });
  const identity = streaming?.identity;
  const deltaStart = streaming?.deltaStart;
  const enabled = !selected && Boolean(identity) && allowed && !document.hidden;
  let current = state;
  if (state.text !== text || state.identity !== identity || state.deltaStart !== deltaStart || (!enabled && !selected && state.runs.length > 0)) {
    const append = enabled && state.identity === identity && deltaStart !== undefined && text.length > state.text.length && text.startsWith(state.text);
    current = { text, identity, deltaStart, runs: selected && text.startsWith(state.text)
      ? state.runs : append ? appendStreamingRuns(state.runs, text, Math.max(state.text.length, deltaStart!), performance.now()) : [] };
    // Prop-derived presentation state: no post-commit frame of obsolete decoration.
    setState(current);
  }
  const runs = current.runs;
  const plugins = useMemo<NonNullable<Options["rehypePlugins"]>>(() => runs.length
    ? [() => (tree) => { decorateStreamingText(tree, text, runs); }] : [], [text, runs]);

  useEffect(() => {
    if (!identity && !runs.length) return;
    const changed = () => {
      const contains = hasTextSelection(root.current);
      const wasInside = selectionInside.current;
      selectionInside.current = contains;
      setSelected(contains);
      if (wasInside && !contains) setState(previous => previous.runs.length ? { ...previous, runs: [] } : previous);
    };
    document.addEventListener("selectionchange", changed);
    return () => document.removeEventListener("selectionchange", changed);
  }, [identity, Boolean(runs.length)]);

  useEffect(() => {
    if (!identity) return;
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const changed = () => {
      setAllowed(!document.hidden && !media.matches);
      // Cancel motion immediately, but preserve the browser's selected nodes until
      // selection ends. Recovery must not replay a queued visual suffix.
      const contains = hasTextSelection(root.current);
      selectionInside.current = contains;
      setSelected(contains);
      setState(previous => contains || !previous.runs.length ? previous : { ...previous, runs: [] });
    };
    changed();
    document.addEventListener("visibilitychange", changed);
    media.addEventListener("change", changed);
    return () => {
      document.removeEventListener("visibilitychange", changed);
      media.removeEventListener("change", changed);
    };
  }, [identity]);

  useLayoutEffect(() => {
    if (!root.current || !enabled || !runs.length) return;
    const now = performance.now();
    const animations: Animation[] = [];
    for (const node of root.current.querySelectorAll<HTMLElement>("[data-stream-born]")) {
      if (!node.animate) continue;
      const age = now - Number(node.dataset.streamBorn);
      if (age >= STREAM_FADE_MS) continue;
      const animation = node.animate([{ opacity: 0.25 }, { opacity: 1 }], {
        duration: STREAM_FADE_MS, easing: "ease-out", fill: "backwards", delay: Math.max(0, -age),
      });
      if (age > 0) animation.currentTime = age;
      animations.push(animation);
    }
    // Expired runs are pruned on the next real text update or canonical replacement.
    // A quiet-period cleanup would reparse the entire Markdown answer just to unwrap
    // a bounded suffix. Finished animations have no effect and do no ongoing work.
    return () => animations.forEach(animation => animation.cancel());
  }, [enabled, runs]);

  return { root, plugins };
}

function hasTextSelection(root: HTMLElement | null): boolean {
  const selection = window.getSelection();
  return Boolean(selection && !selection.isCollapsed && root &&
    (root.contains(selection.anchorNode) || root.contains(selection.focusNode)));
}
