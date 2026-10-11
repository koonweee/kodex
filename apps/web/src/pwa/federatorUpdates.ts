import { requestPwaUpdateCheck } from "./registerServiceWorker";

type EventSourceLike = {
  addEventListener: (type: string, listener: () => void) => void;
  close: () => void;
};

type EventSourceCtor = new (url: string) => EventSourceLike;

export function subscribeToFederatorFrontendUpdates(
  EventSourceCtor = globalThis.EventSource as EventSourceCtor | undefined,
): () => void {
  const isFederated = globalThis.document
    ?.querySelector<HTMLMetaElement>('meta[name="kodex-federator"]')
    ?.content === "true";
  if (!EventSourceCtor || !isFederated) return () => undefined;
  const source = new EventSourceCtor("/v1/federation/frontend-events");
  source.addEventListener("frontend.updated", () => {
    void requestPwaUpdateCheck().catch(() => undefined);
  });
  return () => source.close();
}
