import { describe, expect, it } from "vitest";

import type { WorkspacePane } from "./paneTypes";
import { workspaceSubscribedThreadIds, workspaceSubscribedThreadIdsByExecutor } from "./resourceSubscriptions";

describe("workspaceSubscribedThreadIds", () => {
  it("dedupes thread resources across duplicate thread and app surface panes", () => {
    const panes: WorkspacePane[] = [
      pane("pane-a", "thread", { mode: "existing", threadId: "thread-1" }),
      pane("pane-b", "thread", { mode: "existing", threadId: "thread-1" }),
      pane("pane-c", "appSurface", { mode: "latest", threadId: "thread-1" }),
      pane("pane-d", "appSurface", { mode: "latest", threadId: "thread-2" }),
      pane("pane-e", "thread", { mode: "draft" }),
      pane("pane-f", "terminal", { terminalId: "terminal-1" }),
    ];

    expect(workspaceSubscribedThreadIds(panes)).toEqual(["thread-1", "thread-2"]);
  });

  it("keeps colliding thread subscriptions in separate executor channels", () => {
    const panes: WorkspacePane[] = [
      pane("first", "thread", { executorId: "executor-a", mode: "existing", threadId: "shared" }),
      pane("second", "thread", { executorId: "executor-b", mode: "existing", threadId: "shared" }),
      pane("app", "appSurface", { executorId: "executor-a", mode: "latest", threadId: "extra" }),
    ];

    expect(workspaceSubscribedThreadIdsByExecutor(panes)).toEqual(new Map([
      ["executor-a", ["shared", "extra"]],
      ["executor-b", ["shared"]],
    ]));
  });
});

function pane(id: string, kind: WorkspacePane["kind"], target: unknown): WorkspacePane {
  return {
    id,
    kind,
    target: { executorId: "local", ...(target as object) },
  } as WorkspacePane;
}
