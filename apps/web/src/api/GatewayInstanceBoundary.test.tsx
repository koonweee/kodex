import { MantineProvider } from "@mantine/core";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PwaLifecycle } from "../pwa/PwaLifecycle";
import { getCapabilities, type Capabilities } from "./client";
import { GatewayInstanceBoundary, useGatewayInstanceStorage } from "./GatewayInstanceBoundary";
import { createKodexQueryClient } from "./queryClient";
import { queryKeys } from "./queryKeys";

const pwa = vi.hoisted(() => ({
  needRefresh: false,
  register: vi.fn().mockResolvedValue({ registered: false, reason: "unsupported" }),
  update: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./client", () => ({ getCapabilities: vi.fn() }));
vi.mock("../pwa/registerServiceWorker", () => ({
  getPwaUpdateState: () => ({ needRefresh: pwa.needRefresh, updateServiceWorker: pwa.update }),
  registerPwaServiceWorker: pwa.register,
  subscribeToPwaUpdates: () => () => undefined,
}));

function capabilities(instanceId: string): Capabilities {
  return {
    gateway: { instanceId, version: "test", sse: true, approvals: true, terminals: { enabled: true }, gatewayAuth: false, trustedNetworkOnly: true },
    appServer: { ready: true, experimentalApi: true, schemaVersion: "0.160.0", detectedVersion: "0.160.0", detectedVersionMatchesSchema: true },
  };
}

function WorkspaceProbe() {
  const storage = useGatewayInstanceStorage();
  const [draft, setDraft] = useState(() => storage?.getItem("draft") ?? "fresh draft");
  return <button onClick={() => { storage?.setItem("draft", "edited draft"); setDraft("edited draft"); }}>{draft}</button>;
}

afterEach(() => {
  vi.clearAllMocks();
  pwa.needRefresh = false;
  window.localStorage.clear();
});

describe("gateway instance bootstrap", () => {
  it("opens the standalone theme workbench without checking or mounting instance state", () => {
    window.history.replaceState(null, "", "/__theme");
    const queryClient = createKodexQueryClient();
    queryClient.setQueryData(queryKeys.projects, [{ id: "untouched-project" }]);
    render(<GatewayInstanceBoundary queryClient={queryClient}><div>Theme workbench</div></GatewayInstanceBoundary>);

    expect(screen.getByText("Theme workbench")).toBeInTheDocument();
    expect(getCapabilities).not.toHaveBeenCalled();
    expect(queryClient.getQueryData(queryKeys.projects)).toEqual([{ id: "untouched-project" }]);
  });

  it("keeps a waiting PWA update usable when the initial identity check fails", async () => {
    pwa.needRefresh = true;
    vi.mocked(getCapabilities).mockRejectedValueOnce(new Error("Gateway unavailable"));
    render(
      <GatewayInstanceBoundary queryClient={createKodexQueryClient()}>
        <MantineProvider><PwaLifecycle /><WorkspaceProbe /></MantineProvider>
      </GatewayInstanceBoundary>,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent("Unable to connect");
    expect(screen.getByRole("status")).toHaveTextContent("Update available");
    fireEvent.click(screen.getByRole("button", { name: "Update" }));
    expect(pwa.update).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "fresh draft" })).not.toBeInTheDocument();

    vi.mocked(getCapabilities).mockResolvedValueOnce(capabilities("valid"));
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("button", { name: "fresh draft" })).toBeInTheDocument();
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Update" })).toBeInTheDocument();
  });

  it("waits for a fresh identity even when capabilities and thread data are cached", async () => {
    const queryClient = createKodexQueryClient();
    queryClient.setQueryData(queryKeys.capabilities, capabilities("old"));
    queryClient.setQueryData(queryKeys.projects, [{ id: "old-project" }]);
    let resolve!: (value: Capabilities) => void;
    vi.mocked(getCapabilities).mockReturnValueOnce(new Promise((done) => { resolve = done; }));

    render(<GatewayInstanceBoundary queryClient={queryClient}><WorkspaceProbe /></GatewayInstanceBoundary>);
    expect(screen.queryByRole("button", { name: "fresh draft" })).not.toBeInTheDocument();

    await act(async () => resolve(capabilities("new")));
    expect(await screen.findByRole("button", { name: "fresh draft" })).toBeInTheDocument();
    expect(queryClient.getQueryData(queryKeys.projects)).toBeUndefined();
    expect(queryClient.getQueryData(queryKeys.capabilities)).toEqual(capabilities("new"));
  });

  it("preserves same-instance drafts and remounts with fresh state when the gateway changes", async () => {
    const queryClient = createKodexQueryClient();
    vi.mocked(getCapabilities).mockResolvedValue(capabilities("first"));
    render(<GatewayInstanceBoundary queryClient={queryClient}><WorkspaceProbe /></GatewayInstanceBoundary>);
    fireEvent.click(await screen.findByRole("button", { name: "fresh draft" }));

    await act(async () => { window.dispatchEvent(new Event("online")); });
    expect(screen.getByRole("button", { name: "edited draft" })).toBeInTheDocument();

    vi.mocked(getCapabilities).mockResolvedValue(capabilities("second"));
    await act(async () => { window.dispatchEvent(new Event("online")); });
    expect(await screen.findByRole("button", { name: "fresh draft" })).toBeInTheDocument();

    vi.mocked(getCapabilities).mockResolvedValue(capabilities("first"));
    await act(async () => { window.dispatchEvent(new Event("online")); });
    expect(await screen.findByRole("button", { name: "edited draft" })).toBeInTheDocument();
  });

  it("does not mount instance consumers after an invalid or failed identity check and can retry", async () => {
    const queryClient = createKodexQueryClient();
    vi.mocked(getCapabilities).mockResolvedValueOnce(capabilities(""));
    render(<GatewayInstanceBoundary queryClient={queryClient}><WorkspaceProbe /></GatewayInstanceBoundary>);
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "fresh draft" })).not.toBeInTheDocument();

    vi.mocked(getCapabilities).mockResolvedValueOnce(capabilities("valid"));
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("button", { name: "fresh draft" })).toBeInTheDocument();
    await waitFor(() => expect(getCapabilities).toHaveBeenCalledTimes(2));
  });

  it("keeps an already mounted draft through a failed recheck", async () => {
    vi.mocked(getCapabilities).mockResolvedValueOnce(capabilities("first"));
    render(<GatewayInstanceBoundary queryClient={createKodexQueryClient()}><WorkspaceProbe /></GatewayInstanceBoundary>);
    fireEvent.click(await screen.findByRole("button", { name: "fresh draft" }));

    vi.mocked(getCapabilities).mockRejectedValueOnce(new Error("Offline"));
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    expect(screen.getByRole("button", { name: "edited draft" })).toBeInTheDocument();
  });

  it("ignores an older identity response that arrives after a newer check", async () => {
    const queryClient = createKodexQueryClient();
    let resolveOld!: (value: Capabilities) => void;
    vi.mocked(getCapabilities).mockReturnValueOnce(new Promise((resolve) => { resolveOld = resolve; }));
    render(<GatewayInstanceBoundary queryClient={queryClient}><WorkspaceProbe /></GatewayInstanceBoundary>);

    vi.mocked(getCapabilities).mockResolvedValueOnce(capabilities("current"));
    await act(async () => { window.dispatchEvent(new Event("online")); });
    fireEvent.click(await screen.findByRole("button", { name: "fresh draft" }));
    await act(async () => resolveOld(capabilities("old")));

    expect(screen.getByRole("button", { name: "edited draft" })).toBeInTheDocument();
    expect(queryClient.getQueryData(queryKeys.capabilities)).toEqual(capabilities("current"));
  });

  it.each(["/threads/notification-thread", "/projects/project-1"])(
    "preserves %s for the same instance and clears it after a known replacement",
    async (path) => {
      window.history.replaceState(null, "", path);
      vi.mocked(getCapabilities).mockResolvedValue(capabilities("first"));
      render(<GatewayInstanceBoundary queryClient={createKodexQueryClient()}><WorkspaceProbe /></GatewayInstanceBoundary>);
      await screen.findByRole("button", { name: "fresh draft" });
      // First-visit links remain usable. Validating unscoped deep links against native state belongs to M3.
      expect(window.location.pathname).toBe(path);

      await act(async () => { window.dispatchEvent(new Event("online")); });
      expect(window.location.pathname).toBe(path);

      vi.mocked(getCapabilities).mockResolvedValue(capabilities("replacement"));
      await act(async () => { window.dispatchEvent(new Event("online")); });
      expect(window.location.pathname).toBe("/");
    },
  );
});
