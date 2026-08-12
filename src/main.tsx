import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";
// Side-effect import: registers the service worker (production builds only — see
// src/pwa/register.ts) so the app shell precaches on first load regardless of whether any
// component ever renders an update banner. Consume update state via
// src/pwa/useServiceWorkerUpdate.ts.
import "./pwa/register";

const container = document.getElementById("root");
if (!container) {
  throw new Error("#root element not found");
}

ReactDOM.createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
