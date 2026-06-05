import type { RegisterSWOptions } from "vite-plugin-pwa/types";

export type ServiceWorkerRegistrationResult =
  | { registered: true; registration: ServiceWorkerRegistration }
  | { registered: false; reason: "unsupported" | "insecure-context" | "failed"; error?: unknown };

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

let loadRegisterSW: () => Promise<RegisterSW> = async () => {
  const pwaModule = await import("virtual:pwa-register");
  return pwaModule.registerSW;
};

let registrationStarted = false;
let registrationPromise: Promise<ServiceWorkerRegistrationResult> | null = null;
let serviceWorkerRegistrationPromise: Promise<ServiceWorkerRegistration> | null = null;
let needRefresh = false;
let updateServiceWorker: (() => Promise<void>) | null = null;
let reloadOnControllerChange = false;
let controllerChangeReloadInstalled = false;
let reloadPage = () => {
  window.location.reload();
};

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

function installControllerChangeReload() {
  if (controllerChangeReloadInstalled || !serviceWorkersSupported()) {
    return;
  }
  controllerChangeReloadInstalled = true;
  navigator.serviceWorker.addEventListener?.("controllerchange", () => {
    if (!reloadOnControllerChange) {
      return;
    }
    reloadOnControllerChange = false;
    reloadPage();
  });
}

async function applyWaitingServiceWorkerUpdate(update: (reloadPage?: boolean) => Promise<void>) {
  reloadOnControllerChange = true;
  installControllerChangeReload();
  await update(true);
}

function failedRegistrationResult(error: unknown): ServiceWorkerRegistrationResult {
  return { registered: false, reason: "failed", error };
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
  if (registrationStarted) {
    return registrationPromise ?? registerKodexServiceWorker();
  }

  registrationStarted = true;
  registrationPromise = loadRegisterSW()
    .then(
      (registerSW) =>
        new Promise<ServiceWorkerRegistrationResult>((resolve) => {
          let settled = false;
          const settle = (result: ServiceWorkerRegistrationResult) => {
            if (settled) {
              return;
            }
            settled = true;
            if (!result.registered) {
              registrationStarted = false;
              registrationPromise = null;
              serviceWorkerRegistrationPromise = null;
            } else {
              serviceWorkerRegistrationPromise = Promise.resolve(result.registration);
            }
            resolve(result);
          };
          const settleFailed = (error: unknown) => {
            options.onRegisterError?.(error);
            settle(failedRegistrationResult(error));
          };
          const update = registerSW({
            immediate: true,
            onNeedRefresh() {
              needRefresh = true;
              emitUpdateState();
            },
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

          updateServiceWorker = () => applyWaitingServiceWorkerUpdate(update);
          emitUpdateState();
        }),
    )
    .catch((error: unknown) => {
      registrationStarted = false;
      registrationPromise = null;
      serviceWorkerRegistrationPromise = null;
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
  listeners.clear();
  registrationStarted = false;
  registrationPromise = null;
  serviceWorkerRegistrationPromise = null;
  needRefresh = false;
  updateServiceWorker = null;
  reloadOnControllerChange = false;
  controllerChangeReloadInstalled = false;
  reloadPage = () => {
    window.location.reload();
  };
}

export function setPwaReloadForTests(reloader: () => void): void {
  reloadPage = reloader;
}
