import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";

import { listQueuedInputs, sendFirstQueuedInputNow, sendQueuedInputNow } from "../api/client";
import { queryKeys } from "../api/queryKeys";
import { errorMessageFrom } from "../shared/values";
import { refreshQueuedInputs } from "./cache";

export function useNativeQueue(threadId: string | null) {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: queryKeys.queuedInputs(threadId ?? ""), enabled: threadId !== null,
    queryFn: ({ signal }) => listQueuedInputs(threadId!, signal),
  });
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{ threadId: string; message: string } | null>(null);

  async function mutate(action: () => Promise<unknown>, onSuccess?: () => void) {
    if (inFlight.current || threadId === null) return;
    inFlight.current = true;
    setBusy(true); setFailure(null);
    try { await action(); onSuccess?.(); }
    catch (error) { setFailure({ threadId, message: errorMessageFrom(error) }); }
    finally {
      // A failed/lost reply does not prove native state stayed put.
      try { await refreshQueuedInputs(client, threadId); }
      finally { inFlight.current = false; setBusy(false); }
    }
  }

  function sendNow(queueId?: string) {
    if (threadId === null || !query.data?.queuedInputs.length) return false;
    void mutate(() => queueId === undefined ? sendFirstQueuedInputNow(threadId) : sendQueuedInputNow(threadId, queueId));
    return true;
  }

  function reload() {
    setFailure(null);
    if (threadId !== null) void refreshQueuedInputs(client, threadId);
  }

  return { query, busy, mutate, sendNow, reload,
    error: failure?.threadId === threadId ? failure.message : null,
  };
}

export type NativeQueueController = ReturnType<typeof useNativeQueue>;
