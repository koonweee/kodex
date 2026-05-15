export type ServiceWorkerRegistrationResult =
  | { registered: true; registration: ServiceWorkerRegistration }
  | { registered: false; reason: "unsupported" | "insecure-context" | "failed"; error?: unknown };

export async function registerKodexServiceWorker(): Promise<ServiceWorkerRegistrationResult> {
  if (
    typeof navigator === "undefined" ||
    !navigator.serviceWorker ||
    typeof navigator.serviceWorker.register !== "function"
  ) {
    return { registered: false, reason: "unsupported" };
  }
  if (typeof window !== "undefined" && window.isSecureContext === false) {
    return { registered: false, reason: "insecure-context" };
  }

  try {
    const registration = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
    return { registered: true, registration };
  } catch (error) {
    return { registered: false, reason: "failed", error };
  }
}
