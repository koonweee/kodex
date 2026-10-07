import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";

import { listQueuedInputs, steerFirstQueuedInput } from "../api/client";
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
    if (inFlight.current || threadId === null) return false;
    inFlight.current = true;
    setBusy(true); setFailure(null);
    try { await action(); onSuccess?.(); return true; }
    catch (error) { setFailure({ threadId, message: errorMessageFrom(error) }); return false; }
    finally {
      // A failed/lost reply does not prove native state stayed put.
      try { await refreshQueuedInputs(client, threadId); }
      finally { inFlight.current = false; setBusy(false); }
    }
  }

  function steerFirst() {
    if (threadId === null || !query.data?.queuedInputs.length) return false;
    void mutate(() => steerFirstQueuedInput(threadId));
    return true;
  }

  function reload() {
    setFailure(null);
    if (threadId !== null) void refreshQueuedInputs(client, threadId);
  }

  return { query, busy, mutate, steerFirst, reload,
    error: failure?.threadId === threadId ? failure.message : null,
  };
}

export type NativeQueueController = ReturnType<typeof useNativeQueue>;
