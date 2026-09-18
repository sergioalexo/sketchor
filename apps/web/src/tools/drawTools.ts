import type { Entity, Point } from "@sketchor/core";
import {
  arcFrom3Points,
  arcFromCenterStartEnd,
  arcPointAt,
  bulgeFrom3Points,
  bulgeToArc,
  dist,
  newEntityId,
  nextEntityName,
  tangentArc,
} from "@sketchor/core";
import { layerProp, type Pick, type Tool, type ToolContext } from "./tool";

/**
 * The drawing tools, one state machine each. Behaviour is unchanged from
 * the pre-framework Viewport switch for line/polyline/rectangle/circle/
 * point (that's the regression test); arc is new (roadmap T-01) and the
 * polyline gained arc legs (T-03).
 */

const PREVIEW = "preview";

/* --------------------------------- line ---------------------------------- */

/** Chained lines: each click ends one segment and starts the next. */
export class LineTool implements Tool {
  readonly id = "line" as const;
  private start: Point | null = null;

  prompt(): string {
    return this.start ? "Specify next point (Esc to finish)" : "Specify first point";
  }
  busy(): boolean {
    return this.start !== null;
  }
  anchor(): Point | null {
    return this.start;
  }
  cancel(): void {
    this.start = null;
  }
  pick(ctx: ToolContext, p: Pick): void {
    if (this.start && dist(this.start, p.point) > 0) {
      ctx.execute({
        type: "add-entity",
        entity: {
          id: newEntityId(),
          type: "line",
          name: nextEntityName(ctx.doc, "line"),
          ...layerProp(ctx.activeLayer()),
          a: this.start,
          b: p.point,
        },
      });
    }
    this.start = p.point;
  }
  preview(_ctx: ToolContext, cursor: Point | null): Entity[] {
    if (!this.start || !cursor) return [];
    return [{ id: PREVIEW, type: "line", a: this.start, b: cursor }];
  }
}

/* -------------------------------- polyline -------------------------------- */

/**
 * Polyline: click each vertex; Enter or double-click finishes, C closes,
 * Backspace drops the last vertex. `A` switches the next leg to an arc
 * (AutoCAD PLINE's Arc option): the leg is then placed with two clicks —
 * a point the arc passes through, then its end — and stored as a bulge;
 * `L` goes back to straight legs. A tangent arc (`T`) continues smoothly
 * from the previous leg with one click.
 */
export class PolylineTool implements Tool {
  readonly id = "polyline" as const;
  private points: Point[] = [];
  private bulges: number[] = [];
  private mode: "line" | "arc" | "tangent" = "line";
  /** In 3-point arc mode, the "through" point once picked. */
  private via: Point | null = null;

  prompt(): string {
    if (this.points.length === 0) return "Specify first vertex";
    const finish = "Enter finishes, C closes, Backspace undoes a vertex";
    if (this.mode === "arc") return this.via ? `Arc leg: specify the end point (${finish})` : `Arc leg: specify a point the arc passes through — L for straight legs (${finish})`;
    if (this.mode === "tangent") return `Tangent arc leg: specify the end point — L for straight legs (${finish})`;
    return `Specify next vertex — A for an arc leg, T for a tangent arc (${finish})`;
  }
  busy(): boolean {
    return this.points.length > 0;
  }
  anchor(): Point | null {
    return this.points[this.points.length - 1] ?? null;
  }
  cancel(): void {
    this.points = [];
    this.bulges = [];
    this.via = null;
    this.mode = "line";
  }

  pick(ctx: ToolContext, p: Pick): void {
    const last = this.anchor();
    if (!last) {
      this.points = [p.point];
      this.bulges = [];
      return;
    }
    if (dist(last, p.point) === 0 && this.mode !== "arc") return; // repeat click on the vertex just placed (double-click finishes)
    if (this.mode === "arc") {
      if (!this.via) {
        if (dist(last, p.point) > 0) this.via = p.point;
        return;
      }
      this.points.push(p.point);
      this.bulges.push(bulgeFrom3Points(last, this.via, p.point));
      this.via = null;
      return;
    }
    if (this.mode === "tangent") {
      const t = this.outgoingTangent();
      const arc = t ? tangentArc(last, t, p.point) : null;
      this.points.push(p.point);
      this.bulges.push(arc ? this.bulgeOf(last, p.point, arc) : 0);
      return;
    }
    this.points.push(p.point);
    this.bulges.push(0);
  }

  doubleClick(ctx: ToolContext): boolean {
    this.finish(ctx, false);
    return true;
  }

  key(ctx: ToolContext, e: KeyboardEvent): boolean {
    if (this.points.length === 0) return false;
    const k = e.key.toLowerCase();
    if (e.key === "Enter") {
      this.finish(ctx, false);
      return true;
    }
    if (k === "c" && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
      this.finish(ctx, true);
      return true;
    }
    if (e.key === "Backspace") {
      if (this.via) this.via = null;
      else {
        this.points.pop();
        this.bulges.pop();
      }
      if (this.points.length === 0) this.cancel();
      ctx.redraw();
      return true;
    }
    if (k === "a" && !e.ctrlKey && !e.metaKey) {
      this.mode = "arc";
      this.via = null;
      ctx.redraw();
      return true;
    }
    if (k === "t" && !e.ctrlKey && !e.metaKey) {
      this.mode = "tangent";
      this.via = null;
      ctx.redraw();
      return true;
    }
    if (k === "l" && !e.ctrlKey && !e.metaKey) {
      this.mode = "line";
      this.via = null;
      ctx.redraw();
      return true;
    }
    return false;
  }

  preview(_ctx: ToolContext, cursor: Point | null): Entity[] {
    if (this.points.length === 0) return [];
    const points = [...this.points];
    const bulges = [...this.bulges];
    const last = points[points.length - 1];
    if (cursor && dist(last, cursor) > 0) {
      if (this.mode === "arc" && this.via) {
        points.push(cursor);
        bulges.push(bulgeFrom3Points(last, this.via, cursor));
      } else if (this.mode === "tangent") {
        const t = this.outgoingTangent();
        const arc = t ? tangentArc(last, t, cursor) : null;
        points.push(cursor);
        bulges.push(arc ? this.bulgeOf(last, cursor, arc) : 0);
      } else {
        points.push(cursor);
        bulges.push(0);
      }
    }
    if (points.length < 2) return [];
    const hasArc = bulges.some((b) => b !== 0);
    return [{ id: PREVIEW, type: "polyline", points, closed: false, ...(hasArc ? { bulges } : {}) }];
  }

  /** Commits the polyline (needs 2+ vertices) and resets. */
  private finish(ctx: ToolContext, closed: boolean): void {
    if (this.points.length >= 2) {
      const hasArc = this.bulges.some((b) => b !== 0);
      const bulges = closed ? [...this.bulges, 0] : this.bulges;
      ctx.execute({
        type: "add-entity",
        entity: {
          id: newEntityId(),
          type: "polyline",
          name: nextEntityName(ctx.doc, "polyline"),
          ...layerProp(ctx.activeLayer()),
          points: this.points,
          closed: closed && this.points.length >= 3,
          ...(hasArc ? { bulges } : {}),
        },
      });
    }
    this.cancel();
    ctx.redraw();
  }

  /** Direction the previous leg arrives at the last vertex with (unit), for a tangent continuation. */
  private outgoingTangent(): Point | null {
    const n = this.points.length;
    if (n < 2) return null;
    const a = this.points[n - 2];
    const b = this.points[n - 1];
    const bulge = this.bulges[n - 2] ?? 0;
    const arc = bulgeToArc(a, b, bulge);
    if (arc) {
      // Tangent at the arc's end: perpendicular to the radius, in the sweep direction.
      const end = arcPointAt(arc.center, arc.radius, arc.endAngle);
      const rx = end.x - arc.center.x;
      const ry = end.y - arc.center.y;
      return arc.ccw ? { x: -ry, y: rx } : { x: ry, y: -rx };
    }
    return { x: b.x - a.x, y: b.y - a.y };
  }

  private bulgeOf(a: Point, b: Point, arc: { center: Point; radius: number; ccw: boolean }): number {
    // Via = the arc's midpoint, which bulgeFrom3Points turns back into the same arc.
    const sa = Math.atan2(a.y - arc.center.y, a.x - arc.center.x);
    const ea = Math.atan2(b.y - arc.center.y, b.x - arc.center.x);
    let sweep = arc.ccw ? ea - sa : sa - ea;
    sweep = ((sweep % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    const midAngle = arc.ccw ? sa + sweep / 2 : sa - sweep / 2;
    return bulgeFrom3Points(a, arcPointAt(arc.center, arc.radius, midAngle), b);
  }
}

/* -------------------------------- rectangle ------------------------------- */

/** The four corners of the axis-aligned rectangle between two opposite corners, clockwise from the min corner. */
export function rectFromCorners(a: Point, b: Point): Point[] {
  const x0 = Math.min(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  return [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 },
  ];
}

export class RectangleTool implements Tool {
  readonly id = "rectangle" as const;
  private corner: Point | null = null;

  prompt(): string {
    return this.corner ? "Specify the opposite corner" : "Specify first corner";
  }
  busy(): boolean {
    return this.corner !== null;
  }
  anchor(): Point | null {
    return this.corner;
  }
  cancel(): void {
    this.corner = null;
  }
  pick(ctx: ToolContext, p: Pick): void {
    if (!this.corner) {
      this.corner = p.point;
      return;
    }
    if (dist(this.corner, p.point) > 0) {
      ctx.execute({
        type: "add-entity",
        entity: {
          id: newEntityId(),
          type: "polyline",
          name: nextEntityName(ctx.doc, "polyline"),
          ...layerProp(ctx.activeLayer()),
          points: rectFromCorners(this.corner, p.point),
          closed: true,
        },
      });
    }
    this.corner = null;
  }
  preview(_ctx: ToolContext, cursor: Point | null): Entity[] {
    if (!this.corner || !cursor) return [];
    return [{ id: PREVIEW, type: "polyline", points: rectFromCorners(this.corner, cursor), closed: true }];
  }
}

/* --------------------------------- circle --------------------------------- */

export class CircleTool implements Tool {
  readonly id = "circle" as const;
  private center: Point | null = null;

  prompt(): string {
    return this.center ? "Specify a point on the circle, or type the radius" : "Specify center";
  }
  busy(): boolean {
    return this.center !== null;
  }
  anchor(): Point | null {
    return this.center;
  }
  cancel(): void {
    this.center = null;
  }
  pick(ctx: ToolContext, p: Pick): void {
    if (!this.center) {
      this.center = p.point;
      return;
    }
    const radius = dist(this.center, p.point);
    if (radius > 0) {
      ctx.execute({
        type: "add-entity",
        entity: {
          id: newEntityId(),
          type: "circle",
          name: nextEntityName(ctx.doc, "circle"),
          ...layerProp(ctx.activeLayer()),
          center: this.center,
          radius,
        },
      });
    }
    this.center = null;
  }
  preview(_ctx: ToolContext, cursor: Point | null): Entity[] {
    if (!this.center || !cursor) return [];
    return [{ id: PREVIEW, type: "circle", center: this.center, radius: dist(this.center, cursor) }];
  }
}

/* ---------------------------------- point --------------------------------- */

export class PointTool implements Tool {
  readonly id = "point" as const;
  prompt(): string {
    return "Specify a point";
  }
  busy(): boolean {
    return false;
  }
  anchor(): Point | null {
    return null;
  }
  cancel(): void {}
  pick(ctx: ToolContext, p: Pick): void {
    ctx.execute({
      type: "add-entity",
      entity: {
        id: newEntityId(),
        type: "point",
        name: nextEntityName(ctx.doc, "point"),
        ...layerProp(ctx.activeLayer()),
        p: p.point,
      },
    });
  }
  preview(): Entity[] {
    return [];
  }
}

/* ----------------------------------- arc ---------------------------------- */

export type ArcMode = "3-point" | "center" | "tangent";

/**
 * Arc tool (T-01). Modes, cycled with Tab while the tool is active (a
 * letter would collide with the tool shortcuts and a digit with typed
 * coordinates):
 *  - 3-point (default): start, end, then a point the arc passes through — Onshape's arc.
 *  - center: center, start, then the end direction; counterclockwise, Shift-click for clockwise.
 *  - tangent: continues from the end of the nearest line/arc to the click, then one click for the end point.
 */
export class ArcTool implements Tool {
  readonly id = "arc" as const;
  mode: ArcMode = "3-point";
  private picks: Point[] = [];
  /** Tangent mode: direction at the start. */
  private tangent: Point | null = null;

  prompt(): string {
    const n = this.picks.length;
    const modes = "(Tab: three-point / center / tangent)";
    if (this.mode === "center") {
      return n === 0 ? `Center arc: specify center ${modes}` : n === 1 ? "Specify start point" : "Specify end point (Shift for clockwise)";
    }
    if (this.mode === "tangent") {
      return n === 0 ? `Tangent arc: click near the end of a line or arc ${modes}` : "Specify end point";
    }
    return n === 0 ? `Three-point arc: specify start point ${modes}` : n === 1 ? "Specify end point" : "Specify a point on the arc";
  }
  busy(): boolean {
    return this.picks.length > 0;
  }
  anchor(): Point | null {
    // Tracking and relative input measure from the pick that makes sense
    // for the next one: the center for both picks of a center arc (a typed
    // length there is the radius); the start for a tangent arc's end. The
    // three-point arc's last pick is a point *on* the arc — constraining it
    // to rays from the end point would make it collinear with the chord —
    // so that pick tracks from nothing.
    if (this.mode === "3-point") return this.picks.length === 1 ? this.picks[0] : null;
    return this.picks[0] ?? null;
  }
  cancel(): void {
    this.picks = [];
    this.tangent = null;
  }

  key(ctx: ToolContext, e: KeyboardEvent): boolean {
    if (e.key !== "Tab" || e.ctrlKey || e.metaKey || e.altKey) return false;
    const order: ArcMode[] = ["3-point", "center", "tangent"];
    const i = order.indexOf(this.mode);
    this.mode = order[(i + (e.shiftKey ? order.length - 1 : 1)) % order.length];
    this.cancel();
    ctx.redraw();
    return true;
  }

  pick(ctx: ToolContext, p: Pick): void {
    if (this.mode === "tangent" && this.picks.length === 0) {
      const t = nearestOpenEnd(ctx, p.world);
      if (!t) return; // nothing to continue from; keep waiting
      this.picks = [t.point];
      this.tangent = t.tangent;
      return;
    }
    const last = this.anchor();
    if (last && dist(last, p.point) === 0) return;
    this.picks.push(p.point);
    const arc = this.resolve(this.picks, p.shiftKey);
    const needed = this.mode === "tangent" ? 2 : 3;
    if (this.picks.length < needed) return;
    if (arc) {
      ctx.execute({
        type: "add-entity",
        entity: {
          id: newEntityId(),
          type: "arc",
          name: nextEntityName(ctx.doc, "arc"),
          ...layerProp(ctx.activeLayer()),
          ...arc,
        },
      });
      this.cancel();
    } else {
      // Degenerate (collinear / zero radius): drop the last pick and wait for a better one.
      this.picks.pop();
    }
  }

  preview(_ctx: ToolContext, cursor: Point | null): Entity[] {
    if (this.picks.length === 0 || !cursor) return [];
    const picks = [...this.picks, cursor];
    const arc = this.resolve(picks, false);
    if (arc) return [{ id: PREVIEW, type: "arc", ...arc }];
    // Not enough picks for an arc yet: show the chord / radius as a line.
    if (this.mode === "center" && picks.length === 2) return [{ id: PREVIEW, type: "line", a: picks[0], b: cursor }];
    if (this.mode === "3-point" && picks.length === 2) return [{ id: PREVIEW, type: "line", a: picks[0], b: cursor }];
    return [];
  }

  private resolve(picks: Point[], clockwise: boolean) {
    if (this.mode === "tangent") {
      return picks.length >= 2 && this.tangent ? tangentArc(picks[0], this.tangent, picks[1]) : null;
    }
    if (picks.length < 3) return null;
    if (this.mode === "center") return arcFromCenterStartEnd(picks[0], picks[1], picks[2], !clockwise);
    // 3-point: start, end, via — the via pick is the third click.
    return arcFrom3Points(picks[0], picks[2], picks[1]);
  }
}

/**
 * The free end of a line or arc nearest to `at`, with the outgoing tangent
 * direction there — what a tangent arc continues from.
 */
function nearestOpenEnd(ctx: ToolContext, at: Point): { point: Point; tangent: Point } | null {
  let best: { point: Point; tangent: Point; d: number } | null = null;
  const consider = (point: Point, tangent: Point) => {
    const d = dist(point, at);
    if (!best || d < best.d) best = { point, tangent, d };
  };
  for (const e of ctx.doc.all()) {
    if (e.type === "line") {
      consider(e.b, { x: e.b.x - e.a.x, y: e.b.y - e.a.y });
      consider(e.a, { x: e.a.x - e.b.x, y: e.a.y - e.b.y });
    } else if (e.type === "arc") {
      for (const [angle, atEnd] of [
        [e.endAngle, true],
        [e.startAngle, false],
      ] as const) {
        const p = arcPointAt(e.center, e.radius, angle);
        const rx = p.x - e.center.x;
        const ry = p.y - e.center.y;
        // Leaving the arc at its end continues the sweep; leaving at its start reverses it.
        const forward = e.ccw === atEnd;
        consider(p, forward ? { x: -ry, y: rx } : { x: ry, y: -rx });
      }
    }
  }
  return best;
}
