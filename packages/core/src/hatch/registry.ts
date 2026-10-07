import type { PatternDef } from "./pat";

/**
 * Where a hatch's pattern name is looked up. The built-in library (H-03)
 * registers itself on import; imported `.pat` files and plugins register more
 * (H-06). Names compare case-insensitively, like AutoCAD's.
 */

const patterns = new Map<string, PatternDef>();

export function registerPattern(p: PatternDef): void {
  patterns.set(p.name.toUpperCase(), p);
}

export function unregisterPattern(name: string): void {
  patterns.delete(name.toUpperCase());
}

export function lookupPattern(name: string): PatternDef | undefined {
  return patterns.get(name.toUpperCase());
}

export function registeredPatterns(): PatternDef[] {
  return [...patterns.values()];
}
