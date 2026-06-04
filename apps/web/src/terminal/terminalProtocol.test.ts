import { describe, expect, it } from "vitest";

import { encodeTerminalBegin, encodeTerminalResize, encodeTerminalStdin } from "./terminalProtocol";

describe("terminal protocol", () => {
  it("encodes begin frames as a variant-only byte", () => {
    expect(Array.from(encodeTerminalBegin())).toEqual([0x00]);
  });

  it("encodes stdin as utf-8 bytes followed by the stdin variant", () => {
    expect(Array.from(encodeTerminalStdin("pwd\n"))).toEqual([112, 119, 100, 10, 0x01]);
  });

  it("encodes resize payloads followed by the resize variant", () => {
    const frame = encodeTerminalResize({ cols: 120, rows: 40 });
    const payload = new TextDecoder().decode(frame.slice(0, -1));

    expect(JSON.parse(payload)).toEqual({ cols: 120, rows: 40 });
    expect(frame.at(-1)).toBe(0xff);
  });
});
