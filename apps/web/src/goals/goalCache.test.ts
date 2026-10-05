import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { waitFor } from "@testing-library/react";
import { expect, it } from "vitest";

import type { EventEnvelope } from "../api/client";
import { queryKeys } from "../api/queryKeys";
import { applyThreadGoalEvent, refreshThreadGoals } from "./goalCache";

const marker = (seq: number): EventEnvelope => ({ id: `goal-${seq}`, seq, kind: "thread.goal_changed",
  threadId: "chat", payload: { threadId: "chat" }, receivedAt: "2026-10-06T00:00:00Z" });

it("cancels stale reads for model goal changes and clears, even with an older event cursor", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let release!: (value: string | null) => void;
  let signal: AbortSignal | undefined;
  let reads = 0;
  let native: string | null = "model-created goal";
  const observer = new QueryObserver(client, { queryKey: queryKeys.threadGoal("chat"), queryFn: (context) => {
    reads++;
    if (reads === 1) { signal = context.signal; return new Promise<string | null>((resolve) => { release = resolve; }); }
    return Promise.resolve(native);
  } });
  const unsubscribe = observer.subscribe(() => {});
  applyThreadGoalEvent(client, marker(20));
  await waitFor(() => expect(observer.getCurrentResult().data).toBe(native));
  expect(signal?.aborted).toBe(true);
  release("obsolete goal");
  await Promise.resolve();
  expect(observer.getCurrentResult().data).toBe(native);
  native = null;
  applyThreadGoalEvent(client, { ...marker(2), threadId: null });
  await waitFor(() => expect(observer.getCurrentResult().data).toBeNull());
  unsubscribe(); client.clear();
});

it("refills independent client caches from native state after a missed goal event", async () => {
  let native = "active";
  const clients = [new QueryClient(), new QueryClient()];
  const observers = clients.map((client) => new QueryObserver(client, {
    queryKey: queryKeys.threadGoal("chat"), queryFn: async () => native,
  }));
  const unsubscribe = observers.map((observer) => observer.subscribe(() => {}));
  await waitFor(() => expect(observers.map((o) => o.getCurrentResult().data)).toEqual(["active", "active"]));
  native = "paused";
  applyThreadGoalEvent(clients[0], marker(21));
  await waitFor(() => expect(observers[0].getCurrentResult().data).toBe("paused"));
  expect(observers[1].getCurrentResult().data).toBe("active");
  await refreshThreadGoals(clients[1]);
  expect(observers[1].getCurrentResult().data).toBe("paused");
  unsubscribe.forEach((stop) => stop()); clients.forEach((client) => client.clear());
});

it("retries an unreadable new chat when its first canonical turn begins without polling later turns", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let reads = 0;
  const observer = new QueryObserver(client, { queryKey: queryKeys.threadGoal("chat"), queryFn: async () => {
    if (++reads === 1) throw new Error("Thread has not been materialized");
    return null;
  } });
  const unsubscribe = observer.subscribe(() => {});
  await waitFor(() => expect(observer.getCurrentResult().isError).toBe(true));
  const event = { ...marker(1), kind: "thread_view.patch", payload: { scope: "lifecycle", activeTurnId: "turn" } };
  applyThreadGoalEvent(client, { ...event, payload: { scope: "row_delta", activeTurnId: "turn" } });
  expect(reads).toBe(1);
  applyThreadGoalEvent(client, event);
  await waitFor(() => expect(observer.getCurrentResult().data).toBeNull());
  applyThreadGoalEvent(client, { ...event, seq: 2 });
  await Promise.resolve();
  expect(reads).toBe(2);
  unsubscribe(); client.clear();
});
