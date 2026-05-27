import { useEffect } from "react";

import type { EventEnvelope } from "../api/client";
import { createEventStreamClient } from "./stream";
import { recordDuplicateSelectedGlobalDrop, recordLiveEvent } from "./liveDiagnostics";
import { routeGlobalLiveEvent, type LiveEventRouteHandlers } from "./liveRouting";

type CurrentRef<T> = { current: T };

export function useGlobalLiveStream({
  cursorRef,
  handlers,
  selectedThreadId,
  selectedThreadIdRef,
}: {
  cursorRef: CurrentRef<number | undefined>;
  handlers: LiveEventRouteHandlers;
  selectedThreadId: string | null;
  selectedThreadIdRef: CurrentRef<string | null>;
}) {
  useEffect(() => {
    const client = createEventStreamClient({
      cursor: cursorRef.current,
      excludeThreadId: selectedThreadId,
      onEvent: (event: EventEnvelope) => {
        recordLiveEvent("global", event);
        cursorRef.current = Math.max(cursorRef.current ?? 0, event.seq);
        if (selectedThreadIdRef.current && event.threadId === selectedThreadIdRef.current) {
          recordDuplicateSelectedGlobalDrop();
          return;
        }
        routeGlobalLiveEvent(event, handlers);
      },
    });
    client.connect();
    return client.close;
  }, [selectedThreadId]);
}
