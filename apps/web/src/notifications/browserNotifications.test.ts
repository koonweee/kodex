import { afterEach, describe, expect, it, vi } from "vitest";

import { notificationPermission, requestKodexNotificationPermission, showForegroundNotification } from "./browserNotifications";

const OriginalNotification = globalThis.Notification;

afterEach(() => {
  Object.defineProperty(globalThis, "Notification", { configurable: true, value: OriginalNotification });
});

describe("browserNotifications", () => {
  it("reports unsupported when Notification is unavailable", async () => {
    Object.defineProperty(globalThis, "Notification", { configurable: true, value: undefined });

    expect(notificationPermission()).toBe("unsupported");
    await expect(requestKodexNotificationPermission()).resolves.toBe("unsupported");
  });

  it("shows foreground notifications only when permission is granted", () => {
    const notificationCtor = vi.fn();
    Object.defineProperty(notificationCtor, "permission", { configurable: true, value: "granted" });
    Object.defineProperty(globalThis, "Notification", { configurable: true, value: notificationCtor });

    expect(
      showForegroundNotification({
        badgeCount: 1,
        body: "Agent has a new message.",
        kind: "unreadAgentMessage",
        route: "/threads/thread-1",
        tag: "tag",
        threadId: "thread-1",
        title: "Thread",
      }),
    ).toBe(true);
    expect(notificationCtor).toHaveBeenCalledWith("Thread", expect.objectContaining({ body: "Agent has a new message." }));
  });
});
