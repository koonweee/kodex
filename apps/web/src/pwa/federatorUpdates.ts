import { requestPwaUpdateCheck } from "./registerServiceWorker";
import { subscribeFederationEvent, type FederationEventSourceCtor } from "../api/federationEventSource";

type EventSourceCtor = FederationEventSourceCtor;

export function subscribeToFederatorFrontendUpdates(
  EventSourceCtor = globalThis.EventSource as EventSourceCtor | undefined,
): () => void {
  const isFederated = globalThis.document
    ?.querySelector<HTMLMetaElement>('meta[name="kodex-federator"]')
    ?.content === "true";
  if (!EventSourceCtor || !isFederated) return () => undefined;
  return subscribeFederationEvent({ EventSourceCtor, event: "frontend.updated", listener: () => {
    void requestPwaUpdateCheck().catch(() => undefined);
  } });
}
