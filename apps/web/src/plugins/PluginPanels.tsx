import { useEffect, useMemo, useRef, useState } from "react";
import { useTheme } from "../theme/themeStore";
import { panelThemeHead, panelThemeMessage, panelThemeVars } from "./host/panelTheme";
import { hidePanel, listPanels, onPanelsChange, registerFrame, type PanelState } from "./host/uiManager";

/**
 * Renders the sandboxed-iframe panels plugins open via `sketchor.ui.show(html)`,
 * docked alongside the built-in panels (Layers, Diagnostics, Pattern). Each
 * panel is a `sandbox="allow-scripts"` iframe under a strict CSP with an opaque
 * origin: it can't reach `window.sketchor`, the host DOM, or the network — it
 * talks to its plugin only through `postMessage`, relayed by the ui manager.
 */
export function PluginPanels() {
  const [, force] = useState(0);
  useEffect(() => onPanelsChange(() => force((n) => n + 1)), []);

  const panels = listPanels();
  if (panels.length === 0) return null;

  return (
    <>
      {panels.map((panel) => (
        <PluginPanel key={panel.pluginId} panel={panel} />
      ))}
    </>
  );
}

// A tight CSP: inline script/style only (the panel HTML is self-contained), and
// nothing else — no network, no images, no framing out. `sandbox` already gives
// the frame an opaque origin; the CSP is defence in depth on top of it.
const PANEL_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'";

function withCsp(html: string, themeHead: string): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${PANEL_CSP}">${themeHead}`;
  return /<head[\s>]/i.test(html)
    ? html.replace(/<head([^>]*)>/i, `<head$1>${meta}`)
    : `<!doctype html><html><head>${meta}</head><body>${html}</body></html>`;
}

function PluginPanel({ panel }: { panel: PanelState }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const tokens = useTheme((s) => s.tokens);
  // Baked in once per html: re-rendering srcDoc on a theme change would reload the panel and lose its state.
  const tokensRef = useRef(tokens);
  tokensRef.current = tokens;
  const srcDoc = useMemo(
    () => withCsp(panel.html, panelThemeHead(panelThemeVars(tokensRef.current))),
    [panel.html],
  );

  useEffect(() => {
    ref.current?.contentWindow?.postMessage(panelThemeMessage(panelThemeVars(tokens)), "*");
  }, [tokens]);

  useEffect(() => {
    if (ref.current) return registerFrame(panel.pluginId, ref.current);
  }, [panel.pluginId]);

  return (
    <aside
      className="diagpanel pluginpanel dock-left"
      data-testid={`plugin-panel-${panel.pluginId}`}
      style={{ width: panel.width ? `${panel.width}px` : undefined }}
    >
      <div className="diagpanel-header">
        <span>{panel.title}</span>
        <button className="btn ghost" onClick={() => hidePanel(panel.pluginId)} title="Hide panel">
          ✕
        </button>
      </div>
      <iframe
        ref={ref}
        className="pluginpanel-frame"
        title={panel.title}
        sandbox="allow-scripts"
        srcDoc={srcDoc}
        style={{ height: panel.height ? `${panel.height}px` : undefined }}
      />
    </aside>
  );
}
