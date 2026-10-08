// Expansion is initiated by the touch event that starts editing, either on an
// editable field or an action that creates one. Capability and focus signals
// alone never expand it. A compact pane in a wide workspace remains inline.
export function shouldExpandComposerOnTouch(narrowWorkspace: boolean, pointerType: string) {
  return narrowWorkspace && pointerType === "touch";
}

// Settings are a viewport-owned portal. Pane density must not select a sheet.
export function composerSettingsPresentation(compactDialog: boolean, availableCoarsePointer: boolean) {
  return compactDialog && availableCoarsePointer ? "sheet" : "anchored";
}
