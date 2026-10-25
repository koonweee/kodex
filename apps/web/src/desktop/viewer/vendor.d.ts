declare module "@desktop-vendor/core/rfb.js" {
  export default class RFB extends EventTarget {
    constructor(target: HTMLElement, channel: WebSocket, options: { shared: boolean });
    viewOnly: boolean;
    scaleViewport: boolean;
    resizeSession: boolean;
    trackpadMode: boolean;
    focusOnClick: boolean;
    disconnect(): void;
    blur(): void;
    sendKey(keysym: number, code?: string | null, down?: boolean): void;
  }
}
declare module "@desktop-vendor/core/input/keyboard.js" {
  export default class Keyboard {
    constructor(target: HTMLElement);
    onkeyevent: (keysym: number, code: string, down: boolean) => void;
    grab(): void;
    ungrab(): void;
  }
}
declare module "@desktop-vendor/core/input/keysymdef.js" {
  const keysyms: { lookup(codePoint: number): number };
  export default keysyms;
}
