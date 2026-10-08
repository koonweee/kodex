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
const TERMINAL_WORKER_STATES = new Set<ServiceWorkerState>(["installed", "activated", "redundant"]);
let loadRegisterSW: () => Promise<RegisterSW> = async () => {
  const pwaModule = await import("virtual:pwa-register");
  return pwaModule.registerSW;
};

let registrationStarted = false;
let registrationPromise: Promise<ServiceWorkerRegistrationResult> | null = null;
let serviceWorkerRegistrationPromise: Promise<ServiceWorkerRegistration> | null = null;
let needRefresh = false;
let updateServiceWorker: (() => Promise<void>) | null = null;
let updateCheckPromise: Promise<void> | null = null;
let updateCheckQueued = false;
let installingWorker: ServiceWorker | null = null;
let installingWorkerListener: (() => void) | null = null;
let deferredUpdateCheck: ReturnType<typeof setTimeout> | null = null;

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

function clearInstallingWorkerListener() {
  if (installingWorker && installingWorkerListener) {
    installingWorker.removeEventListener("statechange", installingWorkerListener);
  }
  installingWorker = null;
  installingWorkerListener = null;
}

function queueCheckAfterInstall(registration: ServiceWorkerRegistration): Promise<void> {
  updateCheckQueued = true;
  const worker = registration.installing;
  if (!worker || installingWorker === worker) return Promise.resolve();
  clearInstallingWorkerListener();
  installingWorker = worker;
  installingWorkerListener = () => {
    if (registration.installing === worker && !TERMINAL_WORKER_STATES.has(worker.state)) {
      return;
    }
    clearInstallingWorkerListener();
    if (!updateCheckQueued || deferredUpdateCheck) return;
    deferredUpdateCheck = setTimeout(() => {
      deferredUpdateCheck = null;
      if (!updateCheckQueued) return;
      updateCheckQueued = false;
      void updateRegistration(registration);
    }, 0);
  };
  worker.addEventListener("statechange", installingWorkerListener);
  installingWorkerListener();
  return Promise.resolve();
}

function updateRegistration(registration: ServiceWorkerRegistration): Promise<void> {
  if (typeof registration.update !== "function") {
    return Promise.resolve();
  }
  if (registration.installing && !TERMINAL_WORKER_STATES.has(registration.installing.state)) {
    return queueCheckAfterInstall(registration);
  }
  if (updateCheckPromise) {
    updateCheckQueued = true;
    return updateCheckPromise;
  }
  const check = Promise.resolve().then(() => registration.update()).then(() => undefined, () => undefined).finally(() => {
    if (updateCheckPromise !== check) return;
    updateCheckPromise = null;
    if (updateCheckQueued) {
      updateCheckQueued = false;
      void updateRegistration(registration);
    }
  });
  updateCheckPromise = check;
  return check;
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
              workerContainer.removeEventListener?.("controllerchange", onControllerChange);
              registrationStarted = false;
              registrationPromise = null;
              serviceWorkerRegistrationPromise = null;
              updateServiceWorker = null;
              needRefresh = false;
              emitUpdateState();
            } else {
              serviceWorkerRegistrationPromise = Promise.resolve(result.registration);
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

export async function requestPwaUpdateCheck(): Promise<void> {
  const result = await registerPwaServiceWorker();
  if (result.registered) {
    await updateRegistration(result.registration);
  }
}

export function setRegisterSWLoaderForTests(loader: () => Promise<RegisterSW>): void {
  loadRegisterSW = loader;
  resetPwaServiceWorkerStateForTests();
}

export function resetPwaServiceWorkerStateForTests(): void {
  clearInstallingWorkerListener();
  if (deferredUpdateCheck) clearTimeout(deferredUpdateCheck);
  deferredUpdateCheck = null;
  listeners.clear();
  registrationStarted = false;
  registrationPromise = null;
  serviceWorkerRegistrationPromise = null;
  needRefresh = false;
  updateServiceWorker = null;
  updateCheckPromise = null;
  updateCheckQueued = false;
}
