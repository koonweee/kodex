import "@mantine/core/styles.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import { registerKodexServiceWorker } from "./pwa/registerServiceWorker";
import { initializeKodexColorScheme } from "./theme";

initializeKodexColorScheme();
void registerKodexServiceWorker();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
