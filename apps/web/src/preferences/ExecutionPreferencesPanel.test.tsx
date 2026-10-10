import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { mockGateway, requestJson } from "../test/gatewayMock";
import { ExecutionPreferencesPanel } from "./ExecutionPreferencesPanel";

const firstTarget = { filePath: "/dedicated/config.toml", version: "native-v1" };
const secondTarget = { filePath: "/dedicated/config.toml", version: "native-v2" };
const settings = {
  model: "custom-native-model", effort: "high", serviceTier: "fast", permissionProfileId: ":workspace",
  approvalPolicy: "on-request", approvalsReviewer: "auto_review", writeTarget: firstTarget,
};
const modelCatalog = {
  models: [
    {
      id: "custom-native-model", model: "custom-native-model", displayName: "Custom native model", description: "Current model",
      defaultReasoningEffort: "high", hidden: false, inputModalities: ["text"], isDefault: false, rawPayload: {},
      supportedReasoningEfforts: [
        { reasoningEffort: "medium", description: "Balanced" },
        { reasoningEffort: "high", description: "Deep" },
      ],
    },
    {
      id: "fast-native-model", model: "fast-native-model", displayName: "Fast native model", description: "Faster model",
      defaultReasoningEffort: "medium", hidden: false, inputModalities: ["text"], isDefault: true, rawPayload: {},
      supportedReasoningEfforts: [
        { reasoningEffort: "low", description: "Quick" },
        { reasoningEffort: "medium", description: "Balanced" },
      ],
    },
    {
      id: "no-reasoning-model", model: "no-reasoning-model", displayName: "No reasoning model", description: "No configurable reasoning",
      defaultReasoningEffort: "high", hidden: false, inputModalities: ["text"], isDefault: false, rawPayload: {},
      supportedReasoningEfforts: [],
    },
  ],
  rawPayload: {},
};
const profiles = { profiles: [{ id: ":workspace", label: "Workspace" }, { id: ":read-only", label: "Read only" }] };
const saved = { saved: true, write: { status: "ok", filePath: firstTarget.filePath, version: "native-v2", overriddenMetadata: null } };

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><MantineProvider env="test"><ExecutionPreferencesPanel /></MantineProvider></QueryClientProvider>);
}

const originalScrollIntoView = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
});

afterEach(() => {
  vi.restoreAllMocks();
  if (originalScrollIntoView) Object.defineProperty(HTMLElement.prototype, "scrollIntoView", originalScrollIntoView);
  else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
});

it("writes only the changed native permission field with the displayed read target", async () => {
  const gateway = mockGateway({
    "GET /v1/composer-settings": settings,
    "GET /v1/models": modelCatalog,
    "GET /v1/permission-profiles": profiles,
    "PATCH /v1/composer-settings": saved,
  });
  renderPanel();
  await userEvent.click(await screen.findByRole("radio", { name: /^workspace/i }));
  expect(gateway.callsFor("PATCH", "/v1/composer-settings")).toHaveLength(0);
  await userEvent.click(await screen.findByRole("radio", { name: /^read only/i }));
  await waitFor(() => expect(gateway.callsFor("PATCH", "/v1/composer-settings")).toHaveLength(1));
  expect(await requestJson(gateway.callsFor("PATCH", "/v1/composer-settings")[0])).toEqual({
    permissionProfileId: ":read-only", writeTarget: firstTarget,
  });
});

it("rereads a native conflict and requires review before a new user edit can submit", async () => {
  let conflicted = false;
  const gateway = mockGateway({
    "GET /v1/composer-settings": () => conflicted ? { ...settings, permissionProfileId: null, writeTarget: secondTarget } : settings,
    "GET /v1/models": modelCatalog,
    "GET /v1/permission-profiles": profiles,
    "PATCH /v1/composer-settings": () => {
      if (!conflicted) {
        conflicted = true;
        return new Response(JSON.stringify({ code: "config_version_conflict", message: "Native configuration changed", retryable: false }), { status: 409 });
      }
      return saved;
    },
  });
  renderPanel();
  await userEvent.click(await screen.findByRole("radio", { name: /^read only/i }));
  const review = await screen.findByRole("button", { name: "Review latest configuration" });
  await waitFor(() => expect(gateway.callsFor("GET", "/v1/composer-settings")).toHaveLength(2));
  expect(screen.getByRole("radio", { name: /^read only/i })).toBeDisabled();
  expect(gateway.callsFor("PATCH", "/v1/composer-settings")).toHaveLength(1);
  await userEvent.click(review);
  expect(screen.getByRole("radio", { name: /^default/i })).toBeChecked();
  expect(gateway.callsFor("PATCH", "/v1/composer-settings")).toHaveLength(1);
  await userEvent.click(screen.getByRole("radio", { name: /^read only/i }));
  await waitFor(() => expect(gateway.callsFor("PATCH", "/v1/composer-settings")).toHaveLength(2));
  expect(await requestJson(gateway.callsFor("PATCH", "/v1/composer-settings")[1])).toEqual({
    permissionProfileId: ":read-only", writeTarget: secondTarget,
  });
});

it("keeps native defaults read-only when the read provides no editable target", async () => {
  const gateway = mockGateway({
    "GET /v1/composer-settings": { ...settings, writeTarget: null },
    "GET /v1/models": modelCatalog,
    "GET /v1/permission-profiles": profiles,
  });
  renderPanel();
  await waitFor(() => expect(screen.getByRole("radio", { name: /^workspace/i })).toBeChecked());
  expect(screen.getByRole("radio", { name: /^read only/i })).toBeDisabled();
  expect(gateway.callsFor("PATCH", "/v1/composer-settings")).toHaveLength(0);
});

it("requires an explicit approval choice for a previous no-approval default and only writes changed fields", async () => {
  let selected = false;
  const gateway = mockGateway({
    "GET /v1/composer-settings": () => ({ ...settings, approvalPolicy: selected ? "on-request" : "never" }),
    "GET /v1/models": modelCatalog,
    "GET /v1/permission-profiles": profiles,
    "PATCH /v1/composer-settings": () => { selected = true; return saved; },
  });
  renderPanel();
  expect(await screen.findByText(/Choose a review mode/)).toBeInTheDocument();
  expect(screen.getByRole("radio", { name: "Ask me" })).not.toBeChecked();
  expect(screen.getByRole("radio", { name: "Auto review" })).not.toBeChecked();
  expect(gateway.callsFor("PATCH", "/v1/composer-settings")).toHaveLength(0);
  await userEvent.click(screen.getByText("Auto review"));
  await waitFor(() => expect(screen.getByRole("radio", { name: "Auto review" })).toBeChecked());
  expect(await requestJson(gateway.callsFor("PATCH", "/v1/composer-settings")[0])).toEqual({
    writeTarget: firstTarget, approvalPolicy: "on-request",
  });
});

it("keeps the native effective choice after a saved override instead of treating the submitted value as truth", async () => {
  const gateway = mockGateway({
    "GET /v1/composer-settings": settings,
    "GET /v1/models": modelCatalog,
    "GET /v1/permission-profiles": profiles,
    "PATCH /v1/composer-settings": { ...saved, write: { ...saved.write, status: "okOverridden" } },
  });
  renderPanel();
  await userEvent.click(await screen.findByRole("radio", { name: /^read only/i }));
  expect(await screen.findByText(/Another native configuration layer overrides/)).toBeInTheDocument();
  expect(screen.getByRole("radio", { name: /^workspace/i })).toBeChecked();
  expect(screen.getByRole("radio", { name: /^read only/i })).not.toBeChecked();
  expect(gateway.callsFor("PATCH", "/v1/composer-settings")).toHaveLength(1);
});

it("keeps writes disabled after a native read failure without displaying a confirmed default", async () => {
  const gateway = mockGateway({
    "GET /v1/composer-settings": new Response(JSON.stringify({ code: "upstream_error", message: "Native configuration unavailable", retryable: false }), { status: 502 }),
    "GET /v1/models": modelCatalog,
    "GET /v1/permission-profiles": profiles,
  });
  renderPanel();
  expect(await screen.findByText("Native configuration unavailable")).toBeInTheDocument();
  expect(screen.getByRole("radio", { name: /^default/i })).not.toBeChecked();
  expect(screen.getByRole("radio", { name: /^workspace/i })).toBeDisabled();
  expect(screen.getByRole("radio", { name: "Ask me" })).not.toBeChecked();
  expect(gateway.callsFor("PATCH", "/v1/composer-settings")).toHaveLength(0);
});

it("persists a model with its compatible default effort, then offers that model's live effort list", async () => {
  let current: Omit<typeof settings, "model" | "effort"> & { model: string | null; effort: string | null } = { ...settings };
  let version = 1;
  const gateway = mockGateway({
    "GET /v1/composer-settings": () => ({ ...current, writeTarget: version === 1 ? firstTarget : secondTarget }),
    "GET /v1/models": modelCatalog,
    "GET /v1/permission-profiles": profiles,
    "PATCH /v1/composer-settings": async (request: Request) => {
      const { writeTarget: _writeTarget, ...body } = await requestJson(request) as {
        model?: string | null;
        effort?: string | null;
        writeTarget: typeof firstTarget;
      };
      current = { ...current, ...body };
      version = 2;
      return saved;
    },
  });
  renderPanel();

  const model = await screen.findByLabelText("Default model");
  await userEvent.click(model);
  await userEvent.click(await screen.findByRole("option", { name: "fast-native-model" }));
  await waitFor(() => expect(gateway.callsFor("PATCH", "/v1/composer-settings")).toHaveLength(1));
  expect(await requestJson(gateway.callsFor("PATCH", "/v1/composer-settings")[0])).toEqual({
    model: "fast-native-model", effort: "medium", writeTarget: firstTarget,
  });

  const effort = screen.getByLabelText("Default reasoning");
  await userEvent.click(effort);
  expect(await screen.findByRole("option", { name: "Low" })).toBeInTheDocument();
  expect(screen.queryByRole("option", { name: "High" })).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("option", { name: "Low" }));
  await waitFor(() => expect(gateway.callsFor("PATCH", "/v1/composer-settings")).toHaveLength(2));
  expect(await requestJson(gateway.callsFor("PATCH", "/v1/composer-settings")[1])).toEqual({
    effort: "low", writeTarget: secondTarget,
  });
});

it("can restore Codex model and reasoning defaults", async () => {
  let current: Omit<typeof settings, "model" | "effort"> & { model: string | null; effort: string | null } = { ...settings };
  let version = 1;
  const gateway = mockGateway({
    "GET /v1/composer-settings": () => ({ ...current, writeTarget: version === 1 ? firstTarget : secondTarget }),
    "GET /v1/models": modelCatalog,
    "GET /v1/permission-profiles": profiles,
    "PATCH /v1/composer-settings": async (request: Request) => {
      const { writeTarget: _writeTarget, ...body } = await requestJson(request) as {
        model?: string | null;
        effort?: string | null;
        writeTarget: typeof firstTarget;
      };
      current = { ...current, ...body };
      version = 2;
      return saved;
    },
  });
  renderPanel();

  await userEvent.click(await screen.findByLabelText("Default model"));
  await userEvent.click(await screen.findByRole("option", { name: "Codex default" }));
  await waitFor(() => expect(gateway.callsFor("PATCH", "/v1/composer-settings")).toHaveLength(1));
  expect(await requestJson(gateway.callsFor("PATCH", "/v1/composer-settings")[0])).toEqual({
    model: null, effort: "medium", writeTarget: firstTarget,
  });

  await userEvent.click(screen.getByLabelText("Default reasoning"));
  await userEvent.click(await screen.findByRole("option", { name: "Codex default" }));
  await waitFor(() => expect(gateway.callsFor("PATCH", "/v1/composer-settings")).toHaveLength(2));
  expect(await requestJson(gateway.callsFor("PATCH", "/v1/composer-settings")[1])).toEqual({
    effort: null, writeTarget: secondTarget,
  });
});

it("clears an incompatible effort when the selected model advertises no reasoning options", async () => {
  const gateway = mockGateway({
    "GET /v1/composer-settings": settings,
    "GET /v1/models": modelCatalog,
    "GET /v1/permission-profiles": profiles,
    "PATCH /v1/composer-settings": saved,
  });
  renderPanel();

  await userEvent.click(await screen.findByLabelText("Default model"));
  await userEvent.click(await screen.findByRole("option", { name: "no-reasoning-model" }));
  await waitFor(() => expect(gateway.callsFor("PATCH", "/v1/composer-settings")).toHaveLength(1));
  expect(await requestJson(gateway.callsFor("PATCH", "/v1/composer-settings")[0])).toEqual({
    model: "no-reasoning-model", effort: null, writeTarget: firstTarget,
  });
});
