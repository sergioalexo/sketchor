import { useEffect, useMemo, useState } from "react";
import type { Command, Entity, PolylineEntity } from "@sketchor/core";
import { arcPointAt, arcSweep, bulgeToArc, dist, findClosedRegions, layerOf, polylineLength } from "@sketchor/core";
import { bus, doc, useApp } from "../state/store";
import { parseLength } from "../tools/typedInput";
import { factorFromMm, formatArea, formatLength, type DisplayUnit } from "../units";

/**
 * Properties panel (roadmap T-28): what's selected, as numbers you can
 * edit. A common section (layer, colour, construction) applies to the
 * whole selection; with exactly one entity selected its geometry is laid
 * out field by field — coordinates, radius, angles, text — plus the
 * read-only figures AutoCAD's Quick Properties shows (length, area,
 * circumference). Every edit is one `update-entity` per entity, so it
 * undoes like anything else.
 *
 * Lengths are shown and typed in the tab's display unit; angles in
 * degrees. A field commits on Enter or blur and reverts on Escape.
 */
export function PropertiesPanel({ onClose }: { onClose: () => void }) {
  const selection = useApp((s) => s.selection);
  const revision = useApp((s) => s.revision);
  const layers = useApp((s) => s.layers);
  const unit = useApp((s) => s.displayUnit);
  const entities = useMemo(
    () => selection.map((id) => doc.get(id)).filter((e): e is Entity => !!e),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selection, revision],
  );

  const applyAll = (patch: (e: Entity) => Entity) => {
    const commands: Command[] = entities.map((e) => ({ type: "update-entity", entity: patch(e) }));
    if (commands.length === 1) bus.execute(commands[0]);
    else if (commands.length > 1) bus.execute({ type: "batch", commands });
    useApp.getState().syncLayersFromDoc?.();
  };

  const common = (key: "layer" | "color" | "dashed") => {
    const values = new Set(entities.map((e) => (key === "layer" ? layerOf(e) : String(e[key] ?? ""))));
    return values.size === 1 ? [...values][0] : null;
  };

  return (
    <aside className="propspanel" data-testid="properties-panel">
      <div className="layerpanel-header">
        <span>Properties</span>
        <button className="btn ghost sm" onClick={onClose} title="Close">
          ✕
        </button>
      </div>
      {entities.length === 0 ? (
        <div className="propspanel-empty">Select something to see and edit its properties.</div>
      ) : (
        <div className="propspanel-body">
          <div className="propspanel-summary" data-testid="properties-summary">
            {summarize(entities)}
          </div>
          <Section title="Common">
            <Row label="Layer">
              <select
                className="propspanel-input"
                value={common("layer") ?? ""}
                data-testid="prop-layer"
                onChange={(e) => {
                  const layer = e.target.value;
                  applyAll((en) => (layer === "0" ? stripKey(en, "layer") : { ...en, layer }));
                }}
              >
                {common("layer") === null && <option value="">(varies)</option>}
                {layers.map((l) => (
                  <option key={l.name} value={l.name}>
                    {l.name}
                  </option>
                ))}
              </select>
            </Row>
            <Row label="Colour">
              <TextField
                value={common("color") ?? ""}
                placeholder={common("color") === null ? "(varies)" : "default"}
                testId="prop-color"
                onCommit={(v) => applyAll((en) => (v.trim() ? { ...en, color: v.trim() } : stripKey(en, "color")))}
              />
              <input
                type="color"
                className="propspanel-swatch"
                value={cssToHex(common("color") ?? "") ?? "#dfe1e5"}
                onChange={(e) => applyAll((en) => ({ ...en, color: e.target.value }))}
                title="Pick a colour"
              />
            </Row>
            <Row label="Construction">
              <input
                type="checkbox"
                data-testid="prop-dashed"
                checked={common("dashed") === "true"}
                ref={(el) => {
                  if (el) el.indeterminate = common("dashed") === null;
                }}
                onChange={(e) => applyAll((en) => (e.target.checked ? { ...en, dashed: true } : stripKey(en, "dashed")))}
              />
            </Row>
          </Section>
          {entities.length === 1 && <Geometry entity={entities[0]} unit={unit} />}
        </div>
      )}
    </aside>
  );
}

function stripKey(e: Entity, key: "layer" | "color" | "dashed"): Entity {
  const copy = { ...e } as Record<string, unknown>;
  delete copy[key];
  return copy as unknown as Entity;
}

function summarize(entities: Entity[]): string {
  if (entities.length === 1) return `1 ${entities[0].type}${entities[0].name ? ` · ${entities[0].name}` : ""}`;
  const counts = new Map<string, number>();
  for (const e of entities) counts.set(e.type, (counts.get(e.type) ?? 0) + 1);
  return `${entities.length} selected: ${[...counts].map(([t, n]) => `${n} ${t}${n > 1 ? "s" : ""}`).join(", ")}`;
}

function cssToHex(c: string): string | null {
  return /^#[0-9a-f]{6}$/i.test(c) ? c : null;
}

/* ------------------------------- geometry -------------------------------- */

function Geometry({ entity, unit }: { entity: Entity; unit: DisplayUnit }) {
  const update = (e: Entity) => bus.execute({ type: "update-entity", entity: e });
  const deg = (rad: number) => (rad * 180) / Math.PI;
  const rad = (d: number) => (d * Math.PI) / 180;
  switch (entity.type) {
    case "line": {
      const len = dist(entity.a, entity.b);
      const ang = Math.atan2(entity.b.y - entity.a.y, entity.b.x - entity.a.x);
      return (
        <Section title="Line">
          <PointRow label="Start" p={entity.a} unit={unit} onCommit={(p) => update({ ...entity, a: p })} testId="prop-a" />
          <PointRow label="End" p={entity.b} unit={unit} onCommit={(p) => update({ ...entity, b: p })} testId="prop-b" />
          <LengthRow
            label="Length"
            value={len}
            unit={unit}
            testId="prop-length"
            onCommit={(v) => {
              if (len < 1e-12 || v <= 0) return;
              update({ ...entity, b: { x: entity.a.x + (Math.cos(ang) * v), y: entity.a.y + (Math.sin(ang) * v) } });
            }}
          />
          <NumberRow
            label="Angle"
            value={deg(ang)}
            suffix="°"
            testId="prop-angle"
            onCommit={(v) => update({ ...entity, b: { x: entity.a.x + Math.cos(rad(v)) * len, y: entity.a.y + Math.sin(rad(v)) * len } })}
          />
        </Section>
      );
    }
    case "circle":
      return (
        <Section title="Circle">
          <PointRow label="Center" p={entity.center} unit={unit} onCommit={(p) => update({ ...entity, center: p })} testId="prop-center" />
          <LengthRow label="Radius" value={entity.radius} unit={unit} testId="prop-radius" onCommit={(v) => v > 0 && update({ ...entity, radius: v })} />
          <LengthRow label="Diameter" value={entity.radius * 2} unit={unit} testId="prop-diameter" onCommit={(v) => v > 0 && update({ ...entity, radius: v / 2 })} />
          <ReadRow label="Circumference" value={formatLength(2 * Math.PI * entity.radius, unit)} />
          <ReadRow label="Area" value={formatArea(Math.PI * entity.radius * entity.radius, unit)} />
        </Section>
      );
    case "arc": {
      const sweep = arcSweep(entity.startAngle, entity.endAngle, entity.ccw);
      return (
        <Section title="Arc">
          <PointRow label="Center" p={entity.center} unit={unit} onCommit={(p) => update({ ...entity, center: p })} testId="prop-center" />
          <LengthRow label="Radius" value={entity.radius} unit={unit} testId="prop-radius" onCommit={(v) => v > 0 && update({ ...entity, radius: v })} />
          <NumberRow label="Start" value={deg(entity.startAngle)} suffix="°" testId="prop-start" onCommit={(v) => update({ ...entity, startAngle: rad(v) })} />
          <NumberRow label="End" value={deg(entity.endAngle)} suffix="°" testId="prop-end" onCommit={(v) => update({ ...entity, endAngle: rad(v) })} />
          <Row label="Direction">
            <select className="propspanel-input" value={entity.ccw ? "ccw" : "cw"} onChange={(e) => update({ ...entity, ccw: e.target.value === "ccw" })}>
              <option value="ccw">counterclockwise</option>
              <option value="cw">clockwise</option>
            </select>
          </Row>
          <ReadRow label="Sweep" value={`${round(deg(sweep))}°`} />
          <ReadRow label="Length" value={formatLength(entity.radius * sweep, unit)} />
          <ReadRow label="Start point" value={fmtPoint(arcPointAt(entity.center, entity.radius, entity.startAngle), unit)} />
          <ReadRow label="End point" value={fmtPoint(arcPointAt(entity.center, entity.radius, entity.endAngle), unit)} />
        </Section>
      );
    }
    case "polyline":
      return <PolylineGeometry entity={entity} unit={unit} />;
    case "point":
      return (
        <Section title="Point">
          <PointRow label="Position" p={entity.p} unit={unit} onCommit={(p) => update({ ...entity, p })} testId="prop-p" />
        </Section>
      );
    case "text":
      return (
        <Section title="Text">
          <Row label="Text">
            <TextField value={entity.text} testId="prop-text" onCommit={(v) => update({ ...entity, text: v })} />
          </Row>
          <PointRow label="Position" p={entity.at} unit={unit} onCommit={(p) => update({ ...entity, at: p })} testId="prop-at" />
          <LengthRow label="Height" value={entity.height} unit={unit} testId="prop-height" onCommit={(v) => v > 0 && update({ ...entity, height: v })} />
          <NumberRow label="Rotation" value={deg(entity.rotation)} suffix="°" testId="prop-rotation" onCommit={(v) => update({ ...entity, rotation: rad(v) })} />
        </Section>
      );
    case "image":
      return (
        <Section title="Image">
          <PointRow label="Insert" p={entity.insert} unit={unit} onCommit={(p) => update({ ...entity, insert: p })} testId="prop-insert" />
          <LengthRow label="Width" value={entity.width} unit={unit} testId="prop-width" onCommit={(v) => v > 0 && update({ ...entity, width: v })} />
          <LengthRow label="Height" value={entity.height} unit={unit} testId="prop-height" onCommit={(v) => v > 0 && update({ ...entity, height: v })} />
          <NumberRow label="Rotation" value={deg(entity.rotation)} suffix="°" testId="prop-rotation" onCommit={(v) => update({ ...entity, rotation: rad(v) })} />
        </Section>
      );
  }
}

function PolylineGeometry({ entity, unit }: { entity: PolylineEntity; unit: DisplayUnit }) {
  const update = (e: Entity) => bus.execute({ type: "update-entity", entity: e });
  const area = useMemo(() => (entity.closed ? findClosedRegions([entity])[0]?.area ?? null : null), [entity]);
  const [showVertices, setShowVertices] = useState(false);
  return (
    <Section title="Polyline">
      <ReadRow label="Vertices" value={String(entity.points.length)} />
      <Row label="Closed">
        <input type="checkbox" checked={entity.closed} data-testid="prop-closed" onChange={(e) => update({ ...entity, closed: e.target.checked })} />
      </Row>
      <ReadRow label="Length" value={formatLength(polylineLength(entity), unit)} />
      {area !== null && <ReadRow label="Area" value={formatArea(area, unit)} />}
      <div className="propspanel-row propspanel-actions">
        <button className="btn ghost sm" onClick={() => setShowVertices((v) => !v)} data-testid="prop-vertices-toggle">
          {showVertices ? "Hide vertices" : `Vertices (${entity.points.length})`}
        </button>
        <button
          className="btn ghost sm"
          title="Reverse the vertex order (flips the direction offset and arc legs follow)"
          data-testid="prop-reverse"
          onClick={() => update(reversePolyline(entity))}
        >
          Reverse
        </button>
      </div>
      {showVertices &&
        entity.points.map((p, i) => (
          <div key={i} className="propspanel-vertex">
            <PointRow
              label={`#${i + 1}`}
              p={p}
              unit={unit}
              testId={`prop-vertex-${i}`}
              onCommit={(np) => update({ ...entity, points: entity.points.map((q, j) => (j === i ? np : q)) })}
            />
            <div className="propspanel-vertex-actions">
              <button
                className="btn ghost sm"
                title="Insert a vertex after this one, at the middle of the next leg"
                data-testid={`prop-vertex-add-${i}`}
                onClick={() => update(insertVertexAfter(entity, i))}
              >
                +
              </button>
              <button
                className="btn ghost sm"
                title={(entity.bulges?.[i] ?? 0) !== 0 ? "Make the next leg straight" : "Make the next leg an arc (a slight bulge you can then grip)"}
                data-testid={`prop-vertex-arc-${i}`}
                disabled={!entity.closed && i === entity.points.length - 1}
                onClick={() => update(toggleLegArc(entity, i))}
              >
                {(entity.bulges?.[i] ?? 0) !== 0 ? "—" : "⌒"}
              </button>
              <button
                className="btn ghost sm"
                title="Remove this vertex"
                data-testid={`prop-vertex-remove-${i}`}
                disabled={entity.points.length <= 2}
                onClick={() => update(removeVertex(entity, i))}
              >
                ×
              </button>
            </div>
          </div>
        ))}
    </Section>
  );
}

/* ---------------------------- polyline editing ---------------------------- */

const legCount = (pl: PolylineEntity) => (pl.closed ? pl.points.length : pl.points.length - 1);
const bulgesOf = (pl: PolylineEntity) => Array.from({ length: legCount(pl) }, (_, i) => pl.bulges?.[i] ?? 0);
const withBulges = (pl: PolylineEntity, bulges: number[]): PolylineEntity =>
  bulges.some((b) => b !== 0) ? { ...pl, bulges } : (({ bulges: _b, ...rest }) => rest)(pl);

/** Reversed vertex order; each bulge moves to its leg's new index and flips sign. */
function reversePolyline(pl: PolylineEntity): PolylineEntity {
  const n = pl.points.length;
  const points = [...pl.points].reverse();
  const old = bulgesOf(pl);
  const bulges: number[] = [];
  for (let i = 0; i < legCount(pl); i++) {
    // New leg i runs from new point i to i+1 = old points (n-1-i) → (n-2-i), i.e. old leg (n-2-i) backwards.
    const oldLeg = ((n - 2 - i) % n + n) % n;
    bulges.push(-old[oldLeg]);
  }
  return withBulges({ ...pl, points }, bulges);
}

/** A new vertex at the middle of leg i (straight legs only keep the bulge split; an arc leg is split into two arcs of half the sweep). */
function insertVertexAfter(pl: PolylineEntity, i: number): PolylineEntity {
  const n = pl.points.length;
  const a = pl.points[i];
  const b = pl.points[(i + 1) % n];
  if (!pl.closed && i === n - 1) return { ...pl, points: [...pl.points, { x: a.x + 10, y: a.y }] };
  const old = bulgesOf(pl);
  const bulge = old[i] ?? 0;
  let mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  let half = 0;
  if (bulge !== 0) {
    const arc = bulgeToArc(a, b, bulge);
    if (arc) {
      const sweep = arcSweep(arc.startAngle, arc.endAngle, arc.ccw);
      const midAngle = arc.ccw ? arc.startAngle + sweep / 2 : arc.startAngle - sweep / 2;
      mid = arcPointAt(arc.center, arc.radius, midAngle);
      half = Math.tan(sweep / 8) * Math.sign(bulge);
    }
  }
  const points = [...pl.points.slice(0, i + 1), mid, ...pl.points.slice(i + 1)];
  const bulges = [...old.slice(0, i), half, half, ...old.slice(i + 1)];
  return withBulges({ ...pl, points }, bulges);
}

function removeVertex(pl: PolylineEntity, i: number): PolylineEntity {
  const points = pl.points.filter((_, j) => j !== i);
  const old = bulgesOf(pl);
  // The leg into the removed vertex and the leg out of it merge into one straight leg.
  const bulges = old.filter((_, j) => j !== i);
  if (i > 0 && i - 1 < bulges.length) bulges[i - 1] = 0;
  return withBulges({ ...pl, points }, bulges.slice(0, pl.closed ? points.length : points.length - 1));
}

function toggleLegArc(pl: PolylineEntity, i: number): PolylineEntity {
  const bulges = bulgesOf(pl);
  bulges[i] = bulges[i] !== 0 ? 0 : 0.3;
  return withBulges(pl, bulges);
}

/* --------------------------------- fields -------------------------------- */

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="propspanel-section">
      <div className="propspanel-section-title">{title}</div>
      {children}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="propspanel-row">
      <span className="propspanel-label">{label}</span>
      <span className="propspanel-field">{children}</span>
    </label>
  );
}

function ReadRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="propspanel-row">
      <span className="propspanel-label">{label}</span>
      <span className="propspanel-read">{value}</span>
    </div>
  );
}

/** A text field that commits on Enter/blur and reverts on Escape, re-syncing when the value changes underneath it. */
function TextField({ value, onCommit, testId, placeholder }: { value: string; onCommit: (v: string) => void; testId?: string; placeholder?: string }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <input
      className="propspanel-input"
      value={draft}
      placeholder={placeholder}
      data-testid={testId}
      spellCheck={false}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => draft !== value && onCommit(draft)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          if (draft !== value) onCommit(draft);
          (e.target as HTMLInputElement).blur();
        } else if (e.key === "Escape") {
          setDraft(value);
          (e.target as HTMLInputElement).blur();
        }
        e.stopPropagation();
      }}
    />
  );
}

function round(v: number): number {
  const r = Math.round(v * 1000) / 1000;
  return Object.is(r, -0) ? 0 : r;
}

/** A world length shown in the display unit; typed back with an optional unit suffix. */
function LengthRow({ label, value, unit, onCommit, testId }: { label: string; value: number; unit: DisplayUnit; onCommit: (worldValue: number) => void; testId?: string }) {
  const shown = String(round(value * factorFromMm(unit)));
  return (
    <Row label={`${label} (${unit})`}>
      <TextField
        value={shown}
        testId={testId}
        onCommit={(v) => {
          const w = parseLength(v, unit);
          if (w !== null) onCommit(w);
        }}
      />
    </Row>
  );
}

function NumberRow({ label, value, suffix, onCommit, testId }: { label: string; value: number; suffix?: string; onCommit: (v: number) => void; testId?: string }) {
  return (
    <Row label={`${label}${suffix ? ` (${suffix})` : ""}`}>
      <TextField
        value={String(round(value))}
        testId={testId}
        onCommit={(v) => {
          const n = Number(v.trim());
          if (Number.isFinite(n)) onCommit(n);
        }}
      />
    </Row>
  );
}

function PointRow({ label, p, unit, onCommit, testId }: { label: string; p: { x: number; y: number }; unit: DisplayUnit; onCommit: (p: { x: number; y: number }) => void; testId?: string }) {
  const f = factorFromMm(unit);
  return (
    <Row label={`${label} (${unit})`}>
      <TextField
        value={String(round(p.x * f))}
        testId={testId ? `${testId}-x` : undefined}
        onCommit={(v) => {
          const w = parseLength(v, unit);
          if (w !== null) onCommit({ x: w, y: p.y });
        }}
      />
      <TextField
        value={String(round(p.y * f))}
        testId={testId ? `${testId}-y` : undefined}
        onCommit={(v) => {
          const w = parseLength(v, unit);
          if (w !== null) onCommit({ x: p.x, y: w });
        }}
      />
    </Row>
  );
}

function fmtPoint(p: { x: number; y: number }, unit: DisplayUnit): string {
  return `${formatLength(p.x, unit)}, ${formatLength(p.y, unit)}`;
}
