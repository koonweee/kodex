import { afterEach, describe, expect, it, vi } from "vitest";

import { notificationPermission, requestKodexNotificationPermission } from "./browserNotifications";

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

  it("requests notification permission when supported", async () => {
    const requestPermission = vi.fn().mockResolvedValue("granted");
    const notificationCtor = vi.fn();
    Object.defineProperty(notificationCtor, "permission", { configurable: true, value: "default" });
    Object.defineProperty(notificationCtor, "requestPermission", { configurable: true, value: requestPermission });
    Object.defineProperty(globalThis, "Notification", { configurable: true, value: notificationCtor });

    expect(notificationPermission()).toBe("default");
    await expect(requestKodexNotificationPermission()).resolves.toBe("granted");
    expect(requestPermission).toHaveBeenCalledTimes(1);
  });
});
