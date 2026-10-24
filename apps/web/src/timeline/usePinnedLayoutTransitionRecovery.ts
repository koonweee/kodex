import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import type { RefObject } from "react";

import { shouldScrollElementToBottom } from "./scrollPolicy";

const SETTLE_MS = 300;
const MAX_RECOVERY_MS = 1_500;
const LATE_CORRECTION_GRACE_MS = 1_500;

type RecoveryState =
  | { phase: "idle" }
  | { phase: "transition"; pinned: boolean }
  | {
      phase: "recovering";
      frameId: number | null;
      geometry: string | null;
      startedAt: number | null;
      stableSince: number | null;
    }
  | { phase: "grace"; until: number };

export type PassiveScrollAction = "default" | "follow" | "ignore";

export function usePinnedLayoutTransitionRecovery({
  active,
  cancelPendingFollow,
  isPinnedRef,
  onPreservePin,
  scrollParentElement,
  scrollToBottom,
  showScrollToBottomRef,
  threadId,
}: {
  active: boolean;
  cancelPendingFollow: () => void;
  isPinnedRef: RefObject<boolean>;
  onPreservePin: () => void;
  scrollParentElement: HTMLDivElement | null;
  scrollToBottom: () => void;
  showScrollToBottomRef: RefObject<boolean>;
  threadId?: string;
}) {
  const activeRef = useRef(active);
  const previousActiveRef = useRef(false);
  const previousThreadIdRef = useRef(threadId);
  const runRecoveryRef = useRef<(timestamp: number) => void>(() => undefined);
  const stateRef = useRef<RecoveryState>({ phase: "idle" });

  const cancel = useCallback(() => {
    const state = stateRef.current;
    if (state.phase === "recovering" && state.frameId !== null) {
      cancelAnimationFrame(state.frameId);
    }
    stateRef.current = { phase: "idle" };
  }, []);

  const scheduleRecovery = useCallback(() => {
    const state = stateRef.current;
    if (state.phase !== "recovering" || state.frameId !== null) return;
    state.frameId = requestAnimationFrame((timestamp) => {
      const current = stateRef.current;
      if (current.phase !== "recovering") return;
      current.frameId = null;
      runRecoveryRef.current(timestamp);
    });
  }, []);

  const runRecovery = useCallback((timestamp: number) => {
    const state = stateRef.current;
    if (
      state.phase !== "recovering" ||
      activeRef.current ||
      !isPinnedRef.current ||
      !scrollParentElement
    ) {
      cancel();
      return;
    }

    scrollToBottom();
    const geometry = `${scrollParentElement.clientHeight}:${scrollParentElement.scrollHeight}`;
    const isAtBottom = !shouldScrollElementToBottom(scrollParentElement);
    state.startedAt ??= timestamp;
    if (!isAtBottom || state.geometry !== geometry) {
      state.stableSince = isAtBottom ? timestamp : null;
    } else state.stableSince ??= timestamp;
    state.geometry = geometry;

    const stableFor = timestamp - (state.stableSince ?? timestamp);
    const elapsed = timestamp - state.startedAt;
    if ((isAtBottom && stableFor >= SETTLE_MS) || elapsed >= MAX_RECOVERY_MS) {
      stateRef.current = {
        phase: "grace",
        until: performance.now() + LATE_CORRECTION_GRACE_MS,
      };
      return;
    }
    scheduleRecovery();
  }, [cancel, isPinnedRef, scheduleRecovery, scrollParentElement, scrollToBottom]);
  runRecoveryRef.current = runRecovery;

  const consumeAtBottomChange = useCallback((atBottom: boolean) => {
    // The current render prop closes the child-layout-effect ordering gap before
    // this hook's parent layout effect records the transition.
    if (active) return true;
    const state = stateRef.current;
    if (state.phase !== "transition" && state.phase !== "recovering") return false;
    if (state.phase === "transition" && !state.pinned) return false;
    if (atBottom) onPreservePin();
    return true;
  }, [active, onPreservePin]);

  const consumeGeometryChange = useCallback(() => {
    // The render value covers child layout effects; the ref covers observer
    // callbacks retained from the previous render until passive effects update.
    if (active || activeRef.current) return true;
    const state = stateRef.current;
    if (state.phase !== "recovering") return false;
    state.geometry = null;
    state.stableSince = null;
    scheduleRecovery();
    return true;
  }, [active, scheduleRecovery]);

  const passiveScrollAction = useCallback((): PassiveScrollAction => {
    const state = stateRef.current;
    if (state.phase === "transition" && state.pinned) return "ignore";
    if (state.phase === "recovering") return "ignore";
    if (state.phase !== "grace") return "default";
    if (performance.now() > state.until) {
      stateRef.current = { phase: "idle" };
      return "default";
    }
    return isPinnedRef.current ? "follow" : "default";
  }, [isPinnedRef]);

  useLayoutEffect(() => {
    const wasActive = previousActiveRef.current;
    previousActiveRef.current = active;
    activeRef.current = active;

    if (active && !wasActive) {
      cancel();
      cancelPendingFollow();
      stateRef.current = {
        phase: "transition",
        pinned: isPinnedRef.current && !showScrollToBottomRef.current,
      };
      return;
    }
    if (active || !wasActive) return;
    const state = stateRef.current;
    if (state.phase !== "transition" || !state.pinned) {
      stateRef.current = { phase: "idle" };
      return;
    }

    onPreservePin();
    stateRef.current = {
      phase: "recovering",
      frameId: null,
      geometry: null,
      startedAt: null,
      stableSince: null,
    };
    scheduleRecovery();
  }, [active, cancel, cancelPendingFollow, isPinnedRef, onPreservePin, scheduleRecovery, showScrollToBottomRef]);

  useEffect(() => () => cancel(), [cancel]);

  useEffect(() => {
    if (previousThreadIdRef.current === threadId) return;
    previousThreadIdRef.current = threadId;
    cancel();
  }, [cancel, threadId]);

  return {
    cancel,
    consumeAtBottomChange,
    consumeGeometryChange,
    passiveScrollAction,
  };
}
