import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type SyntheticEvent } from "react";
import { createDesktopConnection } from "./connection";
import { DESKTOP_VIEWER_READY, type DesktopBridge, type ViewerState } from "./bridge";

export function useDesktopViewer(enabled: boolean, visible: boolean) {
  const frame = useRef<HTMLIFrameElement>(null);
  const connection = useRef<ReturnType<typeof createDesktopConnection> | null>(null);
  const [loadedBridge, setLoadedBridge] = useState<DesktopBridge | null>(null);
  const readyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [frameKey, setFrameKey] = useState(0);
  const [trackpad, setTrackpad] = useState(true);
  const [state, setState] = useState<ViewerState>({ status: "connecting", keyboardOpen: false });
  const [error, setError] = useState<string | null>(null);
  const [pasting, setPasting] = useState(false);
  const pasteAttempt = useRef(0);
  const visibleRef = useRef(visible); visibleRef.current = visible;
  const trackpadRef = useRef(trackpad); trackpadRef.current = trackpad;

  const adoptBridge = useCallback(() => {
    const bridge = frame.current?.contentWindow?.kodexDesktop;
    if (!bridge) return false;
    clearTimeout(readyTimer.current);
    setLoadedBridge(bridge);
    return true;
  }, []);
  const awaitReady = useCallback(() => {
    if (adoptBridge()) return;
    clearTimeout(readyTimer.current);
    readyTimer.current = setTimeout(() => {
      if (!adoptBridge()) setError("The Desktop viewer could not load. Reconnect to try again.");
    }, 5000);
  }, [adoptBridge]);
  useLayoutEffect(() => {
    if (!enabled) return;
    const ready = (event: MessageEvent) => {
      if (event.source === frame.current?.contentWindow && event.origin === window.location.origin && event.data === DESKTOP_VIEWER_READY) adoptBridge();
    };
    window.addEventListener("message", ready);
    awaitReady();
    return () => { clearTimeout(readyTimer.current); window.removeEventListener("message", ready); };
  }, [enabled, frameKey, adoptBridge, awaitReady]);

  useEffect(() => {
    if (!enabled || !loadedBridge) return;
    const bridge = loadedBridge;
    setError(null); setPasting(false);
    bridge.setActive(visibleRef.current);
    bridge.setTrackpad(trackpadRef.current);
    const owner = createDesktopConnection(bridge, setState);
    connection.current = owner;
    return () => { pasteAttempt.current++; connection.current = null; owner.dispose(); };
  }, [enabled, loadedBridge]);
  useEffect(() => {
    if (!visible) { pasteAttempt.current++; setPasting(false); }
    connection.current?.setActive(visible);
  }, [visible, loadedBridge]);
  useEffect(() => { connection.current?.setTrackpad(trackpad); }, [trackpad, loadedBridge]);

  return useMemo(() => ({
    frame, frameKey, state, error, pasting, trackpad, setTrackpad,
    onLoad(event: SyntheticEvent<HTMLIFrameElement>) {
      if (event.currentTarget === frame.current) awaitReady();
    },
    reconnect() {
      pasteAttempt.current++; setPasting(false); setError(null);
      if (connection.current) connection.current.reconnect();
      else { setLoadedBridge(null); setFrameKey((current) => current + 1); }
    },
    setKeyboard(open: boolean) { connection.current?.setKeyboard(open); },
    async paste() {
      const owner = connection.current;
      if (!owner || pasting) return;
      const attempt = ++pasteAttempt.current;
      setError(null); setPasting(true);
      try {
        await owner.pasteFromClipboard(navigator.clipboard?.readText ? () => navigator.clipboard.readText() : undefined);
      } catch (failure) {
        if (connection.current === owner && pasteAttempt.current === attempt) setError(failure instanceof Error ? failure.message : "Clipboard paste failed.");
      } finally { if (connection.current === owner && pasteAttempt.current === attempt) setPasting(false); }
    },
  }), [frameKey, state, error, pasting, trackpad, awaitReady]);
}
