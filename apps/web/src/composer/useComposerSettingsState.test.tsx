import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { afterEach, expect, it, vi } from "vitest";

import { getComposerSettings, listModels, type ComposerSettingsResponse } from "../api/client";
import { useComposerSettingsState } from "./useComposerSettingsState";

vi.mock("../api/client", () => ({ getComposerSettings: vi.fn(), listModels: vi.fn() }));
afterEach(() => vi.clearAllMocks());
const nativeSettings = (model: string): ComposerSettingsResponse => ({ model, writeTarget: null });

it("keeps cwd-specific hydration out of global defaults even when responses finish in reverse order", async () => {
  vi.mocked(listModels).mockResolvedValue(["global-model", "slow-model", "fast-model"].map((id) => ({
    id, model: id, displayName: id, description: "Fixture model", defaultReasoningEffort: "medium", hidden: false, inputModalities: ["text"], isDefault: false, rawPayload: {}, supportedReasoningEfforts: [],
  })));
  let releaseSlow!: (settings: ComposerSettingsResponse) => void;
  vi.mocked(getComposerSettings).mockImplementation(async (_projectId, cwd) => {
    if (cwd === "/slow-repo") return new Promise((resolve) => { releaseSlow = resolve; });
    return nativeSettings(cwd === "/fast-repo" ? "fast-model" : "global-model");
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const hook = renderHook(() => useComposerSettingsState({
    projects: [], onError: vi.fn(),
  }), { wrapper: ({ children }: PropsWithChildren) => <QueryClientProvider client={client}>{children}</QueryClientProvider> });
  await act(async () => { await hook.result.current.hydrateComposerDefaults(null, null); });
  let slow!: ReturnType<typeof hook.result.current.hydrateComposerDefaults>;
  await act(async () => { slow = hook.result.current.hydrateComposerDefaults(null, "/slow-repo"); });
  await act(async () => { expect(await hook.result.current.hydrateComposerDefaults(null, "/fast-repo")).toMatchObject({ model: "fast-model" }); });
  await act(async () => { releaseSlow(nativeSettings("slow-model")); expect(await slow).toMatchObject({ model: "slow-model" }); });
  expect(hook.result.current.composerDefaults.model).toBe("global-model");
});

it.each([
  { roots: [{ path: "/project-root" }], expectedCwd: "/project-root" },
  { roots: [{ path: "/project-root with trailing space " }], expectedCwd: "/project-root with trailing space " },
  { roots: [], expectedCwd: null },
  { roots: [{ path: "/one" }, { path: "/two" }], expectedCwd: null },
])("hydrates project defaults only at the sole root despite an explicit draft override (%j)", async ({ roots, expectedCwd }) => {
  vi.mocked(listModels).mockResolvedValue([]);
  vi.mocked(getComposerSettings).mockResolvedValue(nativeSettings("project-model"));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const hook = renderHook(() => useComposerSettingsState({
    projects: [{ id: "project", name: "Project", roots, metadata: {}, position: 0, createdAt: 1, updatedAt: 1, recencyAt: null }],
    onError: vi.fn(),
  }), { wrapper: ({ children }: PropsWithChildren) => <QueryClientProvider client={client}>{children}</QueryClientProvider> });
  await act(async () => { await hook.result.current.hydrateComposerDefaults("project", "/outside-roots"); });
  if (expectedCwd) expect(getComposerSettings).toHaveBeenCalledWith("project", expectedCwd, expect.any(AbortSignal));
  else expect(getComposerSettings).not.toHaveBeenCalled();
});
