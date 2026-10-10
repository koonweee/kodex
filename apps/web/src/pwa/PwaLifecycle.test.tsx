import { MantineProvider } from "@mantine/core";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PwaLifecycle } from "./PwaLifecycle";
import { observeApiVersion, resetCompatibilityForTests } from "../api/compatibility";
import { AppearancePreferencesPanel } from "../preferences/AppearancePreferencesPanel";
import { readStoredInterfacePreferences } from "../preferences/useInterfacePreferences";
import type { PwaUpdateState } from "./registerServiceWorker";

const mocks = vi.hoisted(() => ({
  listeners: new Set<(state: PwaUpdateState) => void>(),
  applyLatestFrontendUpdate: vi.fn(),
  registerPwaServiceWorker: vi.fn(),
  state: {
    needRefresh: false,
    updateRevision: 0,
    updateServiceWorker: null,
  } as PwaUpdateState,
}));

vi.mock("./registerServiceWorker", () => ({
  applyLatestFrontendUpdate: mocks.applyLatestFrontendUpdate,
  getPwaUpdateState: () => mocks.state,
  registerPwaServiceWorker: mocks.registerPwaServiceWorker,
  subscribeToPwaUpdates: (listener: (state: PwaUpdateState) => void) => {
    mocks.listeners.add(listener);
    return () => {
      mocks.listeners.delete(listener);
    };
  },
}));

function renderPwaLifecycle(withPreferences = false, hasComposerTextDraft = false) {
  return render(
    <MantineProvider>
      <PwaLifecycle hasComposerTextDraft={hasComposerTextDraft} />
      {withPreferences ? <AppearancePreferencesPanel
        preferences={{ mode: "auto", lightThemeId: "paper-light", darkThemeId: "oled-black" }}
        resolvedSchemeId="paper-light" onModeChange={vi.fn()} onThemeChange={vi.fn()}
      /> : null}
    </MantineProvider>,
  );
}

function emitPwaState(state: Omit<PwaUpdateState, "updateRevision"> & { updateRevision?: number }) {
  const updateRevision = state.updateRevision ?? (mocks.state.needRefresh ? mocks.state.updateRevision : mocks.state.updateRevision + 1);
  mocks.state = { ...state, updateRevision };
  mocks.listeners.forEach((listener) => listener(mocks.state));
}

describe("PwaLifecycle", () => {
  beforeEach(() => {
    window.localStorage.clear();
    readStoredInterfacePreferences(true);
    vi.useFakeTimers();
    mocks.listeners.clear();
    mocks.state = {
      needRefresh: false,
      updateRevision: 0,
      updateServiceWorker: null,
    };
    mocks.registerPwaServiceWorker.mockResolvedValue({ registered: true, registration: { scope: "/" } });
    mocks.applyLatestFrontendUpdate.mockImplementation(async () => {
      if (!mocks.state.updateServiceWorker) throw new Error("Update is unavailable");
      await mocks.state.updateServiceWorker();
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.restoreAllMocks();
    vi.useRealTimers();
    resetCompatibilityForTests();
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
    fireEvent.click(screen.getByRole("button", { name: "Update" }));

    expect(updateServiceWorker).toHaveBeenCalledTimes(1);
  });

  it("persists auto update for future notices and counts down once from three", async () => {
    window.localStorage.setItem("kodex-interface", JSON.stringify({ autoUpdatePwa: true }));
    renderPwaLifecycle();
    const updateServiceWorker = vi.fn().mockResolvedValue(undefined);
    act(() => emitPwaState({ needRefresh: true, updateServiceWorker }));
    expect(screen.getByRole("status")).toHaveTextContent("Updating in 3s");
    await act(async () => vi.advanceTimersByTime(1000));
    expect(screen.getByRole("status")).toHaveTextContent("Updating in 2s");
    act(() => emitPwaState({ needRefresh: true, updateServiceWorker }));
    await act(async () => vi.advanceTimersByTime(1000));
    expect(screen.getByRole("status")).toHaveTextContent("Updating in 1s");
    await act(async () => vi.advanceTimersByTime(1000));
    expect(updateServiceWorker).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTime(5000));
    expect(updateServiceWorker).toHaveBeenCalledTimes(1);
  });

  it("keeps a text draft manual and cancels a running countdown when text appears", async () => {
    localStorage.setItem("kodex-interface", JSON.stringify({ autoUpdatePwa: true }));
    const updateServiceWorker = vi.fn().mockResolvedValue(undefined);
    const view = renderPwaLifecycle(false, true);
    act(() => emitPwaState({ needRefresh: true, updateServiceWorker }));
    expect(screen.getByRole("status")).toHaveTextContent("Update available");
    await act(async () => vi.advanceTimersByTime(4000));
    expect(updateServiceWorker).not.toHaveBeenCalled();

    view.rerender(<MantineProvider><PwaLifecycle hasComposerTextDraft={false} /></MantineProvider>);
    expect(screen.getByRole("status")).toHaveTextContent("Updating in 3s");
    await act(async () => vi.advanceTimersByTime(1000));
    view.rerender(<MantineProvider><PwaLifecycle hasComposerTextDraft /></MantineProvider>);
    expect(screen.getByRole("status")).toHaveTextContent("Update available");
    await act(async () => vi.advanceTimersByTime(4000));
    expect(updateServiceWorker).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Update" })).toBeEnabled();
  });

  it("renders an API mismatch through the compact required-update state", () => {
    const updateServiceWorker = vi.fn().mockResolvedValue(undefined);
    renderPwaLifecycle();
    act(() => {
      emitPwaState({ needRefresh: true, updateServiceWorker });
      observeApiVersion("future");
    });
    expect(screen.getByRole("status")).toHaveTextContent("Update required");
    expect(screen.getByRole("button", { name: "Update" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Dismiss update notice" })).toBeNull();
    const details = screen.getByRole("button", { name: "Update details" });
    expect(details).toBeVisible();
    fireEvent.click(details);
    act(() => vi.advanceTimersByTime(300));
    expect(screen.getByRole("tooltip")).toHaveTextContent("server API changed");
  });

  it("keeps a compatibility update in flight when it discovers a PWA revision", async () => {
    let rejectUpdate!: (reason: Error) => void;
    const updateServiceWorker = vi.fn().mockResolvedValue(undefined);
    mocks.applyLatestFrontendUpdate.mockImplementation(() => {
      emitPwaState({ needRefresh: true, updateRevision: 1, updateServiceWorker });
      return new Promise<void>((_, reject) => { rejectUpdate = reject; });
    });
    renderPwaLifecycle();
    act(() => observeApiVersion("future"));

    fireEvent.click(screen.getByRole("button", { name: "Update" }));
    expect(screen.getByRole("status")).toHaveTextContent("Updating…");
    expect(screen.getByRole("button", { name: "Update" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Update" }));
    expect(mocks.applyLatestFrontendUpdate).toHaveBeenCalledTimes(1);

    await act(async () => rejectUpdate(new Error("activation failed")));
    expect(screen.getByRole("status")).toHaveTextContent("Update failed");
    expect(screen.getByRole("button", { name: "Update" })).toBeEnabled();
  });

  it("enabling auto update leaves the current notice manual", async () => {
    const updateServiceWorker = vi.fn().mockResolvedValue(undefined);
    act(() => emitPwaState({ needRefresh: true, updateServiceWorker }));
    renderPwaLifecycle(true);
    fireEvent.click(screen.getByRole("switch", { name: "Auto-update" }));
    expect(JSON.parse(localStorage.getItem("kodex-interface")!).autoUpdatePwa).toBe(true);
    await act(async () => vi.advanceTimersByTime(5000));
    expect(updateServiceWorker).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent("Update available");
    act(() => emitPwaState({ needRefresh: true, updateServiceWorker, updateRevision: 2 }));
    expect(screen.getByRole("status")).toHaveTextContent("Updating in 3s");
  });

  it("cancels on disable, dismiss and unmount, but offers a later bundle again", async () => {
    localStorage.setItem("kodex-interface", JSON.stringify({ autoUpdatePwa: true }));
    const updateServiceWorker = vi.fn().mockResolvedValue(undefined);
    const view = renderPwaLifecycle(true);
    act(() => emitPwaState({ needRefresh: true, updateServiceWorker }));
    await act(async () => vi.advanceTimersByTime(1000));
    fireEvent.click(screen.getByRole("switch", { name: "Auto-update" }));
    await act(async () => vi.advanceTimersByTime(4000));
    expect(updateServiceWorker).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("switch", { name: "Auto-update" }));
    act(() => emitPwaState({ needRefresh: true, updateServiceWorker, updateRevision: 2 }));
    fireEvent.click(screen.getByRole("button", { name: "Dismiss update notice" }));
    await act(async () => vi.advanceTimersByTime(4000));
    expect(updateServiceWorker).not.toHaveBeenCalled();
    act(() => emitPwaState({ needRefresh: true, updateServiceWorker, updateRevision: 3 }));
    expect(screen.getByRole("status")).toHaveTextContent("Updating in 3s");
    view.unmount();
    await act(async () => vi.advanceTimersByTime(4000));
    expect(updateServiceWorker).not.toHaveBeenCalled();
  });

  it("gives a visible page three seconds after returning from the background", async () => {
    localStorage.setItem("kodex-interface", JSON.stringify({ autoUpdatePwa: true }));
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    const updateServiceWorker = vi.fn().mockResolvedValue(undefined);
    renderPwaLifecycle();
    act(() => emitPwaState({ needRefresh: true, updateServiceWorker }));
    await act(async () => vi.advanceTimersByTime(5000));
    expect(updateServiceWorker).not.toHaveBeenCalled();
    visibility.mockReturnValue("visible");
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(screen.getByRole("status")).toHaveTextContent("Updating in 3s");
    await act(async () => vi.advanceTimersByTime(1000));
    visibility.mockReturnValue("hidden");
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await act(async () => vi.advanceTimersByTime(4000));
    expect(updateServiceWorker).not.toHaveBeenCalled();
    visibility.mockReturnValue("visible");
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(screen.getByRole("status")).toHaveTextContent("Updating in 3s");
    await act(async () => vi.advanceTimersByTime(3000));
    expect(updateServiceWorker).toHaveBeenCalledTimes(1);
  });

  it("offers an explicit retry after failure without automatically retrying", async () => {
    localStorage.setItem("kodex-interface", JSON.stringify({ autoUpdatePwa: true }));
    const updateServiceWorker = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(undefined);
    renderPwaLifecycle();
    act(() => emitPwaState({ needRefresh: true, updateServiceWorker }));
    await act(async () => vi.advanceTimersByTime(3000));
    expect(screen.getByRole("status")).toHaveTextContent("Update failed");
    expect(screen.getByRole("button", { name: "Update details" })).toBeVisible();
    await act(async () => vi.advanceTimersByTime(9000));
    expect(updateServiceWorker).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Update" }));
    expect(updateServiceWorker).toHaveBeenCalledTimes(2);
  });

  it("keeps one attempt active across revision changes and retries the current update", async () => {
    localStorage.setItem("kodex-interface", JSON.stringify({ autoUpdatePwa: true }));
    let rejectOld!: (reason: Error) => void;
    const older = vi.fn(() => new Promise<void>((_, reject) => { rejectOld = reject; }));
    const newer = vi.fn().mockRejectedValue(new Error("newer failed"));
    renderPwaLifecycle();
    act(() => emitPwaState({ needRefresh: true, updateServiceWorker: older, updateRevision: 1 }));
    await act(async () => vi.advanceTimersByTime(3000));
    act(() => emitPwaState({ needRefresh: true, updateServiceWorker: newer, updateRevision: 2 }));
    await act(async () => vi.advanceTimersByTime(3000));
    expect(screen.getByRole("status")).toHaveTextContent("Updating…");
    expect(newer).not.toHaveBeenCalled();
    await act(async () => rejectOld(new Error("older failed late")));
    expect(screen.getByRole("status")).toHaveTextContent("Update failed");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Update" })));
    expect(newer).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status")).toHaveTextContent("Update failed");
  });

  it("manual acceptance during the countdown applies only once", async () => {
    localStorage.setItem("kodex-interface", JSON.stringify({ autoUpdatePwa: true }));
    const updateServiceWorker = vi.fn().mockResolvedValue(undefined);
    renderPwaLifecycle();
    act(() => emitPwaState({ needRefresh: true, updateServiceWorker }));
    fireEvent.click(screen.getByRole("button", { name: "Update" }));
    await act(async () => vi.advanceTimersByTime(4000));
    expect(updateServiceWorker).toHaveBeenCalledTimes(1);
  });

  it("can defer the update without accepting it until the app is reopened", () => {
    const updateServiceWorker = vi.fn().mockResolvedValue(undefined);
    act(() => emitPwaState({ needRefresh: true, updateServiceWorker }));
    const view = renderPwaLifecycle();

    fireEvent.click(screen.getByRole("button", { name: "Dismiss update notice" }));
    expect(screen.queryByRole("status")).toBeNull();
    expect(updateServiceWorker).not.toHaveBeenCalled();

    act(() => emitPwaState({ needRefresh: true, updateServiceWorker }));
    expect(screen.queryByRole("status")).toBeNull();
    view.unmount();
    renderPwaLifecycle();
    expect(screen.getByRole("status")).toHaveTextContent("Update available");
  });
});
