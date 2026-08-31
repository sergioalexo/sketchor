import {
  keyFingerprint,
  validateManifest,
  verifyBundleSignature,
  type Permission,
  type PluginManifest,
  type SignedBundle,
} from "@sketchor/core";
import { loadPlugin, stopPlugin } from "../index";
import { satisfiesHostApi, HOST_API_VERSION } from "./engine";
import {
  getInstalled,
  isKeyTrusted,
  removeInstalled,
  saveInstalled,
  setGranted,
  type InstalledPlugin,
} from "./pluginStore";

/**
 * The install flow — the plugin marketplace's trust gate. It turns a signed
 * bundle into a running plugin **only** after, in order: the manifest parses and
 * validates; its `engines.sketchor` satisfies this host; the signature verifies;
 * and the user approves the signer and the requested permissions. Any failure
 * short-circuits with a clear, user-facing reason — an unsigned, tampered, or
 * version-incompatible plugin never reaches the worker.
 *
 * A valid signature proves integrity and that the holder of the signer key
 * produced the bundle; trusting the *key* is the user's explicit decision at the
 * prompt (trust-on-first-use), surfaced with its fingerprint.
 */

export interface InstallPromptInfo {
  manifest: PluginManifest;
  /** The requested permissions, for the grant UI. */
  permissions: Permission[];
  /** The signer key's fingerprint, shown so the user can recognise the publisher. */
  fingerprint: string;
  /** Whether the user has trusted this signer key before (an update, not a new publisher). */
  alreadyTrusted: boolean;
}

export interface InstallDecision {
  approve: boolean;
  /** The subset of requested permissions to grant (defaults to all requested). */
  grantedPermissions: Permission[];
}

export type InstallPrompt = (info: InstallPromptInfo) => Promise<InstallDecision>;

export type InstallResult = { ok: true; pluginId: string } | { ok: false; reason: string };

export async function installBundle(bundle: SignedBundle, prompt: InstallPrompt): Promise<InstallResult> {
  // 1. Parse & validate the manifest.
  let parsed: unknown;
  try {
    parsed = JSON.parse(bundle.manifest);
  } catch {
    return { ok: false, reason: "manifest.json is not valid JSON" };
  }
  const validation = validateManifest(parsed);
  if (!validation.ok) return { ok: false, reason: `Invalid manifest: ${validation.errors.join("; ")}` };
  const manifest = validation.manifest;

  // 2. Host-API compatibility — refuse an incompatible plugin before anything else runs.
  if (!satisfiesHostApi(manifest.engines.sketchor)) {
    return {
      ok: false,
      reason: `Needs Sketchor plugin API ${manifest.engines.sketchor}, but this host provides ${HOST_API_VERSION}.`,
    };
  }

  // 3. Signature — the code and manifest must be intact and signed by the embedded key.
  if (!bundle.signature || !bundle.publicKey) {
    return { ok: false, reason: "Plugin is unsigned. Sketchor only installs signed plugins." };
  }
  if (!(await verifyBundleSignature(bundle))) {
    return { ok: false, reason: "Signature is invalid — the bundle is unsigned, corrupt, or tampered with." };
  }

  // 4. Ask the user to trust the signer and grant permissions.
  const requested = manifest.permissions ?? [];
  const decision = await prompt({
    manifest,
    permissions: requested,
    fingerprint: await keyFingerprint(bundle.publicKey),
    alreadyTrusted: isKeyTrusted(bundle.publicKey),
  });
  if (!decision.approve) return { ok: false, reason: "Installation declined." };

  // Never grant a permission the manifest didn't request.
  const granted = decision.grantedPermissions.filter((p) => requested.includes(p));

  // 5. Persist and load.
  const record: InstalledPlugin = {
    manifest,
    bundle,
    granted,
    trustedKey: bundle.publicKey,
    installedAt: Date.now(),
  };
  saveInstalled(record);
  try {
    await loadPlugin({ manifest, source: bundle.code, permissions: granted });
  } catch (err) {
    return { ok: false, reason: `Installed, but failed to start: ${err instanceof Error ? err.message : String(err)}` };
  }
  return { ok: true, pluginId: manifest.id };
}

/** Stops an installed plugin and forgets it (removes its stored bundle and grants). */
export function uninstall(id: string): void {
  stopPlugin(id);
  removeInstalled(id);
}

/**
 * Revokes or re-grants an installed plugin's permissions and restarts it under
 * the new set. Capabilities are fixed when a plugin's host is created, so a
 * revocation only takes real effect on reload — which is exactly what this does.
 */
export async function updateGrants(id: string, granted: Permission[]): Promise<void> {
  const plugin = getInstalled(id);
  if (!plugin) return;
  const next = granted.filter((p) => (plugin.manifest.permissions ?? []).includes(p));
  setGranted(id, next);
  await loadPlugin({ manifest: plugin.manifest, source: plugin.bundle.code, permissions: next });
}
