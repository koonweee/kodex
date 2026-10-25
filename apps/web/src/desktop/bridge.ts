import type { components } from "../api/generated/schema";

export const DESKTOP_VIEWER_READY = "kodex.desktop.ready";

export type DesktopFailure = components["schemas"]["DesktopFailure"];
// Iframe presentation of Apple wire metadata, not a gateway REST DTO.
export type DesktopDisplay = { id: number; name: string; isMain: boolean };
export type ViewerState = {
  status: "connecting" | "connected" | "disconnected";
  failure?: DesktopFailure;
  retryable?: boolean;
  keyboardOpen: boolean;
  displays?: DesktopDisplay[];
  selectedDisplay?: number;
  displayLoading?: boolean;
  displayError?: string;
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
  setDisplay(id: number): void;
  paste(text: string): Promise<void>;
}

declare global {
  const __DESKTOP_VIEWER_URL__: string;
  interface Window { kodexDesktop?: DesktopBridge }
}
