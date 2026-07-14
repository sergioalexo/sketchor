import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { initDesktopDxfOpen } from "./dxf/desktopBridge";
import { initUpdateNotifier } from "./update/updateNotifier";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

// Wire up "open .dxf from Explorer" when running as the desktop app.
initDesktopDxfOpen();

// Notify if a newer release is on GitHub (keyless; works on web + desktop).
void initUpdateNotifier();
