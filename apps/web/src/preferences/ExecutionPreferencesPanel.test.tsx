import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";

import { mockGateway, requestJson } from "../test/gatewayMock";
import { ExecutionPreferencesPanel } from "./ExecutionPreferencesPanel";

const firstTarget = { filePath: "/dedicated/config.toml", version: "native-v1" };
const secondTarget = { filePath: "/dedicated/config.toml", version: "native-v2" };
const settings = {
  model: "custom-native-model", effort: "high", serviceTier: "fast", permissionProfileId: ":workspace",
  approvalPolicy: "on-request", approvalsReviewer: "auto_review", writeTarget: firstTarget,
};
const profiles = { profiles: [{ id: ":workspace", label: "Workspace" }, { id: ":read-only", label: "Read only" }] };
const saved = { saved: true, write: { status: "ok", filePath: firstTarget.filePath, version: "native-v2", overriddenMetadata: null } };

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><MantineProvider env="test"><ExecutionPreferencesPanel /></MantineProvider></QueryClientProvider>);
}

afterEach(() => vi.restoreAllMocks());

it("writes only the changed native permission field with the displayed read target", async () => {
  const gateway = mockGateway({
    "GET /v1/composer-settings": settings,
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
    "GET /v1/permission-profiles": profiles,
  });
  renderPanel();
  expect(await screen.findByText("Native configuration unavailable")).toBeInTheDocument();
  expect(screen.getByRole("radio", { name: /^default/i })).not.toBeChecked();
  expect(screen.getByRole("radio", { name: /^workspace/i })).toBeDisabled();
  expect(screen.getByRole("radio", { name: "Ask me" })).not.toBeChecked();
  expect(gateway.callsFor("PATCH", "/v1/composer-settings")).toHaveLength(0);
});
