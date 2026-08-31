import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { initDesktopFileOpen } from "./dxf/desktopBridge";
import { initUpdateCheck } from "./update/updateService";
import { installPluginDevHandle, loadFirstPartyPlugins, loadInstalledPlugins } from "./plugins";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

// Wire up "open .dxf / .svg / .dwg from Explorer" when running as the desktop app.
initDesktopFileOpen();

// Look for a newer release shortly after launch. On the desktop this uses the
// signed Tauri updater (install in place); on the web it falls back to the
// public GitHub Releases API. Failures stay silent — see updateService.ts.
initUpdateCheck();

// Plugin runtime: boot the first-party plugins (their contributions show up in
// the command palette and the export menu), and keep the console dev handle
// (window.sketchorPlugins) for the sandbox/pattern acceptance checks.
installPluginDevHandle();
void loadFirstPartyPlugins();
void loadInstalledPlugins();
