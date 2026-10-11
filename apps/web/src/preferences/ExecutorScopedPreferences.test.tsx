import { MantineProvider } from "@mantine/core";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { GatewayClient } from "../api/client";
import {
  ExecutorRuntimeProvider,
  ExecutorRuntimeRegistryProvider,
} from "../api/GatewayClientContext";
import { createKodexQueryClient, type ExecutorRuntime } from "../api/queryClient";
import { queryKeys } from "../api/queryKeys";
import { FederatedCatalogProvider, type FederatedCatalogContextValue } from "../federation/FederatedCatalogContext";
import { PreferencesModal, type PreferenceSection } from "../PreferencesModal";
import { createMemoryWorkspacePaneStore } from "../workspace/paneStore";
import { WorkspaceProvider } from "../workspace/WorkspaceProvider";
import { routeExecutorPreferencesEvent } from "./ExecutorPreferencesScope";

const settings = {
  approvalPolicy: "on-request",
  approvalsReviewer: "user",
  effort: null,
  model: null,
  permissionProfileId: null,
  serviceTier: null,
  writeTarget: null,
};

const originalScrollIntoView = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");
beforeEach(() => Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() }));
afterEach(() => {
  if (originalScrollIntoView) Object.defineProperty(HTMLElement.prototype, "scrollIntoView", originalScrollIntoView);
  else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
});

function runtime(executorId: string, api: GatewayClient): ExecutorRuntime {
  return {
    api,
    connection: Object.freeze({ executorId, instanceId: `instance-${executorId}` }),
    queryClient: createKodexQueryClient(),
    storage: null,
  };
}

it("switches executor-owned preferences through the selected runtime and query cache", async () => {
  const firstApi = {
    getAccount: vi.fn(async () => ({ account: null, requiresOpenaiAuth: true, rawPayload: {} })),
    getComposerSettings: vi.fn(async () => settings),
    listConfiguredMcpServers: vi.fn(async () => ({ servers: [], writeTarget: null })),
    listMcpServers: vi.fn(async () => ({ servers: [{ name: "docs", authStatus: "notLoggedIn", resourceTemplates: [], resources: [], tools: {} }] })),
    listModels: vi.fn(async () => []),
    listPermissionProfiles: vi.fn(async () => []),
    startLogin: vi.fn(async () => ({ loginId: "first-login", loginType: "chatgptDeviceCode", userCode: "FIRST", verificationUrl: "https://auth.example/first" })),
    startMcpOAuthLogin: vi.fn(async () => ({ authorizationUrl: "https://auth.example/first-mcp" })),
  } as unknown as GatewayClient;
  const secondApi = {
    getAccount: vi.fn(async () => ({ account: null, requiresOpenaiAuth: true, rawPayload: {} })),
    getComposerSettings: vi.fn(async () => settings),
    listConfiguredMcpServers: vi.fn(async () => ({ servers: [], writeTarget: null })),
    listMcpServers: vi.fn(async () => ({ servers: [{ name: "docs", authStatus: "notLoggedIn", resourceTemplates: [], resources: [], tools: {} }] })),
    listModels: vi.fn(async () => []),
    listPermissionProfiles: vi.fn(async () => []),
    startLogin: vi.fn(async () => ({ loginId: "second-login", loginType: "chatgptDeviceCode", userCode: "SECOND", verificationUrl: "https://auth.example/second" })),
    startMcpOAuthLogin: vi.fn(async () => ({ authorizationUrl: "https://auth.example/second-mcp" })),
  } as unknown as GatewayClient;
  const first = runtime("first", firstApi);
  const second = runtime("second", secondApi);
  second.queryClient.setQueryData(queryKeys.composerSettings(null), { ...settings, model: "stale-model" });
  const federation = {
    catalog: null,
    error: null,
    executors: [
      { id: "first", displayName: "Desk Mac" },
      { id: "second", displayName: "Linux box" },
    ],
    moveItem: vi.fn(), probeExecutor: vi.fn(), registerExecutor: vi.fn(), removeExecutor: vi.fn(),
    refresh: vi.fn(), refreshExecutors: vi.fn(), refreshing: false, updateExecutor: vi.fn(),
  } as unknown as FederatedCatalogContextValue;

  function Harness() {
    const [section, setSection] = useState<PreferenceSection>("execution");
    return <PreferencesModal
      activeSection={section}
      onClose={vi.fn()}
      onModeChange={vi.fn()}
      onSectionChange={setSection}
      onThemeChange={vi.fn()}
      opened
      preferences={{ mode: "dark", lightThemeId: "paper-light", darkThemeId: "oled-black" }}
      resolvedSchemeId="oled-black"
    />;
  }

  render(
    <MantineProvider env="test">
      <FederatedCatalogProvider value={federation}>
        <ExecutorRuntimeRegistryProvider runtimes={[first, second]}>
          <ExecutorRuntimeProvider runtime={first}>
            <WorkspaceProvider paneStore={createMemoryWorkspacePaneStore({
              activePaneId: "second-thread",
              dockviewLayout: null,
              panes: [{ id: "second-thread", kind: "thread", target: { executorId: "second", mode: "existing", threadId: "thread" }, title: "Thread" }],
              schemaVersion: 2,
            })}><Harness /></WorkspaceProvider>
          </ExecutorRuntimeProvider>
        </ExecutorRuntimeRegistryProvider>
      </FederatedCatalogProvider>
    </MantineProvider>,
  );

  await waitFor(() => expect(firstApi.getComposerSettings).toHaveBeenCalledTimes(1));
  expect(secondApi.getComposerSettings).not.toHaveBeenCalled();

  await userEvent.click(screen.getByRole("textbox", { name: "Executor" }));
  await userEvent.click(await screen.findByRole("option", { name: "Linux box" }));

  await waitFor(() => expect(secondApi.getComposerSettings).toHaveBeenCalledTimes(1));
  expect(screen.getByText("Settings for Linux box")).toBeInTheDocument();
  expect(first.queryClient).not.toBe(second.queryClient);

  await userEvent.click(screen.getByRole("button", { name: "MCP" }));
  await userEvent.click(await screen.findByRole("button", { name: /log in/i }));
  await waitFor(() => expect(secondApi.startMcpOAuthLogin).toHaveBeenCalled());
  expect(vi.mocked(secondApi.startMcpOAuthLogin).mock.calls[0]?.[0]).toBe("docs");
  expect(firstApi.startMcpOAuthLogin).not.toHaveBeenCalled();

  await userEvent.click(screen.getByRole("button", { name: "Account" }));
  await userEvent.click(await screen.findByRole("button", { name: "Sign in with ChatGPT" }));
  expect(await screen.findByDisplayValue("SECOND")).toBeInTheDocument();
  expect(secondApi.startLogin).toHaveBeenCalledTimes(1);
  expect(firstApi.startLogin).not.toHaveBeenCalled();
});

it("preserves an MCP draft while its executor is offline and enables saving after reconnect", async () => {
  const writeTarget = { filePath: "/executor/config.toml", version: "v1" };
  const addMcpServer = vi.fn(async () => ({ saved: true }));
  const api = {
    addMcpServer,
    listConfiguredMcpServers: vi.fn(async () => ({ servers: [], writeTarget })),
    listMcpServers: vi.fn(async () => ({ servers: [] })),
  } as unknown as GatewayClient;
  const selectedRuntime = runtime("selected", api);
  const federation = {
    catalog: null, error: null,
    executors: [{ id: "selected", displayName: "Selected box" }],
    moveItem: vi.fn(), probeExecutor: vi.fn(), registerExecutor: vi.fn(), removeExecutor: vi.fn(),
    refresh: vi.fn(), refreshExecutors: vi.fn(), refreshing: false, updateExecutor: vi.fn(),
  } as unknown as FederatedCatalogContextValue;

  function Harness() {
    const [available, setAvailable] = useState(true);
    return <>
      <button onClick={() => setAvailable((value) => !value)}>Toggle executor</button>
      <ExecutorRuntimeRegistryProvider availableExecutorIds={available ? ["selected"] : []} runtimes={[selectedRuntime]}>
        <ExecutorRuntimeProvider runtime={selectedRuntime}>
          <PreferencesModal activeSection="mcp" onClose={vi.fn()} onModeChange={vi.fn()} onSectionChange={vi.fn()}
            onThemeChange={vi.fn()} opened preferences={{ mode: "dark", lightThemeId: "paper-light", darkThemeId: "oled-black" }} resolvedSchemeId="oled-black" />
        </ExecutorRuntimeProvider>
      </ExecutorRuntimeRegistryProvider>
    </>;
  }

  render(<MantineProvider env="test"><FederatedCatalogProvider value={federation}><Harness /></FederatedCatalogProvider></MantineProvider>);
  await userEvent.click(await screen.findByRole("button", { name: "Add server" }));
  let editor = within(screen.getByRole("dialog", { name: "Add MCP server" }));
  const url = editor.getByRole("textbox", { name: "URL" });
  await userEvent.type(url, "https://draft.example/mcp");

  await userEvent.click(screen.getByRole("button", { name: "Toggle executor" }));
  editor = within(screen.getByRole("dialog", { name: "Add MCP server" }));
  expect(editor.getByRole("textbox", { name: "URL" })).toHaveValue("https://draft.example/mcp");
  expect(editor.getByRole("button", { name: "Add server" })).toBeDisabled();
  expect(screen.getByText("Reconnect this executor to save the draft.")).toBeInTheDocument();

  await userEvent.click(screen.getByRole("button", { name: "Toggle executor" }));
  await waitFor(() => expect(within(screen.getByRole("dialog", { name: "Add MCP server" })).getByRole("button", { name: "Add server" })).toBeEnabled());
  expect(within(screen.getByRole("dialog", { name: "Add MCP server" })).getByRole("textbox", { name: "URL" })).toHaveValue("https://draft.example/mcp");
  expect(addMcpServer).not.toHaveBeenCalled();
});

it("applies a native usage update only to the selected executor cache", () => {
  const first = createKodexQueryClient();
  const second = createKodexQueryClient();
  first.setQueryData(queryKeys.rateLimits, { rateLimits: { primary: { usedPercent: 10 } }, rawPayload: {} });
  second.setQueryData(queryKeys.rateLimits, { rateLimits: { primary: { usedPercent: 20 } }, rawPayload: {} });

  routeExecutorPreferencesEvent(second, {
    codexMethod: "account/rateLimits/updated",
    id: "usage", kind: "account.rate_limits_updated", payload: { rateLimits: { primary: { usedPercent: 75 } } },
    receivedAt: "2026-10-12T00:00:00Z", seq: 4,
  });

  expect(first.getQueryData(queryKeys.rateLimits)).toMatchObject({ rateLimits: { primary: { usedPercent: 10 } } });
  expect(second.getQueryData(queryKeys.rateLimits)).toMatchObject({ rateLimits: { primary: { usedPercent: 75 } } });
});
