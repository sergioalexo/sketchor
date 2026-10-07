import type { Command, Entity, Point, SplineEntity } from "@sketchor/core";
import { addSplinePoint, dist, newEntityId, rebuildSpline, removeSplinePoint, splineToControlPoints, splineToPolyline } from "@sketchor/core";
import type { Pick, Tool, ToolContext } from "./tool";

/**
 * SPLINEDIT (C-07), the canvas half: with a spline selected (or after
 * clicking one), a click on the curve adds a fit point / control vertex
 * there, Shift-click removes the nearest one. The command line drives the
 * rest on the selected splines: `rebuild 8`, `cv` (convert to control
 * points), `polyline 0.1`. The maths is `splineEdit.ts`; this only picks
 * and commits one `update-entity` per action.
 */

const update = (e: Entity): Command => ({ type: "update-entity", entity: e });

function selectedSplines(ctx: ToolContext): SplineEntity[] {
  const out: SplineEntity[] = [];
  for (const id of ctx.selection()) {
    const e = ctx.doc.get(id);
    if (e?.type === "spline") out.push(e);
  }
  return out;
}

/** Index of the fit point (or control vertex) nearest `p`. */
function nearestPointIndex(e: SplineEntity, p: Point): number {
  const pts = e.fitPoints ?? e.controlPoints;
  let best = 0;
  for (let i = 1; i < pts.length; i++) if (dist(pts[i], p) < dist(pts[best], p)) best = i;
  return best;
}

export class SplineEditTool implements Tool {
  readonly id = "splinedit" as const;
  private message: string | null = null;

  prompt(ctx: ToolContext): string {
    if (this.message) return this.message;
    const splines = selectedSplines(ctx);
    if (splines.length === 0) return "Spline edit: click a spline (or select splines and type rebuild 8, cv, polyline 0.1)";
    const noun = splines[0].fitPoints ? "fit point" : "control vertex";
    return `Spline edit: click the curve to add a ${noun}, Shift-click to remove the nearest - or type rebuild N, cv, polyline [tolerance]`;
  }
  busy(): boolean {
    return false;
  }
  anchor(): Point | null {
    return null;
  }
  cancel(): void {
    this.message = null;
  }

  pick(ctx: ToolContext, p: Pick): void {
    this.message = null;
    const splines = selectedSplines(ctx);
    const target = splines.length === 1 ? splines[0] : null;
    // Clicking another spline retargets; clicking empty space with one selected edits it.
    const hit = ctx.hitTest(p.world).map((id) => ctx.doc.get(id)).find((e): e is SplineEntity => e?.type === "spline");
    if (hit && (!target || hit.id !== target.id)) {
      ctx.setSelection([hit.id]);
      return;
    }
    if (!target) {
      this.message = "Click a spline to edit it";
      return;
    }
    const next = p.shiftKey ? removeSplinePoint(target, nearestPointIndex(target, p.world)) : addSplinePoint(target, p.world);
    if (!next) {
      this.message = p.shiftKey ? "A spline needs at least two points" : "Click on the curve, between its ends";
      return;
    }
    ctx.execute(update(next));
  }

  typed(ctx: ToolContext, text: string): boolean {
    const [word, arg] = text.trim().toLowerCase().split(/\s+/);
    const splines = selectedSplines(ctx);
    if (splines.length === 0) {
      this.message = "Select a spline first";
      return word === "rebuild" || word === "cv" || word === "polyline";
    }
    const commands: Command[] = [];
    if (word === "rebuild") {
      const n = Number(arg);
      if (!Number.isInteger(n) || n < 2 || n > 1000) return false;
      for (const s of splines) {
        const r = rebuildSpline(s, n);
        if (r) commands.push(update(r));
      }
    } else if (word === "cv") {
      for (const s of splines) {
        const r = splineToControlPoints(s);
        if (r) commands.push(update(r));
      }
    } else if (word === "polyline") {
      const tol = arg === undefined ? 0.1 : Number(arg);
      if (!(tol > 0)) return false;
      for (const s of splines) {
        const pl = splineToPolyline(s, tol);
        if (pl) commands.push({ type: "delete-entities", ids: [s.id] }, { type: "add-entity", entity: { ...pl, id: newEntityId() } });
      }
    } else {
      return false;
    }
    if (commands.length > 0) ctx.commit(commands);
    else this.message = "Nothing to change";
    return true;
  }

  preview(): Entity[] {
    return [];
  }
}
