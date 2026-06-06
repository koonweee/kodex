import { MantineProvider } from "@mantine/core";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ThreadSummary } from "../api/client";
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
          onSetThreadNotificationsEnabled={() => undefined}
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
    expect(notice).not.toHaveClass("kodex-thread-column");

    act(() => {
      vi.advanceTimersByTime(4500);
    });

    expect(screen.queryByText(/selected thread stream disconnected/i)).not.toBeInTheDocument();
  });

  it("renders the thread notification toggle as checked by default and reports changes", async () => {
    const onSetThreadNotificationsEnabled = vi.fn();
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
          onSetThreadNotificationsEnabled={onSetThreadNotificationsEnabled}
          onShowMobileSidebar={() => undefined}
          onTimelineReady={() => undefined}
          onUnpinThread={() => undefined}
          pendingTitleThreadIds={new Set()}
          scrollParentElement={null}
          selectedThread={thread("thread-1")}
          selectedThreadApprovals={[]}
          selectedThreadTitle="Thread one"
          selectedTimelineEntry={idleTimelineEntry}
          setTimelineScrollElement={() => undefined}
          showDebugEvents={false}
          threadSyncNotice={null}
          timeline={createTimelineState()}
        />
      </MantineProvider>,
    );

    await userEvent.click(screen.getByRole("button", { name: /thread actions/i }));
    let toggle: HTMLElement | undefined;
    await waitFor(() => {
      toggle = screen.queryAllByRole("menuitem", { hidden: true }).find((element) =>
        /notifications/i.test(element.textContent ?? ""),
      );
      expect(toggle).toBeInTheDocument();
    });
    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(toggle).not.toHaveAttribute("data-active", "true");

    fireEvent.click(toggle!);

    expect(onSetThreadNotificationsEnabled).toHaveBeenCalledWith("thread-1", false);
    expect(screen.getByRole("button", { name: /thread actions/i })).toHaveAttribute("aria-expanded", "true");
  });

  it("keeps the app surface toggle grouped next to the thread actions menu", async () => {
    const onGeneratedUiHide = vi.fn();
    render(
      <MantineProvider>
        <ThreadPanel
          errorMessage={null}
          generatedUiAvailable
          generatedUiHidden={false}
          imagePreviewUrlsByPath={{}}
          isDraftThreadSelected={false}
          isSelectedTimelineLoading={false}
          onArchiveThread={() => undefined}
          onApprovalDecision={() => undefined}
          onGeneratedUiHide={onGeneratedUiHide}
          onImageOpen={() => undefined}
          onPinThread={() => undefined}
          onRenameThread={async () => undefined}
          onSetThreadNotificationsEnabled={() => undefined}
          onShowMobileSidebar={() => undefined}
          onTimelineReady={() => undefined}
          onUnpinThread={() => undefined}
          pendingTitleThreadIds={new Set()}
          scrollParentElement={null}
          selectedThread={thread("thread-1")}
          selectedThreadApprovals={[]}
          selectedThreadTitle="Thread one"
          selectedTimelineEntry={idleTimelineEntry}
          setTimelineScrollElement={() => undefined}
          showDebugEvents={false}
          threadSyncNotice={null}
          timeline={createTimelineState()}
        />
      </MantineProvider>,
    );

    const header = document.querySelector(".kodex-thread-header");
    expect(header).not.toBeNull();
    const headerButtonLabels = within(header as HTMLElement)
      .getAllByRole("button")
      .map((button) => button.getAttribute("aria-label"));
    expect(headerButtonLabels).toEqual([
      "Show sidebar",
      "Hide app surface",
      "Thread actions",
    ]);

    const generatedUiToggle = screen.getByRole("button", { name: /hide app surface/i });
    expect(generatedUiToggle).toHaveAttribute("aria-pressed", "true");

    await userEvent.click(generatedUiToggle);

    expect(onGeneratedUiHide).toHaveBeenCalledTimes(1);
  });
});

function thread(id: string, overrides: Partial<ThreadSummary> = {}): ThreadSummary {
  return {
    createdAt: 1,
    cwd: "/workspace",
    id,
    name: "Thread one",
    notificationsEnabled: true,
    rawPayload: {},
    seenCompletedAgentTurnSeq: 0,
    status: "idle",
    unreadCompletedAgentTurn: false,
    updatedAt: 2,
    ...overrides,
  };
}
