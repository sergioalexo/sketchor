import { beforeEach, describe, expect, it } from "vitest";
import type { PluginManifest, SignedBundle } from "@sketchor/core";
import {
  getInstalled,
  isKeyTrusted,
  listInstalled,
  removeInstalled,
  saveInstalled,
  setGranted,
  type InstalledPlugin,
} from "./pluginStore";

/**
 * The local install store is what makes an installed plugin survive a reload
 * and what a permission revocation is written back to, so its round-trip has to
 * be exact: a re-install of the same id updates in place (never duplicates), and
 * changing grants preserves everything else on the record.
 */

// Minimal in-memory localStorage — the store's only backing dependency.
class MemStore {
  private m = new Map<string, string>();
  getItem(k: string): string | null {
    return this.m.has(k) ? (this.m.get(k) as string) : null;
  }
  setItem(k: string, v: string): void {
    this.m.set(k, String(v));
  }
  removeItem(k: string): void {
    this.m.delete(k);
  }
}

beforeEach(() => {
  (globalThis as unknown as { localStorage: MemStore }).localStorage = new MemStore();
});

function record(id: string, publicKey: string): InstalledPlugin {
  const manifest: PluginManifest = {
    id,
    version: "1.0.0",
    name: id,
    main: "plugin.js",
    engines: { sketchor: "^0.3.0" },
    permissions: ["read-document", "write-document"],
  };
  const bundle = { manifest: JSON.stringify(manifest), code: "", signature: "s", publicKey } as SignedBundle;
  return { manifest, bundle, granted: ["read-document", "write-document"], trustedKey: publicKey, origin: "file", installedAt: 1 };
}

describe("pluginStore", () => {
  it("starts empty and round-trips a saved plugin", () => {
    expect(listInstalled()).toEqual([]);
    saveInstalled(record("com.a.one", "KEY1"));
    expect(listInstalled()).toHaveLength(1);
    expect(getInstalled("com.a.one")?.manifest.name).toBe("com.a.one");
  });

  it("updates in place on re-install of the same id", () => {
    saveInstalled(record("com.a.one", "KEY1"));
    const updated = record("com.a.one", "KEY1");
    updated.manifest.version = "2.0.0";
    saveInstalled(updated);
    expect(listInstalled()).toHaveLength(1);
    expect(getInstalled("com.a.one")?.manifest.version).toBe("2.0.0");
  });

  it("revokes a permission while preserving the rest of the record", () => {
    saveInstalled(record("com.a.one", "KEY1"));
    setGranted("com.a.one", ["read-document"]);
    const after = getInstalled("com.a.one");
    expect(after?.granted).toEqual(["read-document"]);
    expect(after?.origin).toBe("file");
    expect(after?.trustedKey).toBe("KEY1");
  });

  it("tracks trusted signer keys and forgets an uninstalled plugin", () => {
    saveInstalled(record("com.a.one", "KEY1"));
    expect(isKeyTrusted("KEY1")).toBe(true);
    expect(isKeyTrusted("OTHER")).toBe(false);
    removeInstalled("com.a.one");
    expect(listInstalled()).toEqual([]);
    expect(isKeyTrusted("KEY1")).toBe(false);
  });
});
