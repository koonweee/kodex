import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Approval, ApprovalListResponse, EventEnvelope } from "../api/client";
import { queryKeys } from "../api/queryKeys";
import { mockGateway } from "../test/gatewayMock";
import { applyApprovalInvalidation, refreshApprovalSnapshot } from "./cache";
import { useApprovalsState } from "./useApprovalsState";

const approval: Approval = {
  id: "approval-1", requestId: "native-request-1", source: "native", status: "pending",
  threadId: "thread-1", turnId: "turn-1", itemId: "item-1",
  method: "item/commandExecution/requestApproval", payload: { command: "cargo test" },
  createdAt: "2026-10-04T00:00:00Z",
};
const snapshot = (revision: number, approvals: Approval[], runtimeId = "runtime-1"): ApprovalListResponse => ({ runtimeId, revision, approvals });
afterEach(() => vi.restoreAllMocks());

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const onError = vi.fn();
  const hook = renderHook(() => useApprovalsState({ onError }), {
    wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
  });
  return { ...hook, client, onError };
}

const changed = (seq: number, runtimeId = "runtime-1"): EventEnvelope => ({
  id: `event-${seq}`, seq, kind: "approval.changed", payload: { runtimeId }, receivedAt: "2026-10-04T00:00:00Z",
});

describe("authoritative approval snapshots", () => {
  it("replaces outstanding approvals after a missed resolution instead of merging the old row", async () => {
    let current = snapshot(1, [approval]);
    const gateway = mockGateway({ "GET /v1/approvals": () => current });
    const { result, client } = setup();
    await waitFor(() => expect(result.current.approvals).toEqual([approval]));
    current = snapshot(2, []);
    await act(async () => { await client.invalidateQueries({ queryKey: queryKeys.pendingApprovals }); });

    await waitFor(() => expect(result.current.approvals).toEqual([]));
    expect(new URL(gateway.callsFor("GET", "/v1/approvals")[0].url).searchParams.has("status")).toBe(false);
  });

  it("keeps the authoritative responding row after a successful decision until native resolution", async () => {
    const responding = { ...approval, status: "responding" };
    let current = snapshot(1, [approval]);
    mockGateway({
      "GET /v1/approvals": () => current,
      "POST /v1/approvals/approval-1/decision": () => { current = snapshot(2, [responding]); return responding; },
    });
    const { result } = setup();
    await waitFor(() => expect(result.current.approvals).toEqual([approval]));
    await act(async () => { await result.current.handleApprovalDecision(approval, { decision: "accept" }); });

    await waitFor(() => expect(result.current.approvals).toEqual([responding]));
  });

  it("does not overwrite a newer snapshot with a lower revision from the same runtime", async () => {
    let current = snapshot(5, []);
    mockGateway({ "GET /v1/approvals": () => current });
    const { result, client } = setup();
    await waitFor(() => expect(client.getQueryState(queryKeys.pendingApprovals)?.status).toBe("success"));
    current = snapshot(4, [approval]);
    await act(async () => { await client.invalidateQueries({ queryKey: queryKeys.pendingApprovals }); });

    expect(result.current.approvals).toEqual([]);
    expect(client.getQueryData(queryKeys.pendingApprovals)).toEqual(snapshot(5, []));
  });

  it("converges two clients when one misses a resolution and then reconnects", async () => {
    let current = snapshot(1, [approval]);
    mockGateway({ "GET /v1/approvals": () => current });
    const a = setup();
    const b = setup();
    await waitFor(() => expect(a.result.current.approvals).toEqual([approval]));
    await waitFor(() => expect(b.result.current.approvals).toEqual([approval]));

    current = snapshot(2, []);
    act(() => applyApprovalInvalidation(a.client, changed(2)));
    await waitFor(() => expect(a.result.current.approvals).toEqual([]));
    expect(b.result.current.approvals).toEqual([approval]);
    await act(async () => { await refreshApprovalSnapshot(b.client); });
    await waitFor(() => expect(b.result.current.approvals).toEqual([]));
  });

  it("rejects a cancelled old-runtime read and treats old events only as invalidation", async () => {
    let finishOld!: (value: ApprovalListResponse) => void;
    const replacement = { ...approval, id: "approval-replacement", payload: { command: "new runtime command" } };
    let reads = 0;
    const gateway = mockGateway({ "GET /v1/approvals": () => ++reads === 1
      ? new Promise<ApprovalListResponse>((resolve) => { finishOld = resolve; })
      : snapshot(1, [replacement], "runtime-2") });
    const { result, client } = setup();
    await waitFor(() => expect(reads).toBe(1));
    act(() => applyApprovalInvalidation(client, changed(1, "runtime-2")));
    await waitFor(() => expect(result.current.approvals).toEqual([replacement]));
    expect(gateway.callsFor("GET", "/v1/approvals")[0].signal.aborted).toBe(true);
    await act(async () => finishOld(snapshot(99, [approval])));
    expect(result.current.approvals).toEqual([replacement]);

    act(() => applyApprovalInvalidation(client, { ...changed(100), payload: { runtimeId: "runtime-1", approvals: [approval] } }));
    await waitFor(() => expect(reads).toBe(3));
    expect(client.getQueryData(queryKeys.pendingApprovals)).toEqual(snapshot(1, [replacement], "runtime-2"));
    expect(result.current.approvals).toEqual([replacement]);
  });

  it("ignores old row events", async () => {
    const gateway = mockGateway({ "GET /v1/approvals": snapshot(5, []) });
    const { result, client } = setup();
    await waitFor(() => expect(client.getQueryState(queryKeys.pendingApprovals)?.status).toBe("success"));
    act(() => {
      applyApprovalInvalidation(client, { ...changed(100), kind: "approval.created", payload: approval });
    });
    expect(result.current.approvals).toEqual([]);
    expect(gateway.callsFor("GET", "/v1/approvals")).toHaveLength(1);
  });

  it("refetches a lag marker even when its cursor equals the cached snapshot revision", async () => {
    let current = snapshot(10, [approval]);
    mockGateway({ "GET /v1/approvals": () => current });
    const { result, client } = setup();
    await waitFor(() => expect(result.current.approvals).toEqual([approval]));
    current = snapshot(15, []);
    act(() => applyApprovalInvalidation(client, changed(10)));

    await waitFor(() => expect(result.current.approvals).toEqual([]));
  });

  it("reads the native responding state after an ambiguous write error instead of enabling retry", async () => {
    const responding = { ...approval, status: "responding" };
    let current = snapshot(1, [approval]);
    mockGateway({
      "GET /v1/approvals": () => current,
      "POST /v1/approvals/approval-1/decision": () => {
        current = snapshot(2, [responding]);
        return new Response(JSON.stringify({ code: "bad_gateway", message: "Native write failed", retryable: false }), { status: 502 });
      },
    });
    const { result, onError } = setup();
    await waitFor(() => expect(result.current.approvals).toEqual([approval]));
    act(() => result.current.handleApprovalDecision(approval, { decision: "accept" }));
    await waitFor(() => expect(result.current.approvals).toEqual([responding]));
    expect(onError).toHaveBeenCalledOnce();
  });
});
