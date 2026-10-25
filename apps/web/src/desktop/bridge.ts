import type { components } from "../api/generated/schema";

export type DesktopFailure = components["schemas"]["DesktopFailure"];
export type ViewerState = {
  status: "connecting" | "connected" | "disconnected";
  failure?: DesktopFailure;
  retryable?: boolean;
  keyboardOpen: boolean;
};

// Only the current same-origin iframe exposes this object. No evaluation, host,
// credentials, general messaging, or arbitrary socket arguments cross this seam.
export interface DesktopBridge {
  subscribe(listener: (state: ViewerState) => void): () => void;
  connect(): void;
  disconnect(): void;
  setActive(active: boolean): void;
  setTrackpad(enabled: boolean): void;
  setKeyboard(open: boolean): void;
  paste(text: string): Promise<void>;
}

declare global {
  const __DESKTOP_VIEWER_URL__: string;
  interface Window { kodexDesktop?: DesktopBridge }
}
