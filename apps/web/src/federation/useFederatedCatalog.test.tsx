import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { CatalogEvent, FederatedCatalog, FederatorClient } from "../api/federatorClient";
import { useFederatedCatalog } from "./useFederatedCatalog";

const emptyCatalog = (revision: number, orderRevision = revision): FederatedCatalog => ({
  revision,
  orderRevision,
  projectOrder: [],
  pinnedOrder: [],
  executors: [],
});
const noopSubscribe = () => () => undefined;

function Probe({ client, subscribe }: {
  client: Pick<FederatorClient, "getCatalog" | "moveCatalogItem" | "refreshCatalog">;
  subscribe: (options: { onEvent: (event: CatalogEvent) => void }) => () => void;
}) {
  const state = useFederatedCatalog({ client, subscribe });
  return <p>{state.catalog?.revision ?? "none"}:{state.catalog?.orderRevision ?? "none"}:{state.error ?? "ok"}</p>;
}

function MoveProbe({ client }: { client: Pick<FederatorClient, "getCatalog" | "moveCatalogItem" | "refreshCatalog"> }) {
  const state = useFederatedCatalog({ client, subscribe: noopSubscribe });
  return <button onClick={() => {
    void state.moveItem("project", { executorId: "mac", nativeId: "one" }, null).catch(() => undefined);
  }}>Move</button>;
}

describe("useFederatedCatalog", () => {
  it("shows cached catalog before refreshing and then applies the refreshed snapshot", async () => {
    let resolveRefresh!: (catalog: FederatedCatalog) => void;
    const client = {
      getCatalog: vi.fn().mockResolvedValue(emptyCatalog(2)),
      refreshCatalog: vi.fn(() => new Promise<FederatedCatalog>((resolve) => { resolveRefresh = resolve; })),
      moveCatalogItem: vi.fn(async (_kind, request) => ({ items: [], orderRevision: request.orderRevision + 1 })),
    };

    render(<Probe client={client} subscribe={() => () => undefined} />);

    expect(await screen.findByText("2:2:ok")).toBeInTheDocument();
    expect(client.refreshCatalog).toHaveBeenCalledTimes(1);
    act(() => resolveRefresh(emptyCatalog(3)));
    expect(await screen.findByText("3:3:ok")).toBeInTheDocument();
  });

  it("refetches on invalidation and fences an older overlapping response", async () => {
    let publish!: (event: CatalogEvent) => void;
    let resolveOlder!: (catalog: FederatedCatalog) => void;
    const client = {
      getCatalog: vi.fn()
        .mockResolvedValueOnce(emptyCatalog(4))
        .mockImplementationOnce(() => new Promise<FederatedCatalog>((resolve) => { resolveOlder = resolve; }))
        .mockResolvedValueOnce(emptyCatalog(6)),
      refreshCatalog: vi.fn().mockResolvedValue(emptyCatalog(4)),
      moveCatalogItem: vi.fn(async (_kind, request) => ({ items: [], orderRevision: request.orderRevision + 1 })),
    };

    render(<Probe client={client} subscribe={({ onEvent }) => { publish = onEvent; return () => undefined; }} />);
    expect(await screen.findByText("4:4:ok")).toBeInTheDocument();

    act(() => publish({ revision: 5, orderRevision: 5 }));
    act(() => publish({ revision: 6, orderRevision: 6 }));
    expect(await screen.findByText("6:6:ok")).toBeInTheDocument();
    act(() => resolveOlder(emptyCatalog(5)));
    await waitFor(() => expect(screen.getByText("6:6:ok")).toBeInTheDocument());
  });

  it("keeps the last good catalog visible when refresh fails", async () => {
    const client = {
      getCatalog: vi.fn().mockResolvedValue(emptyCatalog(7)),
      refreshCatalog: vi.fn().mockRejectedValue(new Error("offline")),
      moveCatalogItem: vi.fn(async (_kind, request) => ({ items: [], orderRevision: request.orderRevision + 1 })),
    };

    render(<Probe client={client} subscribe={() => () => undefined} />);

    expect(await screen.findByText("7:7:Unable to refresh federated navigation.")).toBeInTheDocument();
  });

  it("refills authoritative order after a stale move is rejected", async () => {
    const client = {
      getCatalog: vi.fn().mockResolvedValue(emptyCatalog(8)),
      refreshCatalog: vi.fn().mockResolvedValue(emptyCatalog(8)),
      moveCatalogItem: vi.fn().mockRejectedValue(new Error("stale order revision")),
    };
    render(<MoveProbe client={client} />);
    await waitFor(() => expect(client.refreshCatalog).toHaveBeenCalledTimes(1));

    await userEvent.click(screen.getByRole("button", { name: "Move" }));

    await waitFor(() => expect(client.getCatalog).toHaveBeenCalledTimes(2));
  });
});
