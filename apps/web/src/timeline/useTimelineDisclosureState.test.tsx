import { act, render } from "@testing-library/react";
import { useEffect } from "react";
import { describe, expect, it } from "vitest";

import type { TimelineRow } from "./reducer";
import { timelineItem } from "./testBuilders";
import { useTimelineDisclosureState } from "./useTimelineDisclosureState";

const sharedActivityRow: TimelineRow = {
  type: "activity",
  key: "activity-shared",
  turnKey: "turn-shared",
  turnId: "turn-shared",
  displayOrder: 1,
  items: [timelineItem({ id: "command-shared", kind: "command_execution", command: "pwd" })],
};

describe("useTimelineDisclosureState", () => {
  it("does not expose another thread's disclosure state for a reused row key", () => {
    const observations: Array<{ expanded: boolean; threadId: string }> = [];
    let openActivity: (() => void) | undefined;

    function Harness({ threadId }: { threadId: string }) {
      const disclosure = useTimelineDisclosureState([sharedActivityRow], threadId);
      observations.push({
        expanded: disclosure.activityPresentationByRowKey.get(sharedActivityRow.key)?.expanded ?? false,
        threadId,
      });
      useEffect(() => {
        openActivity = () => disclosure.handleActivityExpandedChange(sharedActivityRow.key, true);
      }, [disclosure.handleActivityExpandedChange]);
      return null;
    }

    const view = render(<Harness threadId="thread-one" />);
    act(() => openActivity?.());
    expect(observations.at(-1)).toEqual({ expanded: true, threadId: "thread-one" });

    const beforeSwitch = observations.length;
    view.rerender(<Harness threadId="thread-two" />);

    expect(observations.slice(beforeSwitch).filter((entry) => entry.threadId === "thread-two")[0]).toEqual({
      expanded: false,
      threadId: "thread-two",
    });
  });
});
