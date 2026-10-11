import { describe, expect, it } from "vitest";

import { emptyPath, parseKodexLocation, projectPath, threadPath } from "./navigation";

describe("executor-qualified navigation", () => {
  it("round trips colliding thread ids through distinct executor paths", () => {
    const firstPath = threadPath("shared/thread", "executor-a");
    const secondPath = threadPath("shared/thread", "executor-b");

    expect(firstPath).toBe("/executors/executor-a/threads/shared%2Fthread");
    expect(secondPath).toBe("/executors/executor-b/threads/shared%2Fthread");
    expect(parseKodexLocation(new URL(firstPath, "https://kodex.test"))).toMatchObject({
      executorId: "executor-a",
      threadId: "shared/thread",
      view: "thread",
    });
    expect(parseKodexLocation(new URL(secondPath, "https://kodex.test"))).toMatchObject({
      executorId: "executor-b",
      threadId: "shared/thread",
      view: "thread",
    });
  });

  it("qualifies project paths by their executor", () => {
    const path = projectPath("project/one", "executor-a", { panel: "threads" });

    expect(path).toBe("/executors/executor-a/projects/project%2Fone?panel=threads");
    expect(parseKodexLocation(new URL(path, "https://kodex.test"))).toMatchObject({
      executorId: "executor-a",
      panel: "threads",
      projectId: "project/one",
      view: "project",
    });
  });

  it("keeps executor identity on draft routes", () => {
    const path = emptyPath("executor-a", { panel: "threads" });

    expect(path).toBe("/executors/executor-a?panel=threads");
    expect(parseKodexLocation(new URL(path, "https://kodex.test"))).toMatchObject({
      executorId: "executor-a",
      panel: "threads",
      threadId: null,
      view: "thread",
    });
  });

  it("keeps legacy combined push routes mapped to the current executor", () => {
    expect(parseKodexLocation(new URL("/threads/shared", "https://kodex.test"))).toMatchObject({
      executorId: null,
      threadId: "shared",
      view: "thread",
    });
  });
});
