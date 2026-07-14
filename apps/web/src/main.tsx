import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { initDesktopDxfOpen } from "./dxf/desktopBridge";
import { initAutoUpdate } from "./update/autoUpdate";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

// Wire up "open .dxf from Explorer" when running as the desktop app.
initDesktopDxfOpen();

// Check GitHub for a newer signed release (desktop only; no-op on web).
void initAutoUpdate();
