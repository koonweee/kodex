import { describe, expect, it } from "vitest";
import { createTimelineIndexBuilder } from "./indexBuilder";
import { timelineItems } from "./state";
import { timelineItem } from "./testBuilders";

describe("timeline index construction", () => {
  it("orders nested and standalone items globally, keeps ties stable, and preserves turn membership", () => {
    const builder = createTimelineIndexBuilder();
    const first = timelineItem({ id: "first", displayOrder: 4 });
    const tied = timelineItem({ id: "tied", displayOrder: 4 });
    const earlier = timelineItem({ id: "earlier", displayOrder: 1, turnId: "turn-2" });
    builder.addRow({ type: "work", key: "work", turnKey: "turn-1", turnId: "turn-1", state: "completed", displayOrder: 0,
      collapsedRows: [{ type: "activity", key: "activity", turnKey: "turn-1", turnId: "turn-1", displayOrder: 0, items: [first, tied] }],
    });
    builder.addRow({ type: "item", key: "earlier", turnKey: "turn-2", turnId: "turn-2", displayOrder: 1, item: earlier });
    builder.addItem(timelineItem({ ...first, text: "Updated", output: "Result" }));
    const indexes = builder.finish();
    expect(timelineItems(indexes).map(item => [item.id, item.text])).toEqual([["earlier", ""], ["first", "Updated"], ["tied", ""]]);
    expect(indexes.turnIds).toEqual(["turn-1", "turn-2"]);
    expect(indexes.turnById.get("turn-1")?.itemIds).toEqual(["first", "tied"]);
    expect(first.text).toBe("");
    expect(tied.text).toBe("");
  });

  it("retains prior same-ID content and merges images and actions without changing native identities", () => {
    const builder = createTimelineIndexBuilder();
    builder.addItem(timelineItem({ id: "native-1", clientId: "shared-client", text: "Prior", output: "Output", images: [{ path: "/one.png" }], actions: [{ kind: "search", query: "first" }] }));
    builder.addItem(timelineItem({ id: "native-1", clientId: "shared-client", images: [{ path: "/two.png" }], actions: [{ kind: "search", query: "second" }] }));
    builder.addItem(timelineItem({ id: "native-2", clientId: "shared-client", text: "Separate" }));
    expect(timelineItems(builder.finish())).toMatchObject([
      { id: "native-1", text: "Prior", output: "Output", images: [{ path: "/one.png" }, { path: "/two.png" }], actions: [{ query: "first" }, { query: "second" }] },
      { id: "native-2", text: "Separate" },
    ]);
  });

  it("resolves agent names in display order and invalidates names only when collaboration items change", () => {
    const builder = createTimelineIndexBuilder();
    builder.addItem(timelineItem({ id: "later", kind: "collab_agent_tool_call", displayOrder: 5, collab: { agents: [{ threadId: "agent", displayName: "Reviewer 1", role: "reviewer", nameSource: "role" }] } }));
    builder.addItem(timelineItem({ id: "earlier", kind: "collab_agent_tool_call", displayOrder: 1, collab: { agents: [{ threadId: "agent", displayName: "Ada [reviewer]", nickname: "Ada", role: "reviewer", nameSource: "metadata" }] } }));
    const names = builder.collabAgentNames();
    expect(names.get("agent")).toMatchObject({ displayName: "Ada [reviewer]", nickname: "Ada" });
    builder.addItem(timelineItem({ id: "command", kind: "command_execution" }));
    expect(builder.collabAgentNames()).toBe(names);
    builder.addItem(timelineItem({ id: "later", kind: "collab_agent_tool_call", displayOrder: 5, collab: { agents: [{ threadId: "agent", displayName: "Grace [reviewer]", nickname: "Grace", role: "reviewer", nameSource: "metadata" }] } }));
    expect(builder.collabAgentNames().get("agent")?.displayName).toBe("Grace [reviewer]");
    expect(names.get("agent")?.displayName).toBe("Ada [reviewer]");
  });
});
