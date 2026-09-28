import type { SketchDocument } from "./document";
import { DEFAULT_LAYER, layerOf } from "./entities";
import type { LayerRecord } from "./tables";

/**
 * Layers as the UI sees them, projected from the document (Z-02): the
 * `layers` table holds each layer's persisted state (visible, locked), and a
 * layer that entities name but nobody ever configured simply has no record yet
 * and reads as visible and unlocked — which is how every imported DXF/SVG
 * starts. So the list is never out of step with the geometry: a layer appears
 * as soon as an entity uses it, and disappears when neither a record nor an
 * entity keeps it.
 */

export interface LayerInfo {
  name: string;
  visible: boolean;
  locked?: boolean;
}

/** The default layer first, then recorded layers in table order, then layers only entities mention (in first-use order). */
export function layerList(doc: SketchDocument): LayerInfo[] {
  const names = new Set<string>([DEFAULT_LAYER]);
  for (const r of doc.records("layers")) names.add(r.name);
  for (const e of doc.all()) names.add(layerOf(e));
  return [...names].map((name) => {
    const r = doc.getRecord("layers", name) as LayerRecord | undefined;
    return { name, visible: r?.visible !== false, ...(r?.locked ? { locked: true } : {}) };
  });
}

/** The record for `name` with `patch` applied — a fresh visible, unlocked one if the layer has none yet. */
export function layerRecordWith(doc: SketchDocument, name: string, patch: Partial<Omit<LayerRecord, "name">>): LayerRecord {
  const existing = doc.getRecord("layers", name) as LayerRecord | undefined;
  return { ...(existing ?? { visible: true }), ...patch, name };
}
