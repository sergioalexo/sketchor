import type { Entity, EntityId, HatchEntity } from "../entities";
import type { SketchDocument } from "../document";
import { boundaryFromObjects } from "./boundary";

/**
 * Hatch associativity (H-05). The bus snapshots `associationState` before a
 * command and calls `reassociate` after it (and after the solver): a hatch whose
 * source entities changed gets its loops recomputed in the same undo entry; a
 * hatch whose boundary can no longer be formed keeps its last loops and is
 * flagged `boundaryLost`; a hatch edited directly (loops changed, sources not)
 * drops its association, as AutoCAD does.
 */

export interface AssociationState {
  /** hatch id -> signature of its source entities. */
  sources: Map<EntityId, string>;
  /** hatch id -> signature of its own loops. */
  loops: Map<EntityId, string>;
}

function sig(e: Entity | undefined): string {
  return e ? JSON.stringify(e) : "-";
}

function isAssoc(e: Entity): e is HatchEntity & { sources: EntityId[] } {
  return e.type === "hatch" && !!e.associative && !!e.sources && e.sources.length > 0;
}

/** Null (no work) for documents without associative hatches. */
export function associationState(doc: SketchDocument): AssociationState | null {
  let st: AssociationState | null = null;
  for (const e of doc.all()) {
    if (!isAssoc(e)) continue;
    st ??= { sources: new Map(), loops: new Map() };
    st.sources.set(e.id, e.sources.map((id) => sig(doc.get(id))).join("|"));
    st.loops.set(e.id, JSON.stringify(e.loops));
  }
  return st;
}

/** Updated hatch entities to apply after a command changed the document. */
export function reassociate(doc: SketchDocument, before: AssociationState | null): HatchEntity[] {
  if (!before) return [];
  const out: HatchEntity[] = [];
  for (const [id, was] of before.sources) {
    const h = doc.get(id);
    if (!h || !isAssoc(h)) continue;
    const now = h.sources.map((sid) => sig(doc.get(sid))).join("|");
    if (now !== was) {
      const srcs = h.sources.map((sid) => doc.get(sid));
      const missing = srcs.some((s) => !s);
      const res = missing ? null : boundaryFromObjects(srcs as Entity[]);
      if (res && res.loops.length > 0) {
        const next: HatchEntity = { ...h, loops: res.loops };
        delete next.boundaryLost;
        out.push(next);
      } else if (!h.boundaryLost) {
        out.push({ ...h, boundaryLost: true });
      }
    } else if (JSON.stringify(h.loops) !== before.loops.get(id)) {
      // Edited directly (grips, move of the hatch alone): no longer follows its boundary.
      const next: HatchEntity = { ...h, associative: false };
      delete next.boundaryLost;
      out.push(next);
    }
  }
  return out;
}
