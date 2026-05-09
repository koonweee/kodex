export function isTouchInputDevice() {
  if (typeof navigator !== "undefined" && navigator.maxTouchPoints > 0) {
    return true;
  }
  if (typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia("(any-pointer: coarse)").matches || window.matchMedia("(pointer: coarse)").matches;
}
