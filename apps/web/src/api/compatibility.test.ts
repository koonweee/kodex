import { afterEach, describe, expect, it, vi } from "vitest";
import { sendThreadViewPresenceSnapshotBeacon } from "./client";
import { observeApiVersion, compatibleFetch, compatibilityRequired, resetCompatibilityForTests } from "./compatibility";

afterEach(() => { vi.unstubAllGlobals(); resetCompatibilityForTests(); });
describe("API compatibility", () => {
  it("suppresses page-exit writes after a compatibility mismatch", () => {
    const sendBeacon = vi.fn();
    vi.stubGlobal("navigator", { sendBeacon });
    observeApiVersion("future");
    expect(sendThreadViewPresenceSnapshotBeacon({ clientId: "tab", visibleThreadIds: [] })).toBe(false);
    expect(sendBeacon).not.toHaveBeenCalled();
  });
  it("sends its version and stops later writes after another deployment rejects a stale client", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('{}', { status: 409, headers: { "x-kodex-api-version": "future" } }));
    vi.stubGlobal("fetch", fetch);
    await expect(compatibleFetch(new Request("http://localhost/v1/projects", { method: "POST" }))).rejects.toThrow("Update Kodex");
    expect(fetch.mock.calls[0][0].headers.get("x-kodex-api-version")).toBe("1");
    expect(compatibilityRequired()).toBe(true);
    await expect(compatibleFetch(new Request("http://localhost/v1/projects", { method: "POST" }))).rejects.toThrow("Update Kodex");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("probes reads but never exposes an incompatible body to typed consumers", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response('{}', { headers: { "x-kodex-api-version": "future" } })));
    await expect(compatibleFetch(new Request("http://localhost/v1/projects"))).rejects.toThrow("Update Kodex");
    await expect(compatibleFetch(new Request("http://localhost/v1/capabilities"))).rejects.toThrow("Update Kodex");
    expect(compatibilityRequired()).toBe(true);
  });
});
