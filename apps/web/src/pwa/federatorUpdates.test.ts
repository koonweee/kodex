import { beforeEach, describe, expect, it, vi } from "vitest";

import { subscribeToFederatorFrontendUpdates } from "./federatorUpdates";
import { requestPwaUpdateCheck } from "./registerServiceWorker";

vi.mock("./registerServiceWorker", () => ({ requestPwaUpdateCheck: vi.fn() }));

describe("subscribeToFederatorFrontendUpdates", () => {
  beforeEach(() => vi.mocked(requestPwaUpdateCheck).mockReset());

  it("checks the service worker for named federator update events and closes cleanly", async () => {
    const marker = document.createElement("meta");
    marker.name = "kodex-federator";
    marker.content = "true";
    document.head.append(marker);
    let listener: (() => void) | undefined;
    const close = vi.fn();
    class FakeEventSource {
      constructor(public readonly url: string) {
        expect(url).toBe("/v1/federation/frontend-events");
      }

      addEventListener(type: string, next: () => void) {
        expect(type).toBe("frontend.updated");
        listener = next;
      }

      close = close;
    }
    vi.mocked(requestPwaUpdateCheck).mockResolvedValue(undefined);

    const unsubscribe = subscribeToFederatorFrontendUpdates(FakeEventSource);
    listener?.();
    await Promise.resolve();
    expect(requestPwaUpdateCheck).toHaveBeenCalledOnce();

    unsubscribe();
    expect(close).toHaveBeenCalledOnce();
    marker.remove();
  });

  it("does not open a federator stream from the legacy combined app shell", () => {
    const EventSourceCtor = vi.fn();
    subscribeToFederatorFrontendUpdates(EventSourceCtor as never);
    expect(EventSourceCtor).not.toHaveBeenCalled();
  });
});
