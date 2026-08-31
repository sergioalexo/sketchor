/**
 * Plugin permissions — the capability tokens a plugin declares in its manifest
 * and the user grants on install.
 *
 * Capabilities are enforced at the host's RPC boundary, never by trust: a
 * plugin without `write-document` cannot mutate the drawing regardless of what
 * it sends, because the host checks the grant before turning any intent into a
 * Command. See `docs/plugin-architecture.md` §5.
 */

/** Every permission a plugin can request. Ordered least → most sensitive. */
export const PERMISSIONS = [
  /** Read the document read-model and subscribe to its changes. */
  "read-document",
  /** Emit Commands that mutate the drawing (applied as one undo step). */
  "write-document",
  /** Host-mediated `fetch`; the sandbox has no ambient network otherwise. */
  "network",
  /** A namespaced key/value store scoped to this plugin. */
  "storage",
  /** Read/write drawing files. Desktop only (backed by Tauri commands). */
  "filesystem",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/** The set of permissions the user has granted a plugin at runtime. */
export type GrantedCapabilities = ReadonlySet<Permission>;

export function isPermission(value: unknown): value is Permission {
  return typeof value === "string" && (PERMISSIONS as readonly string[]).includes(value);
}

export function hasCapability(granted: GrantedCapabilities, cap: Permission): boolean {
  return granted.has(cap);
}

/**
 * Thrown by the host when a plugin invokes an API it wasn't granted. Carried
 * across the RPC boundary as a plain `{ code, permission }` payload.
 */
export class CapabilityError extends Error {
  readonly code = "capability-denied" as const;
  constructor(readonly permission: Permission) {
    super(`Plugin lacks the "${permission}" permission required for this call`);
    this.name = "CapabilityError";
  }
}
