import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { initDesktopDxfOpen } from "./dxf/desktopBridge";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

// Wire up "open .dxf from Explorer" when running as the desktop app.
initDesktopDxfOpen();
