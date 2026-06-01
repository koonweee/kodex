import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  App,
  FakeEventSource,
  baseRoutes,
  mockGateway,
  secondThread,
  thread,
  threadDetail,
} from "./test/mvpAppHarness";

function goTo(path: string) {
  window.history.replaceState(null, "", path);
}

function emitPopstate(path: string) {
  act(() => {
    window.history.pushState(null, "", path);
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

describe("deep link navigation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    FakeEventSource.instances = [];
  });

  it("loads the root route with a draft chat composer and no initial thread detail read", async () => {
    goTo("/");
    const gateway = mockGateway(baseRoutes());

    render(<App />);

    expect(await screen.findByRole("button", { name: /implement frontend/i })).toBeInTheDocument();
    const main = screen.getByRole("main", { name: /thread/i });
    expect(within(main).queryByText(/no thread selected/i)).not.toBeInTheDocument();
    expect(screen.getByLabelText(/message composer/i)).toBeEnabled();
    expect(screen.getByRole("button", { name: /project: no project/i })).toBeInTheDocument();
    expect(gateway.callsFor("GET", "/v1/threads/thread-1")).toHaveLength(0);
  });

  it("opens a deep-linked thread instead of selecting the first sidebar thread", async () => {
    goTo("/threads/thread-2");
    const gateway = mockGateway(
      baseRoutes({
        "GET /v1/threads": { threads: [thread, secondThread], nextCursor: null, backwardsCursor: null, rawPayload: {} },
        "GET /v1/threads/thread-2": threadDetail(secondThread),
      }),
    );

    render(<App />);

    expect(await screen.findByRole("heading", { name: /second thread/i })).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByLabelText(/message composer/i).closest(".kodex-composer-shell")).toHaveAttribute(
        "data-entry-ready",
        "true",
      );
    });
    expect(gateway.callsFor("GET", "/v1/threads/thread-2")).toHaveLength(1);
  });

  it("shows representative timeline skeleton rows while a selected thread snapshot loads", async () => {
    goTo("/threads/thread-2");
    const detailDeferred = deferred<ReturnType<typeof threadDetail>>();
    mockGateway(
      baseRoutes({
        "GET /v1/threads": { threads: [thread, secondThread], nextCursor: null, backwardsCursor: null, rawPayload: {} },
        "GET /v1/threads/thread-2": () => detailDeferred.promise,
      }),
    );

    const { container } = render(<App />);

    expect(await screen.findByRole("heading", { name: /second thread/i })).toBeInTheDocument();
    const loadingState = screen.getByRole("status", { name: /loading thread timeline/i });
    expect(loadingState).toHaveAttribute("aria-busy", "true");
    expect(container.querySelector(".kodex-timeline-skeleton-user")).toBeInTheDocument();
    expect(container.querySelector(".kodex-timeline-skeleton-assistant")).toBeInTheDocument();
    expect(container.querySelectorAll(".kodex-timeline-skeleton-user-bubble")).toHaveLength(1);
    expect(container.querySelectorAll(".kodex-timeline-skeleton-assistant")).toHaveLength(1);
    expect(container.querySelectorAll(".kodex-timeline-skeleton-user-line")).toHaveLength(2);
    expect(container.querySelectorAll(".kodex-timeline-skeleton-assistant-line")).toHaveLength(5);
    expect(container.querySelector(".kodex-timeline-skeleton-divider")).toBeInTheDocument();
    const composer = screen.getByLabelText(/message composer/i);
    expect(composer).toBeEnabled();
    await userEvent.type(composer, "Draft while loading");
    expect(composer).toHaveValue("Draft while loading");
    expect(screen.getByRole("button", { name: /open attachment menu/i })).toBeDisabled();
    expect(screen.queryByRole("button", { name: /permissions:/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /send message/i })).toBeDisabled();

    await act(async () => {
      detailDeferred.resolve(threadDetail(secondThread));
      await detailDeferred.promise;
    });

    await waitFor(() => {
      expect(screen.queryByRole("status", { name: /loading thread timeline/i })).not.toBeInTheDocument();
    });
    expect(screen.getByLabelText(/message composer/i)).toHaveValue("Draft while loading");
  });

  it("shows the timeline skeleton immediately for a deep-linked thread before the thread list resolves", async () => {
    goTo("/threads/thread-2");
    const threadsDeferred = deferred<{
      backwardsCursor: null;
      nextCursor: null;
      rawPayload: Record<string, never>;
      threads: typeof secondThread[];
    }>();
    const detailDeferred = deferred<ReturnType<typeof threadDetail>>();
    mockGateway(
      baseRoutes({
        "GET /v1/threads": () => threadsDeferred.promise,
        "GET /v1/threads/thread-2": () => detailDeferred.promise,
      }),
    );

    render(<App />);

    const main = screen.getByRole("main", { name: /thread/i });
    expect(screen.getByRole("status", { name: /loading thread timeline/i })).toBeInTheDocument();
    expect(within(main).queryByText(/no thread selected/i)).not.toBeInTheDocument();
    const composer = screen.getByLabelText(/message composer/i);
    expect(composer).toBeEnabled();
    await userEvent.type(composer, "Draft before thread list");
    expect(composer).toHaveValue("Draft before thread list");
    expect(screen.getByRole("button", { name: /open attachment menu/i })).toBeDisabled();
    expect(screen.queryByRole("button", { name: /permissions:/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /send message/i })).toBeDisabled();
  });

  it("keeps the detail snapshot authoritative when a stale sidebar list resolves later", async () => {
    goTo("/threads/thread-2");
    const threadsDeferred = deferred<{
      backwardsCursor: null;
      nextCursor: null;
      rawPayload: Record<string, never>;
      threads: typeof secondThread[];
    }>();
    mockGateway(
      baseRoutes({
        "GET /v1/threads": () => threadsDeferred.promise,
        "GET /v1/threads/thread-2": threadDetail({ ...secondThread, name: "Fresh deep link title" }),
      }),
    );

    render(<App />);

    expect(await screen.findByRole("heading", { name: /fresh deep link title/i })).toBeInTheDocument();

    await act(async () => {
      threadsDeferred.resolve({
        threads: [thread, { ...secondThread, name: "Stale sidebar title" }],
        nextCursor: null,
        backwardsCursor: null,
        rawPayload: {},
      });
      await threadsDeferred.promise;
    });

    expect(screen.getByRole("heading", { name: /fresh deep link title/i })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /stale sidebar title/i })).not.toBeInTheDocument();
  });

  it("does not let selected detail regress sidebar thread ordering timestamps", async () => {
    goTo("/");
    const frameworkThread = {
      ...thread,
      id: "thread-framework",
      name: "Framework thread",
      updatedAt: 300,
    };
    const middleThread = {
      ...thread,
      id: "thread-middle",
      name: "Middle thread",
      updatedAt: 200,
    };
    mockGateway(
      baseRoutes({
        "GET /v1/threads": {
          threads: [frameworkThread, middleThread],
          nextCursor: null,
          backwardsCursor: null,
          rawPayload: {},
        },
        "GET /v1/threads/thread-framework": threadDetail({
          ...frameworkThread,
          name: "Framework detail title",
          updatedAt: 100,
        }),
        "GET /v1/threads/thread-framework/queued-inputs": { queuedInputs: [] },
      }),
    );

    render(<App />);

    const frameworkButton = await screen.findByRole("button", { name: /framework thread/i });
    const middleButton = screen.getByRole("button", { name: /middle thread/i });
    expect(frameworkButton.compareDocumentPosition(middleButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    await userEvent.click(frameworkButton);
    expect(await screen.findByRole("heading", { name: /framework detail title/i })).toBeInTheDocument();

    const updatedFrameworkButton = screen
      .getAllByRole("button", { name: /framework detail title/i })
      .find((button) => button.classList.contains("kodex-thread-select-button"));
    expect(updatedFrameworkButton).toBeDefined();
    expect(updatedFrameworkButton!.compareDocumentPosition(middleButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("returns to the draft chat composer when browser navigation returns to the root route", async () => {
    goTo("/");
    mockGateway(
      baseRoutes({
        "GET /v1/threads": { threads: [thread, secondThread], nextCursor: null, backwardsCursor: null, rawPayload: {} },
        "GET /v1/threads/thread-2": threadDetail(secondThread),
      }),
    );

    render(<App />);

    await userEvent.click(await screen.findByRole("button", { name: /second thread/i }));
    expect(await screen.findByRole("heading", { name: /second thread/i })).toBeInTheDocument();
    expect(window.location.pathname).toBe("/threads/thread-2");

    emitPopstate("/");

    const main = screen.getByRole("main", { name: /thread/i });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /project: no project/i })).toBeInTheDocument();
    });
    expect(within(main).queryByText(/no thread selected/i)).not.toBeInTheDocument();
    expect(within(main).queryByRole("heading", { name: /second thread/i })).not.toBeInTheDocument();
  });

  it("uses mobile panel route state so back navigation can return from a thread to the selector", async () => {
    goTo("/");
    mockGateway(
      baseRoutes({
        "GET /v1/threads": { threads: [thread, secondThread], nextCursor: null, backwardsCursor: null, rawPayload: {} },
        "GET /v1/threads/thread-2": threadDetail(secondThread),
      }),
    );

    render(<App />);

    await userEvent.click(await screen.findByRole("button", { name: /show sidebar/i }));
    expect(window.location.pathname + window.location.search).toBe("/?panel=threads");
    expect(document.querySelector(".kodex-shell")).toHaveAttribute("data-mobile-panel", "threads");

    await userEvent.click(screen.getByRole("button", { name: /second thread/i }));
    expect(await screen.findByRole("heading", { name: /second thread/i })).toBeInTheDocument();
    expect(window.location.pathname + window.location.search).toBe("/threads/thread-2");
    expect(document.querySelector(".kodex-shell")).toHaveAttribute("data-mobile-panel", "chat");

    emitPopstate("/?panel=threads");

    expect(document.querySelector(".kodex-shell")).toHaveAttribute("data-mobile-panel", "threads");
    expect(window.location.pathname + window.location.search).toBe("/?panel=threads");
  });

  it("renders a dedicated unavailable pane for a missing deep-linked thread", async () => {
    goTo("/threads/missing-thread");
    mockGateway(baseRoutes());

    render(<App />);

    expect(await screen.findByRole("heading", { name: /thread not found or unavailable/i })).toBeInTheDocument();
    expect(window.location.pathname).toBe("/threads/missing-thread");
    expect(screen.getByRole("button", { name: /browse threads/i })).toBeInTheDocument();
  });
});
