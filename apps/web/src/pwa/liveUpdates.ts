import type { EventEnvelope } from "../api/client";
import { requestPwaUpdateCheck } from "./registerServiceWorker";

export const FRONTEND_UPDATED_EVENT = "frontend.updated";

export function handlePwaLiveEvent(event: EventEnvelope): boolean {
  if (event.kind !== FRONTEND_UPDATED_EVENT) return false;
  void requestPwaUpdateCheck().catch(() => undefined);
  return true;
}
