import { afterEach, describe, expect, it, vi } from "vitest";

import { attachThread, getThreadDetail, getThreadTimelinePage } from "./client";
import { mockGateway } from "../test/gatewayMock";

const routes = {
  "POST /v1/threads/thread-1/attach": {},
  "GET /v1/threads/thread-1": {},
  "GET /v1/threads/thread-1/timeline/pages": {},
};

afterEach(() => vi.restoreAllMocks());

describe("thread detail delivery", () => {
  it("omits optional details by default and requests each preference independently", async () => {
    const gateway = mockGateway(routes);
    await attachThread("thread-1");
    await getThreadDetail("thread-1", undefined, { includeDebugEvents: true });
    await getThreadTimelinePage("thread-1", { cursor: "older", limit: 10, includeCommandOutputs: true });
    const queries = gateway.calls.map((request) => new URL(request.url).searchParams);
    expect(queries[0].has("includeDebugEvents")).toBe(false);
    expect(queries[0].has("includeCommandOutputs")).toBe(false);
    expect(queries[1].get("includeDebugEvents")).toBe("true");
    expect(queries[1].has("includeCommandOutputs")).toBe(false);
    expect(queries[2].get("includeCommandOutputs")).toBe("true");
    expect(queries[2].has("includeDebugEvents")).toBe(false);
    expect(queries[2].get("cursor")).toBe("older");
    expect(queries[2].get("limit")).toBe("10");
  });
});
