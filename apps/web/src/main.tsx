import "@mantine/core/styles.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { NativeHostBoundary } from "./mastra/NativeHostBoundary";
import { usesMastraBackend } from "./mastra/client";
import { App } from "./App";
import { GatewayInstanceBoundary } from "./api/GatewayInstanceBoundary";
import { queryClient } from "./api/queryClient";
import { initializeKodexColorScheme } from "./theme";

initializeKodexColorScheme();
const InstanceBoundary = usesMastraBackend ? NativeHostBoundary : GatewayInstanceBoundary;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <InstanceBoundary queryClient={queryClient}>
      <App />
    </InstanceBoundary>
  </StrictMode>,
);
