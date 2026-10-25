import { Alert, Checkbox, Group, Popover, Text } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { ClipboardPaste, Keyboard, RotateCw, Settings } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { getCapabilities } from "../../api/client";
import { queryKeys } from "../../api/queryKeys";
import type { DesktopFailure } from "../../desktop/bridge";
import { useDesktopViewer } from "../../desktop/useDesktopViewer";
import { useInputCapabilities } from "../../shared/inputCapabilities";
import { PaneLayout } from "../../shared/PaneLayout";
import { AdaptiveIconButton } from "../../ui/AdaptiveIconButton";
import { useWorkspace } from "../../workspace/WorkspaceProvider";
import type { WorkspacePaneComponentProps } from "../../workspace/paneTypes";
import "./desktop.css";

const messages: Record<DesktopFailure, string> = {
  unsupportedPlatform: "Desktop requires a gateway running on macOS.",
  configuration: "The gateway’s VNC password is missing or invalid.",
  authentication: "The Mac rejected the gateway’s VNC password.",
  passwordAccessDisabled: "Enable “VNC viewers may control screen with password” in Screen Sharing settings on the gateway Mac.",
  protocol: "The Desktop viewer could not negotiate Screen Sharing.",
  connection: "Could not reach Screen Sharing on the gateway Mac.",
  timeout: "Screen Sharing did not respond in time.",
};

export function DesktopPane({ pane }: WorkspacePaneComponentProps) {
  const { data } = useQuery({ queryKey: queryKeys.capabilities, queryFn: ({ signal }) => getCapabilities(signal) });
  const enabled = data?.gateway.desktop?.enabled ?? false;
  const { visiblePaneIds, focusPane, setPaneHeaderActions } = useWorkspace();
  const visible = visiblePaneIds.includes(pane.id);
  const { hasTouchInput } = useInputCapabilities();
  const viewer = useDesktopViewer(enabled, visible);
  const [touchSettingsOpen, setTouchSettingsOpen] = useState(false);
  useEffect(() => { if (!visible) setTouchSettingsOpen(false); }, [visible]);
  const keyboardIntent = useRef<boolean | undefined>(undefined);
  const connected = viewer.state.status === "connected";
  const actions = useMemo(() => <Group gap={2} wrap="nowrap">
    {hasTouchInput ? <AdaptiveIconButton
      label={viewer.state.keyboardOpen ? "Hide remote keyboard" : "Show remote keyboard"}
      aria-pressed={viewer.state.keyboardOpen}
      disabled={!enabled || !connected}
      onPointerDownCapture={(event) => { keyboardIntent.current = !viewer.state.keyboardOpen; event.preventDefault(); }}
      onPointerCancel={() => { keyboardIntent.current = undefined; }}
      onClick={() => {
        viewer.setKeyboard(keyboardIntent.current ?? !viewer.state.keyboardOpen);
        keyboardIntent.current = undefined;
      }}
    ><Keyboard /></AdaptiveIconButton> : null}
    <AdaptiveIconButton label="Paste into Mac" disabled={!enabled || !connected || viewer.pasting} loading={viewer.pasting} onClick={() => void viewer.paste()}><ClipboardPaste /></AdaptiveIconButton>
    <AdaptiveIconButton label="Reconnect desktop" disabled={!enabled} onClick={viewer.reconnect}><RotateCw /></AdaptiveIconButton>
    <Popover withinPortal position="bottom-end" opened={touchSettingsOpen} onChange={setTouchSettingsOpen}>
      <Popover.Target><AdaptiveIconButton label="Desktop touch settings" disabled={!enabled} tooltip={false} onClick={() => setTouchSettingsOpen((open) => !open)}><Settings /></AdaptiveIconButton></Popover.Target>
      <Popover.Dropdown>
        <Checkbox label="Trackpad mode (touch)" checked={viewer.trackpad} onChange={(event) => { viewer.setTrackpad(event.currentTarget.checked); setTouchSettingsOpen(false); }} />
      </Popover.Dropdown>
    </Popover>
  </Group>, [enabled, connected, hasTouchInput, viewer, touchSettingsOpen]);
  useEffect(() => { setPaneHeaderActions(pane.id, actions); return () => setPaneHeaderActions(pane.id, null); }, [actions, pane.id, setPaneHeaderActions]);

  const message = !enabled ? "Desktop is unavailable until a VNC password is configured on the Mac gateway."
    : viewer.error ?? (viewer.state.failure ? messages[viewer.state.failure] : null);
  return <PaneLayout className="kodex-desktop-pane" aria-label="Mac desktop">
    {message ? <Alert color={enabled ? "red" : "blue"} title={enabled ? "Desktop connection" : "Desktop unavailable"}>{message}
      {enabled && viewer.state.retryable ? <Text size="sm">Retrying automatically…</Text> : null}
    </Alert> : enabled && !connected ? <Text className="kodex-desktop-status" role="status" size="sm">Connecting to the Mac…</Text> : null}
    {enabled ? <iframe ref={viewer.frame} key={viewer.frameKey} title="Mac desktop viewer" className="kodex-desktop-frame"
      src={__DESKTOP_VIEWER_URL__} onLoad={viewer.onLoad} inert={!visible} onFocus={() => focusPane(pane.id)} /> : null}
  </PaneLayout>;
}
