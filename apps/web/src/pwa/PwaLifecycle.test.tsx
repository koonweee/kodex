import { MantineProvider } from "@mantine/core";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PwaLifecycle } from "./PwaLifecycle";
import type { PwaUpdateState } from "./registerServiceWorker";

const mocks = vi.hoisted(() => ({
  listeners: new Set<(state: PwaUpdateState) => void>(),
  registerPwaServiceWorker: vi.fn(),
  state: {
    needRefresh: false,
    updateServiceWorker: null,
  } as PwaUpdateState,
}));

vi.mock("./registerServiceWorker", () => ({
  getPwaUpdateState: () => mocks.state,
  registerPwaServiceWorker: mocks.registerPwaServiceWorker,
  subscribeToPwaUpdates: (listener: (state: PwaUpdateState) => void) => {
    mocks.listeners.add(listener);
    return () => {
      mocks.listeners.delete(listener);
    };
  },
}));

function renderPwaLifecycle() {
  return render(
    <MantineProvider>
      <PwaLifecycle />
    </MantineProvider>,
  );
}

function emitPwaState(state: PwaUpdateState) {
  mocks.state = state;
  mocks.listeners.forEach((listener) => listener(state));
}

describe("PwaLifecycle", () => {
  beforeEach(() => {
    mocks.listeners.clear();
    mocks.state = {
      needRefresh: false,
      updateServiceWorker: null,
    };
    mocks.registerPwaServiceWorker.mockResolvedValue({ registered: true, registration: { scope: "/" } });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("registers the service worker and stays hidden until an update is needed", () => {
    renderPwaLifecycle();

    expect(mocks.registerPwaServiceWorker).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/update available/i)).toBeNull();
  });

  it("shows an update prompt and invokes the update callback", () => {
    const updateServiceWorker = vi.fn().mockResolvedValue(undefined);
    renderPwaLifecycle();

    act(() => {
      emitPwaState({
        needRefresh: true,
        updateServiceWorker,
      });
    });

    expect(screen.getByRole("status")).toHaveTextContent("Update available");
    fireEvent.click(screen.getByRole("button", { name: /update/i }));

    expect(updateServiceWorker).toHaveBeenCalledTimes(1);
  });
});
