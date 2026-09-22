import type { Entity, EntityId } from "./entities";
import { layerOf } from "./entities";

/**
 * "Select every other one like this." AutoCAD's SELECTSIMILAR and its
 * Quick Select dialog, which is how anyone cleans up an imported drawing:
 * grab one stray dimension line and take all 400 of them in one go.
 *
 * Kept pure and separate from the UI because the same filter drives three
 * things — the Select similar command, the Select by panel, and (later) a
 * plugin asking the document for a subset.
 */

export interface SelectFilter {
  /** Entity types to accept; absent or empty means any type. */
  types?: Entity["type"][];
  /** Layer names to accept; absent or empty means any layer. */
  layers?: string[];
  /** Stroke colours to accept, with `null` standing for "the theme default" (no `color` set). */
  colors?: (string | null)[];
  /** When set, only entities whose construction (dashed) flag matches. */
  construction?: boolean;
  /** When set, only entities that have a hatch fill (true) or don't (false). */
  filled?: boolean;
}

/** The colour of an entity for filtering purposes: `null` when it inherits the theme default. */
export function colorOf(entity: Entity): string | null {
  return entity.color ?? null;
}

/** Whether `entity` passes every set criterion of `filter`. An empty filter matches everything. */
export function matchesFilter(entity: Entity, filter: SelectFilter): boolean {
  if (filter.types && filter.types.length > 0 && !filter.types.includes(entity.type)) return false;
  if (filter.layers && filter.layers.length > 0 && !filter.layers.includes(layerOf(entity))) return false;
  if (filter.colors && filter.colors.length > 0 && !filter.colors.includes(colorOf(entity))) return false;
  if (filter.construction !== undefined && !!entity.dashed !== filter.construction) return false;
  if (filter.filled !== undefined && !!entity.fill !== filter.filled) return false;
  return true;
}

/** Every entity id in `entities` passing `filter`. */
export function selectMatching(entities: Entity[], filter: SelectFilter): EntityId[] {
  return entities.filter((e) => matchesFilter(e, filter)).map((e) => e.id);
}

/**
 * The filter that describes what the sample entities have in common —
 * "similar" as AutoCAD means it: same type, same layer, same colour. Each
 * dimension lists every value present in the samples, so picking a red line
 * and a blue line selects red and blue lines, not lines of every colour.
 */
export function similarFilter(samples: Entity[]): SelectFilter {
  return {
    types: [...new Set(samples.map((e) => e.type))],
    layers: [...new Set(samples.map(layerOf))],
    colors: [...new Set(samples.map(colorOf))],
  };
}

/** Every entity similar to the samples, the samples included. */
export function selectSimilar(entities: Entity[], samples: Entity[]): EntityId[] {
  if (samples.length === 0) return [];
  return selectMatching(entities, similarFilter(samples));
}

/** A one-line summary of a filter, for a status message ("3 lines, 2 layers"). */
export function describeFilter(filter: SelectFilter): string {
  const parts: string[] = [];
  if (filter.types && filter.types.length > 0) parts.push(filter.types.join(", "));
  if (filter.layers && filter.layers.length > 0) parts.push(`layer ${filter.layers.join(", ")}`);
  if (filter.colors && filter.colors.length > 0) parts.push(`colour ${filter.colors.map((c) => c ?? "default").join(", ")}`);
  if (filter.construction !== undefined) parts.push(filter.construction ? "construction" : "not construction");
  if (filter.filled !== undefined) parts.push(filter.filled ? "filled" : "not filled");
  return parts.length > 0 ? parts.join(" · ") : "anything";
}
