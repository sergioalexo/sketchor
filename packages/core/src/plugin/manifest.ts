import type { Permission } from "./capabilities";
import { isPermission, PERMISSIONS } from "./capabilities";

/**
 * A plugin's `manifest.json`. The contract the host reads to decide whether it
 * can load a plugin (`engines.sketchor` vs. the host API version), what the
 * plugin contributes, and what permissions to prompt for. See
 * `docs/plugin-architecture.md` §5.
 */
export interface PluginManifest {
  /** Reverse-DNS unique id, e.g. "com.acme.gear-generator". */
  id: string;
  /** Plugin semver. */
  version: string;
  /** Display name. */
  name: string;
  description?: string;
  publisher?: string;
  /** Host-compatibility ranges. `sketchor` is a semver range over the host API version. */
  engines: { sketchor: string };
  /** Entry module for the plugin's logic (runs in the worker sandbox). */
  main: string;
  /** Optional entry HTML for a sandboxed-iframe UI panel. */
  ui?: string;
  contributes?: PluginContributions;
  permissions?: Permission[];
}

/** What a plugin adds to the host. Each kind is routed into a host registry. */
export interface PluginContributions {
  commands?: CommandContribution[];
  /** Selection-in → Command[]-out geometry generators (like the built-in pattern). */
  generators?: GeneratorContribution[];
  /** Import/export format handlers, listed next to the built-in DXF/SVG. */
  io?: IoContribution[];
  /** Sandboxed-iframe UI panels. */
  panels?: PanelContribution[];
  /**
   * Interactive drawing tools. Reserved for v2 — the viewport's tool loop must
   * be decoupled first (see `docs/plugin-v1-plan.md`). Declaring one in v1 is a
   * load-time error.
   */
  tools?: ToolContribution[];
}

export interface CommandContribution {
  /** Namespaced id, e.g. "gear.generate". */
  id: string;
  title: string;
  /** Optional icon token or data-URI. */
  icon?: string;
}

export interface GeneratorContribution {
  id: string;
  title: string;
  icon?: string;
}

export interface IoContribution {
  id: string;
  title: string;
  /** "import", "export", or both. */
  direction: ("import" | "export")[];
  /** File extensions this handler claims, without the dot, e.g. ["gcode"]. */
  extensions: string[];
}

export interface PanelContribution {
  id: string;
  title: string;
  icon?: string;
}

export interface ToolContribution {
  id: string;
  title: string;
  icon?: string;
}

export type ManifestValidation =
  | { ok: true; manifest: PluginManifest }
  | { ok: false; errors: string[] };

const ID_RE = /^[a-z0-9]+(?:[-.][a-z0-9]+)*$/i;
const SEMVER_RE = /^\d+\.\d+\.\d+(?:[-+].+)?$/;

/**
 * Validates an untrusted parsed-JSON value as a {@link PluginManifest}.
 * Hand-rolled so `@sketchor/core` stays dependency-free. Collects every problem
 * rather than throwing on the first, so an author sees all of them at once.
 */
export function validateManifest(value: unknown): ManifestValidation {
  const errors: string[] = [];
  const obj = isRecord(value) ? value : (errors.push("manifest must be an object"), {} as Record<string, unknown>);

  requireString(obj, "id", errors, ID_RE, "reverse-DNS style (letters, digits, '-' and '.')");
  requireString(obj, "version", errors, SEMVER_RE, "a semver like 1.2.0");
  requireString(obj, "name", errors);
  requireString(obj, "main", errors);
  optionalString(obj, "description", errors);
  optionalString(obj, "publisher", errors);
  optionalString(obj, "ui", errors);

  const engines = obj.engines;
  if (!isRecord(engines) || typeof engines.sketchor !== "string" || engines.sketchor.length === 0) {
    errors.push('"engines.sketchor" is required and must be a semver range string');
  }

  if (obj.permissions !== undefined) {
    if (!Array.isArray(obj.permissions)) {
      errors.push('"permissions" must be an array');
    } else {
      for (const p of obj.permissions) {
        if (!isPermission(p)) errors.push(`unknown permission "${String(p)}" (valid: ${PERMISSIONS.join(", ")})`);
      }
    }
  }

  const contributes = obj.contributes;
  if (contributes !== undefined) {
    if (!isRecord(contributes)) {
      errors.push('"contributes" must be an object');
    } else if (Array.isArray(contributes.tools) && contributes.tools.length > 0) {
      errors.push('"contributes.tools" is reserved for a future version and cannot be used yet');
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, manifest: value as PluginManifest };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function requireString(
  obj: Record<string, unknown>,
  key: string,
  errors: string[],
  pattern?: RegExp,
  hint?: string,
): void {
  const v = obj[key];
  if (typeof v !== "string" || v.length === 0) {
    errors.push(`"${key}" is required and must be a non-empty string`);
    return;
  }
  if (pattern && !pattern.test(v)) errors.push(`"${key}" must be ${hint ?? `of the form ${pattern}`}`);
}

function optionalString(obj: Record<string, unknown>, key: string, errors: string[]): void {
  if (obj[key] !== undefined && typeof obj[key] !== "string") errors.push(`"${key}" must be a string when present`);
}
