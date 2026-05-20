import { MantineProvider } from "@mantine/core";
import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { idleTimelineEntry } from "../timeline/entry";
import { createTimelineState } from "../timeline/reducer";
import { ThreadPanel } from "./ThreadPanel";

describe("ThreadPanel", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows thread sync notices as transient overlay toasts", () => {
    vi.useFakeTimers();
    render(
      <MantineProvider>
        <ThreadPanel
          errorMessage={null}
          imagePreviewUrlsByPath={{}}
          isDraftThreadSelected={false}
          isSelectedTimelineLoading={false}
          onArchiveThread={() => undefined}
          onApprovalDecision={() => undefined}
          onImageOpen={() => undefined}
          onPinThread={() => undefined}
          onRenameThread={async () => undefined}
          onShowMobileSidebar={() => undefined}
          onTimelineReady={() => undefined}
          onUnpinThread={() => undefined}
          pendingTitleThreadIds={new Set()}
          scrollParentElement={null}
          selectedThread={null}
          selectedThreadApprovals={[]}
          selectedThreadTitle="New thread"
          selectedTimelineEntry={idleTimelineEntry}
          setTimelineScrollElement={() => undefined}
          showDebugEvents={false}
          threadSyncNotice={{
            message: "Selected thread stream disconnected. Reconnecting and retrying thread refresh.",
            tone: "warning",
          }}
          timeline={createTimelineState()}
        />
      </MantineProvider>,
    );

    const noticeText = screen.getByText(/selected thread stream disconnected/i);
    const notice = noticeText.closest('[role="status"]');
    expect(notice).toHaveClass("kodex-thread-sync-toast");
    expect(notice).not.toHaveClass("kodex-main-column");

    act(() => {
      vi.advanceTimersByTime(4500);
    });

    expect(screen.queryByText(/selected thread stream disconnected/i)).not.toBeInTheDocument();
  });
});
