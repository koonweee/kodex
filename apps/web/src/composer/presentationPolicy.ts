// Expansion is initiated by the editable field's own event, never a capability
// flag or focus signal. A compact pane in a wide workspace remains inline.
export function shouldExpandComposerOnTouch(narrowWorkspace: boolean, pointerType: string) {
  return narrowWorkspace && pointerType === "touch";
}

// Settings are a viewport-owned portal. Pane density must not select a sheet.
export function composerSettingsPresentation(compactDialog: boolean, availableCoarsePointer: boolean) {
  return compactDialog && availableCoarsePointer ? "sheet" : "anchored";
}
