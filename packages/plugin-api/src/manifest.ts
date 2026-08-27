/**
 * The static, inspectable description of a plugin — a folder with a
 * `sketchor.plugin.json` matching this shape plus one ESM bundle. Nothing
 * here is executed to read it, which is what lets the (future) marketplace,
 * permission prompt, and lazy-activation logic all work from the manifest
 * alone.
 */
export interface PluginManifest {
  /** Reverse-DNS style, e.g. "com.sergioalexo.truck-nesting". */
  id: string;
  name: string;
  version: string;
  engines: { sketchor: string };
  /** Entry file, relative to the manifest. */
  main: string;
  /** What this plugin asks to touch — shown at install once the marketplace exists (v1.0); documentation-only until then. */
  permissions?: string[];
  /** Events that should load and run this plugin's `activate()`. */
  activation?: string[];
  contributes?: {
    panels?: { id: string; title: string; dock?: "left" | "right" }[];
    tools?: { id: string; title: string; key?: string }[];
    commands?: { id: string; title: string }[];
  };
}
