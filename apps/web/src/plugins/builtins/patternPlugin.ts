import {
  add,
  entityPoints,
  newEntityId,
  rotatePoint,
  transformed,
  translated,
  type Command,
  type Entity,
  type GeneratorContext,
  type PatternSpec,
  type Point,
  type PluginModule,
} from "@sketchor/plugin-sdk";

/**
 * First-party dogfood: the built-in Pattern (array) tool, reimplemented as a
 * plugin **over the public plugin API**. It sees only the read-model and the
 * selection, and returns `add-entity` commands the host applies as one undo
 * step — proving the API is expressive enough for a real generator. Its output
 * matches the core `patternCommands` geometry entity-for-entity; that
 * equivalence is the Phase 2 acceptance check (`sketchorPlugins.testPattern`).
 *
 * Contributes the generator `pattern.array` (declared in the plugin's manifest).
 */
const plugin: PluginModule = {
  activate(sketchor) {
    sketchor.generators.register("pattern.array", (ctx) => patternCommands(ctx));
  },
};

/** The layout math, mirroring `packages/core/src/pattern.ts` but over read-model entities. */
function patternCommands(ctx: GeneratorContext): Command[] {
  const byId = new Map(ctx.document.entities.map((e) => [e.id, e] as const));
  const sources = ctx.selection.map((id) => byId.get(id)).filter((e): e is Entity => !!e);
  if (sources.length === 0) return [];

  // Run from the palette without parameters → a sensible default derived from
  // the selection's own size (Phase 3 gives generators a real parameter panel).
  const spec = (ctx.input as PatternSpec | undefined) ?? defaultSpec(sources);

  const copies: Entity[] = [];
  const stamp = (place: (e: Entity) => Entity) => {
    for (const source of sources) copies.push({ ...place(source), id: newEntityId(), name: undefined });
  };

  if (spec.kind === "rectangular") {
    const cols = Math.max(1, Math.floor(spec.columns));
    const rows = Math.max(1, Math.floor(spec.rows));
    for (let c = 0; c < cols; c++) {
      for (let r = 0; r < rows; r++) {
        if (c === 0 && r === 0) continue;
        stamp((e) => translated(e, c * spec.columnSpacing, r * spec.rowSpacing));
      }
    }
  } else {
    const count = Math.max(1, Math.floor(spec.count));
    const full = Math.abs(Math.abs(spec.totalAngle) - 2 * Math.PI) < 1e-9;
    const step = spec.totalAngle / (full ? count : Math.max(1, count - 1));

    for (let i = 1; i < count; i++) {
      const angle = step * i;
      stamp((e) => {
        if (spec.rotateItems) return transformed(e, spec.center, 0, 0, angle, 1);
        const anchor = anchorOf(e);
        const moved = rotatePoint(anchor, spec.center, angle);
        return translated(e, moved.x - anchor.x, moved.y - anchor.y);
      });
    }
  }

  return copies.map((entity) => add(entity));
}

/** A default 1×3 grid stepped just past the selection's own width, for a param-free palette run. */
function defaultSpec(sources: Entity[]): PatternSpec {
  let minX = Infinity;
  let maxX = -Infinity;
  for (const e of sources) {
    for (const p of entityPoints(e)) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
    }
  }
  const width = Number.isFinite(minX) ? maxX - minX : 0;
  const step = width > 0 ? width * 1.2 : 50;
  return { kind: "rectangular", columns: 3, rows: 1, columnSpacing: step, rowSpacing: 0 };
}

/** An entity's own anchor — what travels along the arc when copies keep orientation (matches core `centerOf`). */
function anchorOf(entity: Entity): Point {
  switch (entity.type) {
    case "circle":
    case "arc":
      return entity.center;
    case "point":
      return entity.p;
    case "line":
      return { x: (entity.a.x + entity.b.x) / 2, y: (entity.a.y + entity.b.y) / 2 };
    case "polyline":
      return centroidOfPoints(entity.points);
    case "text":
      return entity.at;
    case "image":
      return entity.insert;
  }
}

function centroidOfPoints(points: Point[]): Point {
  let sx = 0;
  let sy = 0;
  for (const p of points) {
    sx += p.x;
    sy += p.y;
  }
  const n = Math.max(1, points.length);
  return { x: sx / n, y: sy / n };
}

export default plugin;
