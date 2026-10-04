import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";

import { queryKeys } from "../api/queryKeys";
import { mockGateway, requestJson } from "../test/gatewayMock";
import { McpPreferencesPanel } from "./McpPreferencesPanel";

const target = { filePath: "/dedicated/config.toml", version: "native-v1" };
const nextTarget = { ...target, version: "native-v2" };
const server = {
  name: "docs", enabled: true, required: true, hasStoredSecrets: true,
  scopes: ["custom-scope"], enabledTools: ["tool-only"], startupTimeoutSec: 45,
  transport: { type: "streamableHttp", url: "https://initial.example/mcp", oauthResource: "custom-resource", httpHeaders: { Authorization: { configured: true, masked: true } } },
};
const saved = { saved: true, write: { status: "ok", filePath: target.filePath, version: "native-v2", overriddenMetadata: null }, reload: { queued: true, error: null } };

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return { client, ...render(<QueryClientProvider client={client}><MantineProvider env="test"><McpPreferencesPanel /></MantineProvider></QueryClientProvider>) };
}
afterEach(() => vi.restoreAllMocks());

it("adds an MCP server using the native target read before the form was opened", async () => {
  const gateway = mockGateway({
    "GET /v1/mcp/servers": { servers: [] },
    "GET /v1/mcp/configured-servers": { servers: [], writeTarget: target },
    "POST /v1/mcp/servers": saved,
  });
  const { client } = renderPanel();
  await userEvent.click(await screen.findByRole("button", { name: "Add server" }));
  const dialog = within(await screen.findByRole("dialog", { name: "Add MCP server" }));
  await userEvent.type(dialog.getByLabelText("Name"), "added");
  await userEvent.type(dialog.getByLabelText("URL"), "https://added.example/mcp");
  act(() => client.setQueryData(queryKeys.mcpConfiguredServers, { servers: [], writeTarget: nextTarget }));
  await userEvent.click(dialog.getByRole("button", { name: "Add server" }));
  await waitFor(() => expect(gateway.callsFor("POST", "/v1/mcp/servers")).toHaveLength(1));
  expect(await requestJson(gateway.callsFor("POST", "/v1/mcp/servers")[0])).toEqual({
    name: "added", enabled: true, writeTarget: target,
    transport: { type: "streamableHttp", url: "https://added.example/mcp", httpHeaders: {} },
  });
});

it("edits one native leaf without reconstructing hidden fields or resubmitting masked secrets", async () => {
  const gateway = mockGateway({
    "GET /v1/mcp/servers": { servers: [] },
    "GET /v1/mcp/configured-servers": { servers: [server], writeTarget: target },
    "PATCH /v1/mcp/servers/docs": saved,
  });
  const { client } = renderPanel();
  await userEvent.click(await screen.findByRole("button", { name: "Edit" }));
  const dialog = within(await screen.findByRole("dialog", { name: "Edit MCP server" }));
  await userEvent.clear(dialog.getByLabelText("URL"));
  await userEvent.type(dialog.getByLabelText("URL"), "https://edited.example/mcp");
  act(() => client.setQueryData(queryKeys.mcpConfiguredServers, { servers: [{ ...server, required: false }], writeTarget: nextTarget }));
  expect(dialog.getByLabelText("URL")).toHaveValue("https://edited.example/mcp");
  await userEvent.click(dialog.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(gateway.callsFor("PATCH", "/v1/mcp/servers/docs")).toHaveLength(1));
  expect(await requestJson(gateway.callsFor("PATCH", "/v1/mcp/servers/docs")[0])).toEqual({
    writeTarget: target, edits: [{ keyPath: ["url"], value: "https://edited.example/mcp" }],
  });
  expect(gateway.callsFor("POST", "/v1/mcp/servers/docs/replace")).toHaveLength(0);
});

it("keeps a conflicted draft until explicit review loads the latest native values and target", async () => {
  let conflicted = false;
  const gateway = mockGateway({
    "GET /v1/mcp/servers": { servers: [] },
    "GET /v1/mcp/configured-servers": () => ({ servers: [conflicted ? { ...server, transport: { ...server.transport, url: "https://other-client.example/mcp" } } : server], writeTarget: conflicted ? nextTarget : target }),
    "PATCH /v1/mcp/servers/docs": () => {
      if (!conflicted) {
        conflicted = true;
        return new Response(JSON.stringify({ code: "config_version_conflict", message: "Native configuration changed", retryable: false }), { status: 409 });
      }
      return saved;
    },
  });
  renderPanel();
  await userEvent.click(await screen.findByRole("button", { name: "Edit" }));
  let dialog = within(await screen.findByRole("dialog", { name: "Edit MCP server" }));
  await userEvent.clear(dialog.getByLabelText("URL"));
  await userEvent.type(dialog.getByLabelText("URL"), "https://my-edit.example/mcp");
  await userEvent.click(dialog.getByRole("button", { name: "Save changes" }));
  const review = await dialog.findByRole("button", { name: "Review latest configuration" });
  await waitFor(() => expect(review).toBeEnabled());
  expect(dialog.getByLabelText("URL")).toHaveValue("https://my-edit.example/mcp");
  expect(dialog.getByRole("button", { name: "Save changes" })).toBeDisabled();
  expect(gateway.callsFor("PATCH", "/v1/mcp/servers/docs")).toHaveLength(1);
  await userEvent.click(review);
  dialog = within(screen.getByRole("dialog", { name: "Edit MCP server" }));
  expect(dialog.getByLabelText("URL")).toHaveValue("https://other-client.example/mcp");
  expect(gateway.callsFor("PATCH", "/v1/mcp/servers/docs")).toHaveLength(1);
  await userEvent.clear(dialog.getByLabelText("URL"));
  await userEvent.type(dialog.getByLabelText("URL"), "https://reviewed.example/mcp");
  await userEvent.click(dialog.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(gateway.callsFor("PATCH", "/v1/mcp/servers/docs")).toHaveLength(2));
  expect(await requestJson(gateway.callsFor("PATCH", "/v1/mcp/servers/docs")[1])).toEqual({
    writeTarget: nextTarget, edits: [{ keyPath: ["url"], value: "https://reviewed.example/mcp" }],
  });
});

it("sends explicit per-secret replacements and deletes without copying stored masks", async () => {
  const gateway = mockGateway({
    "GET /v1/mcp/servers": { servers: [] },
    "GET /v1/mcp/configured-servers": { servers: [{ ...server, transport: { ...server.transport, httpHeaders: { Authorization: { configured: true, masked: true }, "X.Custom": { configured: true, masked: true } } } }], writeTarget: target },
    "PATCH /v1/mcp/servers/docs": saved,
  });
  renderPanel();
  await userEvent.click(await screen.findByRole("button", { name: "Edit" }));
  const dialog = within(await screen.findByRole("dialog", { name: "Edit MCP server" }));
  const authorization = within(dialog.getByRole("group", { name: "Stored value Authorization" }));
  await userEvent.click(authorization.getByRole("button", { name: "Replace" }));
  await userEvent.type(authorization.getByLabelText("Replacement value for Authorization"), "new-secret");
  await userEvent.click(within(dialog.getByRole("group", { name: "Stored value X.Custom" })).getByRole("button", { name: "Clear" }));
  await userEvent.click(dialog.getByLabelText("Required"));
  await userEvent.click(dialog.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(gateway.callsFor("PATCH", "/v1/mcp/servers/docs")).toHaveLength(1));
  expect(await requestJson(gateway.callsFor("PATCH", "/v1/mcp/servers/docs")[0])).toEqual({ writeTarget: target, edits: [
    { keyPath: ["required"], value: false },
    { keyPath: ["http_headers", "Authorization"], value: "new-secret" },
    { keyPath: ["http_headers", "X.Custom"], value: null },
  ] });
});

it("reports saved overrides and failed reload requests while retaining the effective native row", async () => {
  const gateway = mockGateway({
    "GET /v1/mcp/servers": { servers: [] },
    "GET /v1/mcp/configured-servers": { servers: [server], writeTarget: target },
    "PATCH /v1/mcp/servers/docs/enabled": { ...saved, write: { ...saved.write, status: "okOverridden" }, reload: { queued: false, error: "Native reload unavailable" }, notificationError: "Configuration saved; change notification was unavailable." },
  });
  renderPanel();
  await userEvent.click(await screen.findByRole("button", { name: "Disable" }));
  expect(await screen.findByText(/Saved, but MCP reload was not confirmed: Native reload unavailable/)).toBeInTheDocument();
  expect(screen.getByText(/Another native configuration layer overrides/)).toBeInTheDocument();
  expect(screen.getByText("Configuration saved; change notification was unavailable.")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Disable" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Enable" })).not.toBeInTheDocument();
  expect(await requestJson(gateway.callsFor("PATCH", "/v1/mcp/servers/docs/enabled")[0])).toEqual({ writeTarget: target, enabled: false });
});

it("uses the removal confirmation's captured target and keeps inherited native rows visible", async () => {
  const gateway = mockGateway({
    "GET /v1/mcp/servers": { servers: [] },
    "GET /v1/mcp/configured-servers": { servers: [server], writeTarget: target },
    "DELETE /v1/mcp/servers/docs": saved,
  });
  const { client } = renderPanel();
  await userEvent.click(await screen.findByRole("button", { name: "Remove" }));
  act(() => client.setQueryData(queryKeys.mcpConfiguredServers, { servers: [server], writeTarget: nextTarget }));
  await userEvent.click(screen.getByRole("button", { name: "Confirm remove" }));
  await waitFor(() => expect(gateway.callsFor("DELETE", "/v1/mcp/servers/docs")).toHaveLength(1));
  expect(await requestJson(gateway.callsFor("DELETE", "/v1/mcp/servers/docs")[0])).toEqual({ writeTarget: target });
  expect(await screen.findByRole("button", { name: "Edit" })).toBeInTheDocument();
});

it("confirms a new local command and preserves spaces within each explicit argument", async () => {
  const gateway = mockGateway({
    "GET /v1/mcp/servers": { servers: [] },
    "GET /v1/mcp/configured-servers": { servers: [], writeTarget: target },
    "POST /v1/mcp/servers": saved,
  });
  renderPanel();
  await userEvent.click(await screen.findByRole("button", { name: "Add server" }));
  const dialog = within(await screen.findByRole("dialog", { name: "Add MCP server" }));
  await userEvent.type(dialog.getByLabelText("Name"), "local");
  await userEvent.click(dialog.getByRole("radio", { name: "Local command" }));
  await userEvent.type(dialog.getByLabelText("Command"), "npx");
  await userEvent.type(dialog.getByLabelText("Arguments"), "-y\npath with spaces");
  await userEvent.click(dialog.getByRole("button", { name: "Confirm local command" }));
  expect(gateway.callsFor("POST", "/v1/mcp/servers")).toHaveLength(0);
  await userEvent.click(dialog.getByRole("button", { name: "Add server" }));
  await waitFor(() => expect(gateway.callsFor("POST", "/v1/mcp/servers")).toHaveLength(1));
  expect(await requestJson(gateway.callsFor("POST", "/v1/mcp/servers")[0])).toEqual({ name: "local", enabled: true, writeTarget: target,
    transport: { type: "stdio", command: "npx", args: ["-y", "path with spaces"], env: {} },
  });
});

it("discards a cancelled add form before opening an existing server for a sparse edit", async () => {
  const gateway = mockGateway({
    "GET /v1/mcp/servers": { servers: [] },
    "GET /v1/mcp/configured-servers": { servers: [server], writeTarget: target },
    "PATCH /v1/mcp/servers/docs": saved,
  });
  renderPanel();
  await userEvent.click(await screen.findByRole("button", { name: "Add server" }));
  const added = within(await screen.findByRole("dialog", { name: "Add MCP server" }));
  await userEvent.type(added.getByLabelText("Name"), "unsaved");
  await userEvent.type(added.getByLabelText("HTTP headers"), "DoNotCopy=secret");
  await userEvent.click(added.getByRole("button", { name: "Cancel" }));
  await userEvent.click(screen.getByRole("button", { name: "Edit" }));
  const edited = within(await screen.findByRole("dialog", { name: "Edit MCP server" }));
  expect(edited.getByLabelText("Name")).toHaveValue("docs");
  expect(edited.getByLabelText("HTTP headers")).toHaveValue("");
  await userEvent.click(edited.getByLabelText("Required"));
  await userEvent.click(edited.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(gateway.callsFor("PATCH", "/v1/mcp/servers/docs")).toHaveLength(1));
  expect(await requestJson(gateway.callsFor("PATCH", "/v1/mcp/servers/docs")[0])).toEqual({ writeTarget: target, edits: [{ keyPath: ["required"], value: false }] });
  expect(gateway.callsFor("POST", "/v1/mcp/servers")).toHaveLength(0);
});

it.each([
  { transport: server.transport, label: "HTTP" },
  { transport: { type: "unknown" }, label: "Native transport" },
])("retains the existing $label transport and edits only the explicit flag", async ({ transport }) => {
  const gateway = mockGateway({
    "GET /v1/mcp/servers": { servers: [] },
    "GET /v1/mcp/configured-servers": { servers: [{ ...server, transport }], writeTarget: target },
    "PATCH /v1/mcp/servers/docs": saved,
  });
  renderPanel();
  await userEvent.click(await screen.findByRole("button", { name: "Edit" }));
  const dialog = within(await screen.findByRole("dialog", { name: "Edit MCP server" }));
  expect(dialog.queryByRole("radio", { name: "Local command" })).not.toBeInTheDocument();
  await userEvent.click(dialog.getByLabelText("Required"));
  await userEvent.click(dialog.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(gateway.callsFor("PATCH", "/v1/mcp/servers/docs")).toHaveLength(1));
  expect(await requestJson(gateway.callsFor("PATCH", "/v1/mcp/servers/docs")[0])).toEqual({ writeTarget: target, edits: [{ keyPath: ["required"], value: false }] });
});

it("keeps config writes unavailable after a failed native read without claiming the inventory is empty", async () => {
  mockGateway({
    "GET /v1/mcp/servers": { servers: [] },
    "GET /v1/mcp/configured-servers": new Response(JSON.stringify({ code: "upstream_error", message: "Native configuration unavailable", retryable: false }), { status: 502 }),
  });
  renderPanel();
  expect(await screen.findByText("Native configuration unavailable")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Add server" })).toBeDisabled();
  expect(screen.queryByText("No MCP servers configured")).not.toBeInTheDocument();
});
