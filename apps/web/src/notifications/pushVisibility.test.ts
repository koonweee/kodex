import { describe, expect, it } from "vitest";

import { pushNotificationThreadVisible } from "./pushVisibility";

describe("pushNotificationThreadVisible", () => {
  it("matches an open Kodex thread window for unread agent message payloads", () => {
    expect(
      pushNotificationThreadVisible(
        { kind: "unreadAgentMessage", threadId: "thread-1" },
        [{ url: "http://localhost:5173/threads/thread-1?panel=threads" }],
        "http://localhost:5173",
      ),
    ).toBe(true);
  });

  it("does not match other threads or origins", () => {
    expect(
      pushNotificationThreadVisible(
        { kind: "unreadAgentMessage", threadId: "thread-1" },
        [
          { url: "http://localhost:5173/threads/thread-2" },
          { url: "https://example.com/threads/thread-1" },
        ],
        "http://localhost:5173",
      ),
    ).toBe(false);
  });

  it("matches encoded thread ids", () => {
    expect(
      pushNotificationThreadVisible(
        { kind: "unreadAgentMessage", threadId: "thread/with spaces" },
        [{ url: "http://localhost:5173/threads/thread%2Fwith%20spaces" }],
        "http://localhost:5173",
      ),
    ).toBe(true);
  });
});
