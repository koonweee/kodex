import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";

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
  "timeline.item_upsert",
  "timeline.turn_upsert",
  "timeline.thread_status",
  "timeline.projection_patch",
  "timeline.snapshot_required",
];

const FORBIDDEN_DURABLE_NOTIFICATION_EVENT = "codex.notification";
const PRODUCTION_EVENT_SOURCE_DIRS = ["apps/gateway/src", "apps/web/src"];
const SOURCE_EXTENSIONS = new Set([".rs", ".ts", ".tsx"]);
const CODEX_NOTIFICATION_ALLOWLIST = [
  /event\.kind\s*!=\s*"codex\.notification"/,
  /event\.kind\s*!==\s*"codex\.notification"/,
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

  it("keeps durable app-server notification storage deleted from production code", () => {
    const appRoot = join(__dirname, "..", "..");
    const repoRoot = join(appRoot, "..", "..");
    const violations: string[] = [];

    for (const dir of PRODUCTION_EVENT_SOURCE_DIRS) {
      for (const file of productionSourceFiles(join(repoRoot, dir))) {
        const source = readFileSync(file, "utf8");
        source.split("\n").forEach((line, index) => {
          if (
            line.includes(FORBIDDEN_DURABLE_NOTIFICATION_EVENT) &&
            !CODEX_NOTIFICATION_ALLOWLIST.some((pattern) => pattern.test(line))
          ) {
            violations.push(`${relative(repoRoot, file)}:${index + 1}: ${line.trim()}`);
          }
        });
      }
    }

    expect(violations).toEqual([]);
  });
});

function productionSourceFiles(root: string): string[] {
  return readdirSync(root).flatMap((entry) => {
    const path = join(root, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      return entry === "__fixtures__" ? [] : productionSourceFiles(path);
    }
    if (!SOURCE_EXTENSIONS.has(extname(path))) {
      return [];
    }
    if (/\.(test|spec)\.[^.]+$/.test(path) || path.endsWith(".d.ts")) {
      return [];
    }
    return [path];
  });
}
