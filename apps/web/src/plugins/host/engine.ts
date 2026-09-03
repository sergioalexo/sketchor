import { HOST_API_VERSION } from "@sketchor/core";

/**
 * Host-API compatibility check. A plugin's `engines.sketchor` is a semver range
 * over the host API version ({@link HOST_API_VERSION}); the host refuses to load
 * a plugin it doesn't satisfy, at load time, with a clear message — never a
 * runtime surprise. Minimal on purpose: it supports the `^x.y.z` caret ranges
 * the manifests use; a full range grammar is a later concern.
 */
export function satisfiesHostApi(range: string): boolean {
  return satisfiesCaret(range, HOST_API_VERSION);
}

export { HOST_API_VERSION };

function satisfiesCaret(range: string, version: string): boolean {
  const m = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(range.trim());
  const v = /^(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (!m || !v) return false;
  const [, rMaj, rMin, rPat] = m.map(Number);
  const [, vMaj, vMin, vPat] = v.map(Number);
  if (vMaj !== rMaj) return false;
  // Caret on a 0.x line pins the minor; otherwise any later minor/patch is fine.
  if (rMaj === 0) return vMin === rMin && vPat >= rPat;
  return vMin > rMin || (vMin === rMin && vPat >= rPat);
}
