import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { afterEach, expect, it, vi } from "vitest";

import { getComposerSettings, listModels, type ComposerSettingsResponse } from "../api/client";
import { useComposerSettingsState } from "./useComposerSettingsState";

vi.mock("../api/client", () => ({ getComposerSettings: vi.fn(), listModels: vi.fn() }));
afterEach(() => vi.clearAllMocks());
const nativeSettings = (model: string): ComposerSettingsResponse => ({ model });

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
    projects: [], onError: vi.fn(), draftChatThreadSelected: true, selectedProjectId: null,
    selectedThread: null,
  }), { wrapper: ({ children }: PropsWithChildren) => <QueryClientProvider client={client}>{children}</QueryClientProvider> });
  await act(async () => { await hook.result.current.hydrateComposerDefaults(null, null); });
  let slow!: ReturnType<typeof hook.result.current.hydrateComposerDefaults>;
  await act(async () => { slow = hook.result.current.hydrateComposerDefaults(null, "/slow-repo"); });
  await act(async () => { expect(await hook.result.current.hydrateComposerDefaults(null, "/fast-repo")).toMatchObject({ model: "fast-model" }); });
  await act(async () => { releaseSlow(nativeSettings("slow-model")); expect(await slow).toMatchObject({ model: "slow-model" }); });
  expect(hook.result.current.workspaceComposerDefaults.model).toBe("global-model");
  expect(hook.result.current.composerSettings.model).toBe("global-model");
});
