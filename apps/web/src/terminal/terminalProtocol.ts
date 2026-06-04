const TERMINAL_BEGIN_FRAME = 0x00;
const TERMINAL_STDIN_FRAME = 0x01;
const TERMINAL_RESIZE_FRAME = 0xff;

const textEncoder = new TextEncoder();

export type TerminalResizePayload = {
  cols: number;
  rows: number;
};

export function encodeTerminalBegin(): Uint8Array {
  return Uint8Array.of(TERMINAL_BEGIN_FRAME);
}

export function encodeTerminalStdin(data: string): Uint8Array {
  return withFrameByte(textEncoder.encode(data), TERMINAL_STDIN_FRAME);
}

export function encodeTerminalResize(size: TerminalResizePayload): Uint8Array {
  return withFrameByte(textEncoder.encode(JSON.stringify(size)), TERMINAL_RESIZE_FRAME);
}

function withFrameByte(payload: Uint8Array, frameByte: number): Uint8Array {
  const frame = new Uint8Array(payload.length + 1);
  frame.set(payload);
  frame[payload.length] = frameByte;
  return frame;
}
