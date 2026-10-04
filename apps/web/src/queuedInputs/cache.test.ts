import { waitFor } from "@testing-library/react";
import { QueryObserver } from "@tanstack/react-query";
import { expect, it } from "vitest";

import { createKodexQueryClient } from "../api/queryClient";
import { queryKeys } from "../api/queryKeys";
import { applyQueueEvent, refreshQueuedInputs } from "./cache";

it("refills both clients from native order and cancels captured stale reads instead of merging deleted rows", async () => {
  const clients = [createKodexQueryClient(), createKodexQueryClient()];
  let rows = ["native-b", "native-a"];
  const signals: AbortSignal[] = [];
  const releases: Array<() => void> = [];
  const observers = clients.map((client) => new QueryObserver(client, {
    queryKey: queryKeys.queuedInputs("chat"),
    queryFn: ({ signal }) => {
      signals.push(signal);
      const captured = [...rows];
      return new Promise<{ queuedInputs: string[]; transfers: never[] }>((resolve) => releases.push(() => resolve({ queuedInputs: captured, transfers: [] })));
    },
  }));
  const stops = observers.map((observer) => observer.subscribe(() => {}));
  expect(signals).toHaveLength(2);
  rows = ["native-a"];
  for (const client of clients) applyQueueEvent(client, { id: "1", seq: 1, kind: "turn_queue.changed", threadId: "chat", payload: { threadId: "chat" }, receivedAt: "2026-10-05T00:00:00Z" });
  await Promise.resolve(); await Promise.resolve();
  expect(signals.slice(0, 2).every((signal) => signal.aborted)).toBe(true);
  await waitFor(() => expect(releases).toHaveLength(4));
  for (const release of releases.slice(2)) release();
  await Promise.resolve(); await Promise.resolve();
  for (const release of releases.slice(0, 2)) release();
  await Promise.resolve(); await Promise.resolve();
  await waitFor(() => { for (const observer of observers) expect(observer.getCurrentResult().data?.queuedInputs).toEqual(["native-a"]); });
  rows = [];
  const refreshes = clients.map((client) => refreshQueuedInputs(client));
  await Promise.resolve(); await Promise.resolve();
  await waitFor(() => expect(releases).toHaveLength(6));
  for (const release of releases.slice(4)) release();
  await Promise.all(refreshes);
  for (const observer of observers) expect(observer.getCurrentResult().data?.queuedInputs).toEqual([]);
  for (const stop of stops) stop();
});
