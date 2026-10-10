import { useCallback, useEffect, useRef, useState } from "react";
import type { PwaUpdateState } from "./registerServiceWorker";

export function usePwaUpdateCountdown(
  state: PwaUpdateState,
  autoUpdate: boolean,
  options: {
    autoUpdateBlocked?: boolean;
    required?: boolean;
    updateAction?: () => Promise<void>;
  } = {},
) {
  const revision = state.updateRevision;
  const [dismissedRevision, setDismissedRevision] = useState<number | null>(null);
  const [updatingOperation, setUpdatingOperation] = useState<number | null>(null);
  const [failure, setFailure] = useState<{ revision: number; message: string } | null>(null);
  const [seconds, setSeconds] = useState<number | null>(null);
  const [visible, setVisible] = useState(() => document.visibilityState !== "hidden");
  const applying = useRef<number | null>(null);
  const nextOperation = useRef(0);
  const latestRevision = useRef(revision);
  latestRevision.current = revision;
  const [choice, setChoice] = useState({ enabled: autoUpdate, manualThrough: 0 });
  const updateAction = options.updateAction ?? state.updateServiceWorker;
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
    if (!updateAction || applying.current !== null) return;
    const operation = ++nextOperation.current;
    applying.current = operation;
    setUpdatingOperation(operation);
    setFailure(null);
    try {
      await updateAction();
    } catch {
      if (applying.current !== operation) return;
      applying.current = null;
      setUpdatingOperation(null);
      setFailure({ revision: latestRevision.current, message: "Update failed. Try again." });
    }
  }, [updateAction]);
  const updating = updatingOperation !== null;
  const dismissed = dismissedRevision === revision;
  const error = failure && failure.revision === revision ? failure.message : null;
  const canCountDown = state.needRefresh && Boolean(updateAction) && autoUpdate
    && !options.autoUpdateBlocked && !options.required
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
