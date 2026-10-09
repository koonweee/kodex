import { useCallback, useEffect, useRef, useState } from "react";
import type { PwaUpdateState } from "./registerServiceWorker";

export function usePwaUpdateCountdown(state: PwaUpdateState, autoUpdate: boolean) {
  const revision = state.updateRevision;
  const [dismissedRevision, setDismissedRevision] = useState<number | null>(null);
  const [updatingRevision, setUpdatingRevision] = useState<number | null>(null);
  const [failure, setFailure] = useState<{ revision: number; message: string } | null>(null);
  const [seconds, setSeconds] = useState<number | null>(null);
  const [visible, setVisible] = useState(() => document.visibilityState !== "hidden");
  const applying = useRef<number | null>(null);
  const [choice, setChoice] = useState({ enabled: autoUpdate, manualThrough: 0 });
  if (choice.enabled !== autoUpdate) {
    // Opting in affects future notices; never begin reloading the banner being edited.
    setChoice({ enabled: autoUpdate, manualThrough: autoUpdate ? revision : choice.manualThrough });
  }
  useEffect(() => {
    const onVisibility = () => setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  const update = useCallback(async () => {
    if (!state.updateServiceWorker || (applying.current !== null && applying.current >= revision)) return;
    applying.current = revision;
    setUpdatingRevision(revision);
    setFailure(null);
    try {
      await state.updateServiceWorker();
    } catch {
      if (applying.current !== revision) return;
      applying.current = null;
      setUpdatingRevision(null);
      setFailure({ revision, message: "Update failed. Try again." });
    }
  }, [revision, state.updateServiceWorker]);
  const updating = updatingRevision === revision;
  const dismissed = dismissedRevision === revision;
  const error = failure && failure.revision === revision ? failure.message : null;
  const canCountDown = state.needRefresh && Boolean(state.updateServiceWorker) && autoUpdate
    && revision > choice.manualThrough && !dismissed && !updating && !error && visible;
  useEffect(() => {
    if (!canCountDown) { setSeconds(null); return; }
    setSeconds(3);
    const interval = window.setInterval(() => setSeconds(current => current !== null && current > 1 ? current - 1 : current), 1000);
    const timeout = window.setTimeout(() => { window.clearInterval(interval); void update(); }, 3000);
    return () => { window.clearInterval(interval); window.clearTimeout(timeout); };
  }, [canCountDown, revision, update]);

  return {
    countdown: canCountDown ? seconds : null, dismissed, updating, error, update,
    dismiss: () => setDismissedRevision(revision),
  };
}
