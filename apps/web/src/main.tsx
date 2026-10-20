import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createServices, ServicesProvider } from "./app-context.tsx";
import { App } from "./App.tsx";
import { registerServiceWorker } from "./pwa.ts";
import "./styles.css";

registerServiceWorker();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ServicesProvider services={createServices()}>
      <App />
    </ServicesProvider>
  </StrictMode>,
);
