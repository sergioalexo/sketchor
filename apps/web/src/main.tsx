import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { initDesktopFileOpen } from "./dxf/desktopBridge";
import { initUpdateNotifier } from "./update/updateNotifier";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

// Wire up "open .dxf / .sketchor from Explorer" when running as the desktop app.
initDesktopFileOpen();

// Notify if a newer release is on GitHub (keyless; works on web + desktop).
void initUpdateNotifier();
