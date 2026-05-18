import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const SOURCE_FILES = [
  "src/events/stream.ts",
  "src/timeline/batch.ts",
  "src/timeline/reducer.ts",
  "src/timeline/useReadonlyThreadTimeline.ts",
  "src/timeline/useSelectedThreadTimeline.ts",
  "src/App.tsx",
];

const RAW_THREAD_EVENTS = [
  "timeline.item_delta",
  "timeline.projection_patch",
  "timeline.snapshot_required",
];

describe("thread view lifecycle guardrails", () => {
  it("keeps browser-rendered thread lifecycle on canonical thread view events", () => {
    const appRoot = join(__dirname, "..", "..");
    for (const file of SOURCE_FILES) {
      const source = readFileSync(join(appRoot, file), "utf8");
      for (const rawEvent of RAW_THREAD_EVENTS) {
        expect(source, `${file} must not subscribe to or reduce ${rawEvent}`).not.toContain(rawEvent);
      }
    }
  });
});
