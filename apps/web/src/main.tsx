import "@mantine/core/styles.css";

import { StrictMode, useMemo } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import { FederatedInstanceBoundary, type FederatedRuntimeSnapshot } from "./api/FederatedInstanceBoundary";
import { GatewayInstanceBoundary } from "./api/GatewayInstanceBoundary";
import { isFederatedAppShell } from "./api/federatorClient";
import { queryClient } from "./api/queryClient";
import { isThemeWorkbenchRoute } from "./shell/browserRouting";
import { initializeKodexColorScheme } from "./theme";
import { createBrowserWorkspacePaneStore } from "./workspace/paneStore";

initializeKodexColorScheme();

function FederatedApp({
  availableExecutorIds,
  catalog,
  catalogError,
  catalogRefreshing,
  defaultRuntime,
  defaultRuntimeAvailable,
  executors,
  moveCatalogItem,
  probeExecutor,
  registerExecutor,
  removeExecutor,
  refreshCatalog,
  refreshExecutors,
  routeError,
  runtimes,
  workspaceStorage,
  updateExecutor,
}: FederatedRuntimeSnapshot) {
  const workspacePaneStore = useMemo(
    () => createBrowserWorkspacePaneStore(workspaceStorage, runtimes[0]?.connection.executorId ?? defaultRuntime.connection.executorId),
    [defaultRuntime.connection.executorId, runtimes, workspaceStorage],
  );
  return (
    <App
      executorRuntime={defaultRuntime}
      executorRuntimes={runtimes}
      availableExecutorIds={availableExecutorIds}
      federatedCatalog={catalog}
      federatedCatalogError={catalogError}
      federatedCatalogRefreshing={catalogRefreshing}
      federatedExecutors={executors}
      moveFederatedCatalogItem={moveCatalogItem}
      probeFederatedExecutor={probeExecutor}
      registerFederatedExecutor={registerExecutor}
      removeFederatedExecutor={removeExecutor}
      refreshFederatedCatalog={refreshCatalog}
      refreshFederatedExecutors={refreshExecutors}
      updateFederatedExecutor={updateExecutor}
      federatedRouteError={routeError}
      federatedShellAvailable={defaultRuntimeAvailable}
      workspacePaneStore={workspacePaneStore}
    />
  );
}

const app = isFederatedAppShell() && !isThemeWorkbenchRoute() ? (
  <FederatedInstanceBoundary>{(snapshot) => <FederatedApp {...snapshot} />}</FederatedInstanceBoundary>
) : (
  <GatewayInstanceBoundary queryClient={queryClient}>
    <App />
  </GatewayInstanceBoundary>
);

createRoot(document.getElementById("root")!).render(<StrictMode>{app}</StrictMode>);
