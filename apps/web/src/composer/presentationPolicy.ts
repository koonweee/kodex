// Expansion is initiated by the touch event that starts editing, either on an
// editable field or an action that creates one. Capability, width and focus
// signals alone never expand it.
export function shouldExpandComposerOnTouch(fullscreenOnTouch: boolean, pointerType: string) {
  return fullscreenOnTouch && pointerType === "touch";
}

// Settings are a viewport-owned portal. Pane density must not select a sheet.
export function composerSettingsPresentation(compactDialog: boolean, availableCoarsePointer: boolean) {
  return compactDialog && availableCoarsePointer ? "sheet" : "anchored";
}
