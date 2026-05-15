import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

describe("PWA assets", () => {
  it("includes a 512px PNG icon for installable manifests", () => {
    const icon = readFileSync(join(process.cwd(), "public/icon-512.png"));

    expect(icon.subarray(1, 4).toString("ascii")).toBe("PNG");
    expect(icon.readUInt32BE(16)).toBe(512);
    expect(icon.readUInt32BE(20)).toBe(512);
  });
});
