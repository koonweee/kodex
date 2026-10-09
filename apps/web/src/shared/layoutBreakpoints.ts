import { useMediaQuery } from "@mantine/hooks";

export const NARROW_WORKSPACE_QUERY = "(max-width: 768px)";
const COMPACT_DIALOG_QUERY = "(max-width: 700px)";

export function readNarrowWorkspace() {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(NARROW_WORKSPACE_QUERY).matches;
}

export function useNarrowWorkspace() {
  return useMediaQuery(NARROW_WORKSPACE_QUERY, undefined, { getInitialValueInEffect: false });
}

// Portaled dialogs have viewport space, not their opener's pane dimensions.
export function useCompactDialog() {
  return useMediaQuery(COMPACT_DIALOG_QUERY, undefined, { getInitialValueInEffect: false });
}
