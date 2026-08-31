import { useEffect, useRef, useState } from "react";
import { PERMISSIONS, type Permission, type SignedBundle } from "@sketchor/core";
import { installBundle, uninstall, updateGrants, type InstallDecision, type InstallPromptInfo } from "./host/install";
import { listInstalled, onInstalledChange, type InstalledPlugin } from "./host/pluginStore";

/**
 * The plugins manager: installed third-party plugins, the permissions each was
 * granted (revocable), uninstall, and "Install from file…". Installing routes
 * through {@link installBundle}, which refuses anything unsigned, tampered, or
 * version-incompatible before this panel ever shows its approval prompt.
 */

const PERMISSION_LABELS: Record<Permission, string> = {
  "read-document": "Read the drawing",
  "write-document": "Modify the drawing",
  network: "Access the network",
  storage: "Store its own data",
  filesystem: "Read/write files (desktop)",
};

interface PendingPrompt {
  info: InstallPromptInfo;
  resolve: (decision: InstallDecision) => void;
}

export function PluginsPanel({ onClose }: { onClose: () => void }) {
  const [installed, setInstalled] = useState<InstalledPlugin[]>(() => listInstalled());
  const [pending, setPending] = useState<PendingPrompt | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => onInstalledChange(() => setInstalled(listInstalled())), []);

  const onPickFile = async (file: File) => {
    setNotice(null);
    let bundle: SignedBundle;
    try {
      bundle = JSON.parse(await file.text()) as SignedBundle;
    } catch {
      setNotice("That file isn't a valid Sketchor plugin bundle (expected JSON).");
      return;
    }
    const result = await installBundle(bundle, (info) => new Promise((resolve) => setPending({ info, resolve })));
    setPending(null);
    setNotice(result.ok ? `Installed ${result.pluginId}.` : `Not installed: ${result.reason}`);
  };

  const toggleGrant = (plugin: InstalledPlugin, perm: Permission) => {
    const next = plugin.granted.includes(perm)
      ? plugin.granted.filter((p) => p !== perm)
      : [...plugin.granted, perm];
    void updateGrants(plugin.manifest.id, next);
  };

  return (
    <aside className="diagpanel" data-testid="plugins-panel">
      <div className="diagpanel-header">
        <span>Plugins</span>
        <button className="btn ghost" onClick={onClose} title="Hide panel">
          ✕
        </button>
      </div>

      <div className="diagpanel-actions">
        <button className="btn primary" onClick={() => fileRef.current?.click()} data-testid="install-plugin">
          Install from file…
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".json,application/json"
          style={{ display: "none" }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void onPickFile(f);
            e.target.value = "";
          }}
        />
      </div>

      {notice && <div className="diagpanel-empty" data-testid="plugins-notice">{notice}</div>}

      <div className="diagpanel-list">
        {installed.length === 0 ? (
          <div className="diagpanel-empty">
            No third-party plugins installed. First-party tools (Pattern, SVG Export) are always on.
          </div>
        ) : (
          installed.map((p) => (
            <div key={p.manifest.id} className="plugin-row" data-testid={`plugin-${p.manifest.id}`}>
              <div className="plugin-row-head">
                <strong>{p.manifest.name}</strong>
                <span className="plugin-row-ver">v{p.manifest.version}</span>
                <button
                  className="btn ghost sm"
                  onClick={() => uninstall(p.manifest.id)}
                  data-testid={`uninstall-${p.manifest.id}`}
                >
                  Uninstall
                </button>
              </div>
              {p.manifest.publisher && <div className="plugin-row-pub">{p.manifest.publisher}</div>}
              <div className="plugin-perms">
                {(p.manifest.permissions ?? []).length === 0 ? (
                  <span className="plugin-perm-none">Requests no permissions.</span>
                ) : (
                  (p.manifest.permissions ?? []).map((perm) => (
                    <label key={perm} className="plugin-perm">
                      <input
                        type="checkbox"
                        checked={p.granted.includes(perm)}
                        onChange={() => toggleGrant(p, perm)}
                      />
                      {PERMISSION_LABELS[perm]}
                    </label>
                  ))
                )}
              </div>
            </div>
          ))
        )}
      </div>

      {pending && (
        <InstallPromptDialog
          info={pending.info}
          onDecision={(decision) => pending.resolve(decision)}
        />
      )}
    </aside>
  );
}

function InstallPromptDialog({
  info,
  onDecision,
}: {
  info: InstallPromptInfo;
  onDecision: (decision: InstallDecision) => void;
}) {
  const [grants, setGrants] = useState<Permission[]>(info.permissions);

  const toggle = (perm: Permission) =>
    setGrants((g) => (g.includes(perm) ? g.filter((p) => p !== perm) : [...g, perm]));

  return (
    <div className="cmdpalette-backdrop" data-testid="install-prompt">
      <div className="install-dialog" onMouseDown={(e) => e.stopPropagation()}>
        <h3>Install {info.manifest.name}?</h3>
        <div className="install-signer">
          <div>{info.manifest.publisher ?? "Unknown publisher"}</div>
          <div className="install-fingerprint">
            Signed by <code>{info.fingerprint}</code>
            {info.alreadyTrusted ? " (previously trusted)" : " — a new publisher key"}
          </div>
        </div>

        {info.permissions.length > 0 ? (
          <>
            <p className="install-perm-caption">This plugin is requesting:</p>
            <div className="plugin-perms">
              {PERMISSIONS.filter((perm) => info.permissions.includes(perm)).map((perm) => (
                <label key={perm} className="plugin-perm">
                  <input type="checkbox" checked={grants.includes(perm)} onChange={() => toggle(perm)} />
                  {PERMISSION_LABELS[perm]}
                </label>
              ))}
            </div>
          </>
        ) : (
          <p className="install-perm-caption">This plugin requests no permissions.</p>
        )}

        <div className="install-actions">
          <button className="btn ghost" onClick={() => onDecision({ approve: false, grantedPermissions: [] })}>
            Cancel
          </button>
          <button
            className="btn primary"
            data-testid="install-approve"
            onClick={() => onDecision({ approve: true, grantedPermissions: grants })}
          >
            Trust &amp; install
          </button>
        </div>
      </div>
    </div>
  );
}
