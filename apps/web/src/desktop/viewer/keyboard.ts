/*
 * Adapted from noVNC 1.6.0 app/ui.js virtual keyboard by Kodex (2026).
 * Copyright (C) The noVNC Authors. Licensed under MPL-2.0.
 * Corresponding original source and notices are distributed in ./sources/.
 */
import Keyboard from "@desktop-vendor/core/input/keyboard.js";
import keysyms from "@desktop-vendor/core/input/keysymdef.js";
import type RFB from "@desktop-vendor/core/rfb.js";

export function virtualKeyboard(input: HTMLTextAreaElement, getRfb: () => RFB | null, changed: (open: boolean) => void) {
  let active = false;
  let disposed = false;
  let focusTimer: ReturnType<typeof setTimeout> | undefined;
  let last = "";
  function reset() { input.value = last = "_".repeat(99); }
  const keyboard = new Keyboard(input);
  keyboard.onkeyevent = (keysym, code, down) => {
    if (active) getRfb()?.sendKey(keysym, code, down);
  };
  keyboard.grab();
  reset();

  function onFocus() {
    if (!active) { input.blur(); return; }
    const rfb = getRfb();
    if (rfb) rfb.focusOnClick = false;
    changed(true);
  }
  function releaseKeys() { keyboard.ungrab(); if (!disposed) keyboard.grab(); }
  function onBlur() {
    releaseKeys();
    const rfb = getRfb();
    if (rfb) rfb.focusOnClick = active;
    changed(false);
  }
  function onInput(event: Event) {
    if (!active || (event as InputEvent).isComposing) return;
    const next = input.value;
    const length = next.length;
    const oldPoints = Array.from(last);
    const newPoints = Array.from(next);
    let start = 0;
    while (start < Math.min(oldPoints.length, newPoints.length) && oldPoints[start] === newPoints[start]) start++;
    for (let i = start; i < oldPoints.length; i++) getRfb()?.sendKey(0xff08, "Backspace");
    // Compare Unicode code points too: replacing/deleting an emoji requires one
    // Backspace, even when its UTF-16 representation has two code units.
    for (const point of newPoints.slice(start)) getRfb()?.sendKey(keysyms.lookup(point.codePointAt(0)!));
    if (length > 198 || length < 1) {
      reset();
      if (length < 1) {
        input.blur();
        focusTimer = setTimeout(() => { if (active && !disposed) input.focus({ preventScroll: true }); }, 0);
      }
    } else { last = next; }
  }
  function keepKeyboard(event: MouseEvent) {
    if (document.activeElement === input) event.preventDefault();
  }
  input.addEventListener("focus", onFocus);
  input.addEventListener("blur", onBlur);
  input.addEventListener("input", onInput);
  document.documentElement.addEventListener("mousedown", keepKeyboard, true);
  return {
    setActive(value: boolean) {
      if (!value) releaseKeys();
      active = value;
      if (!value) { clearTimeout(focusTimer); input.blur(); }
    },
    setOpen(open: boolean) {
      if (open && active) {
        input.focus({ preventScroll: true });
        input.setSelectionRange(input.value.length, input.value.length);
      } else { releaseKeys(); input.blur(); }
    },
    dispose() {
      disposed = true;
      clearTimeout(focusTimer);
      keyboard.ungrab();
      active = false;
      input.removeEventListener("focus", onFocus);
      input.removeEventListener("blur", onBlur);
      input.removeEventListener("input", onInput);
      document.documentElement.removeEventListener("mousedown", keepKeyboard, true);
    },
  };
}
