import { useKeyboardViewport } from "../shared/useKeyboardViewport";

export function useComposerKeyboardViewport(enabled = true, owner?: HTMLElement | null) {
  return useKeyboardViewport(enabled, owner?.closest(".kodex-thread-pane"));
}
