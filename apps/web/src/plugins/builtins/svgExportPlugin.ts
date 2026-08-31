import { entityPoints, type Entity, type Point, type PluginModule } from "@sketchor/plugin-sdk";

/**
 * First-party dogfood: an SVG exporter built **over the public plugin API**. It
 * receives only the document read-model and returns SVG text; the host writes it
 * out through the same save path as the built-in DXF/SVG. A compact, standalone
 * serializer — the point is to prove an IO format can be expressed from the
 * read-model alone, without reaching into core.
 *
 * Contributes the exporter `svg` (declared in the plugin's manifest).
 */
const plugin: PluginModule = {
  activate(sketchor) {
    sketchor.io.registerExporter("svg", ({ document }) => toSvg(document.entities));
  },
};

const PAD = 10;

function toSvg(entities: readonly Entity[]): string {
  const bounds = boundsOf(entities);
  const w = Math.max(1, bounds.maxX - bounds.minX) + PAD * 2;
  const h = Math.max(1, bounds.maxY - bounds.minY) + PAD * 2;
  const ox = bounds.minX - PAD;
  const oy = bounds.minY - PAD;

  const body = entities.map((e) => svgFor(e)).filter(Boolean).join("\n    ");
  // Y-flip so the drawing's +Y-up world matches SVG's +Y-down, via a group transform.
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${num(ox)} ${num(oy)} ${num(w)} ${num(h)}" width="${num(w)}" height="${num(h)}">`,
    `  <g transform="translate(0 ${num(2 * oy + h)}) scale(1 -1)" fill="none" stroke="#000" stroke-width="0.25">`,
    `    ${body}`,
    `  </g>`,
    `</svg>`,
    ``,
  ].join("\n");
}

function svgFor(e: Entity): string {
  switch (e.type) {
    case "line":
      return `<line x1="${num(e.a.x)}" y1="${num(e.a.y)}" x2="${num(e.b.x)}" y2="${num(e.b.y)}" />`;
    case "circle":
      return `<circle cx="${num(e.center.x)}" cy="${num(e.center.y)}" r="${num(e.radius)}" />`;
    case "point":
      return `<circle cx="${num(e.p.x)}" cy="${num(e.p.y)}" r="0.5" fill="#000" />`;
    case "arc":
      return arcPath(e.center, e.radius, e.startAngle, e.endAngle, e.ccw);
    case "polyline": {
      const pts = e.points.map((p) => `${num(p.x)},${num(p.y)}`).join(" ");
      return e.closed
        ? `<polygon points="${pts}" />`
        : `<polyline points="${pts}" />`;
    }
  }
}

function arcPath(c: Point, r: number, start: number, end: number, ccw: boolean): string {
  const a = { x: c.x + r * Math.cos(start), y: c.y + r * Math.sin(start) };
  const b = { x: c.x + r * Math.cos(end), y: c.y + r * Math.sin(end) };
  let sweep = end - start;
  if (ccw && sweep < 0) sweep += 2 * Math.PI;
  if (!ccw && sweep > 0) sweep -= 2 * Math.PI;
  const large = Math.abs(sweep) > Math.PI ? 1 : 0;
  const sweepFlag = ccw ? 1 : 0; // SVG y-axis is flipped by the group transform, so ccw maps to sweep=1
  return `<path d="M ${num(a.x)} ${num(a.y)} A ${num(r)} ${num(r)} 0 ${large} ${sweepFlag} ${num(b.x)} ${num(b.y)}" />`;
}

function boundsOf(entities: readonly Entity[]): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const e of entities) {
    for (const p of entityPoints(e)) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
  }
  if (!Number.isFinite(minX)) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  return { minX, minY, maxX, maxY };
}

/** Trim float noise so the output is stable and small. */
function num(v: number): string {
  return (Math.round(v * 1000) / 1000).toString();
}

export default plugin;
