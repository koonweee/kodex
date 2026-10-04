import "@mantine/core/styles.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import { GatewayInstanceBoundary } from "./api/GatewayInstanceBoundary";
import { queryClient } from "./api/queryClient";
import { initializeKodexColorScheme } from "./theme";

initializeKodexColorScheme();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <GatewayInstanceBoundary queryClient={queryClient}>
      <App />
    </GatewayInstanceBoundary>
  </StrictMode>,
);
