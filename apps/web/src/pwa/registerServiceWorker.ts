import type { RegisterSWOptions } from "vite-plugin-pwa/types";

export type ServiceWorkerRegistrationResult =
  | { registered: true; registration: ServiceWorkerRegistration }
  | { registered: false; reason: "unsupported" | "insecure-context" | "cross-origin-api" | "failed"; error?: unknown };

export type PwaUpdateState = {
  needRefresh: boolean;
  updateServiceWorker: (() => Promise<void>) | null;
};

type RegisterSW = (options?: RegisterSWOptions) => (reloadPage?: boolean) => Promise<void>;
type PwaUpdateListener = (state: PwaUpdateState) => void;

type PwaRegistrationOptions = {
  onOfflineReady?: () => void;
  onRegisterError?: (error: unknown) => void;
};

const listeners = new Set<PwaUpdateListener>();
const UPDATE_CHECK_INTERVAL_MS = 60_000;

let loadRegisterSW: () => Promise<RegisterSW> = async () => {
  const pwaModule = await import("virtual:pwa-register");
  return pwaModule.registerSW;
};

let registrationStarted = false;
let registrationPromise: Promise<ServiceWorkerRegistrationResult> | null = null;
let serviceWorkerRegistrationPromise: Promise<ServiceWorkerRegistration> | null = null;
let needRefresh = false;
let updateServiceWorker: (() => Promise<void>) | null = null;
let stopUpdateChecks: (() => void) | null = null;

export function pwaGatewayIsSameOrigin(): boolean {
  if (typeof window === "undefined") return false;
  const apiBaseUrl = import.meta.env.VITE_KODEX_API_BASE_URL;
  if (!apiBaseUrl) return true;
  try {
    return new URL(apiBaseUrl, window.location.origin).origin === window.location.origin;
  } catch {
    return false;
  }
}

function serviceWorkersSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    "serviceWorker" in navigator &&
    typeof navigator.serviceWorker?.getRegistration === "function"
  );
}

function serviceWorkersSecure(): boolean {
  return typeof window === "undefined" || window.isSecureContext !== false;
}

function emitUpdateState() {
  const state = getPwaUpdateState();
  listeners.forEach((listener) => listener(state));
}

function failedRegistrationResult(error: unknown): ServiceWorkerRegistrationResult {
  return { registered: false, reason: "failed", error };
}

function startUpdateChecks(registration: ServiceWorkerRegistration) {
  stopUpdateChecks?.();
  if (typeof registration.update !== "function") return;

  let checking = false;
  let lastCheckAt = Date.now();
  const check = () => {
    if (checking || Date.now() - lastCheckAt < UPDATE_CHECK_INTERVAL_MS ||
      document.visibilityState !== "visible" || !navigator.onLine || registration.installing) return;
    checking = true;
    lastCheckAt = Date.now();
    void registration.update().catch(() => undefined).finally(() => { checking = false; });
  };
  const onVisibilityChange = () => check();
  document.addEventListener("visibilitychange", onVisibilityChange);
  const interval = window.setInterval(check, UPDATE_CHECK_INTERVAL_MS);
  stopUpdateChecks = () => {
    document.removeEventListener("visibilitychange", onVisibilityChange);
    window.clearInterval(interval);
    stopUpdateChecks = null;
  };
}

async function activeServiceWorkerRegistration(): Promise<ServiceWorkerRegistration> {
  if (!serviceWorkersSupported()) {
    throw new Error("Service workers are not supported");
  }
  const registration = await navigator.serviceWorker.getRegistration();
  if (!registration) {
    throw new Error("Service worker registration is unavailable");
  }
  return registration;
}

export function getPwaUpdateState(): PwaUpdateState {
  return {
    needRefresh,
    updateServiceWorker,
  };
}

export function subscribeToPwaUpdates(listener: PwaUpdateListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export async function registerPwaServiceWorker(
  options: PwaRegistrationOptions = {},
): Promise<ServiceWorkerRegistrationResult> {
  if (!serviceWorkersSupported()) {
    return { registered: false, reason: "unsupported" };
  }
  if (!serviceWorkersSecure()) {
    return { registered: false, reason: "insecure-context" };
  }
  // Worker badge reads and notification navigation use the frontend origin.
  // Development can use Vite's same-origin proxy for the retained PWA features.
  if (!pwaGatewayIsSameOrigin()) {
    return { registered: false, reason: "cross-origin-api" };
  }
  if (registrationStarted) {
    return registrationPromise ?? registerKodexServiceWorker();
  }

  registrationStarted = true;
  registrationPromise = loadRegisterSW()
    .then(
      (registerSW) =>
        new Promise<ServiceWorkerRegistrationResult>((resolve) => {
          let settled = false;
          let registrationFailed = false;
          let updateRequested = false;
          let reloadAvailable = false;
          const workerContainer = navigator.serviceWorker;
          let controlled = Boolean(workerContainer.controller);
          const onControllerChange = () => {
            const initialClaim = !controlled;
            controlled = true;
            if (initialClaim && !needRefresh && !updateRequested) return;
            if (updateRequested) {
              updateRequested = false;
              window.location.reload();
            } else {
              reloadAvailable = true;
              needRefresh = true;
              emitUpdateState();
            }
          };
          workerContainer.addEventListener?.("controllerchange", onControllerChange);
          const settle = (result: ServiceWorkerRegistrationResult) => {
            if (settled) {
              return;
            }
            settled = true;
            if (!result.registered) {
              registrationFailed = true;
              stopUpdateChecks?.();
              workerContainer.removeEventListener?.("controllerchange", onControllerChange);
              registrationStarted = false;
              registrationPromise = null;
              serviceWorkerRegistrationPromise = null;
              updateServiceWorker = null;
              needRefresh = false;
              emitUpdateState();
            } else {
              serviceWorkerRegistrationPromise = Promise.resolve(result.registration);
              startUpdateChecks(result.registration);
            }
            resolve(result);
          };
          const settleFailed = (error: unknown) => {
            options.onRegisterError?.(error);
            settle(failedRegistrationResult(error));
          };
          let update: ReturnType<RegisterSW>;
          try {
            update = registerSW({
              immediate: true,
              onNeedRefresh() {
                needRefresh = true;
                emitUpdateState();
              },
              // Workbox captures isUpdate at first registration, so its reload
              // callback misses a later update in the initially uncontrolled tab.
              // Use one controllerchange owner and suppress the plugin's default.
              // Each tab still requires explicit acceptance to preserve its drafts.
              onNeedReload() {},
              onOfflineReady() {
                options.onOfflineReady?.();
              },
              onRegisteredSW(_scriptUrl, registration) {
                if (registration) {
                  settle({ registered: true, registration });
                  return;
                }
                void activeServiceWorkerRegistration()
                  .then((activeRegistration) => settle({ registered: true, registration: activeRegistration }))
                  .catch(settleFailed);
              },
              onRegisterError(error) {
                settleFailed(error);
              },
            });
          } catch (error) {
            settleFailed(error);
            return;
          }
          if (registrationFailed) return;

          updateServiceWorker = async () => {
            if (reloadAvailable) {
              reloadAvailable = false;
              window.location.reload();
              return;
            }
            updateRequested = true;
            try {
              await update(true);
            } catch (error) {
              updateRequested = false;
              throw error;
            }
          };
          emitUpdateState();
        }),
    )
    .catch((error: unknown) => {
      registrationStarted = false;
      stopUpdateChecks?.();
      registrationPromise = null;
      serviceWorkerRegistrationPromise = null;
      updateServiceWorker = null;
      needRefresh = false;
      emitUpdateState();
      options.onRegisterError?.(error);
      return failedRegistrationResult(error);
    });

  return registrationPromise;
}

export async function registerKodexServiceWorker(): Promise<ServiceWorkerRegistrationResult> {
  return registerPwaServiceWorker();
}

export async function getServiceWorkerRegistration(): Promise<ServiceWorkerRegistration> {
  const result = await registerPwaServiceWorker();
  if (!result.registered) {
    throw result.error instanceof Error ? result.error : new Error(`Service worker registration ${result.reason}`);
  }
  if (!serviceWorkerRegistrationPromise) {
    serviceWorkerRegistrationPromise = activeServiceWorkerRegistration();
  }
  return serviceWorkerRegistrationPromise;
}

export function setRegisterSWLoaderForTests(loader: () => Promise<RegisterSW>): void {
  loadRegisterSW = loader;
  resetPwaServiceWorkerStateForTests();
}

export function resetPwaServiceWorkerStateForTests(): void {
  stopUpdateChecks?.();
  listeners.clear();
  registrationStarted = false;
  registrationPromise = null;
  serviceWorkerRegistrationPromise = null;
  needRefresh = false;
  updateServiceWorker = null;
}
