import { describe, expect, it } from "vitest";
import { nestByOrders, type Order, type TrailerProfile } from "@sketchor/plugin-truck-nesting";
import { buildPrintHtml, PANEL_HTML } from "./truckNestingPlugin";

/**
 * The printed load plan is the deliverable: it goes to a dock, on paper,
 * and whoever loads the truck works from it without the app. So the things
 * that make it usable are worth pinning — which end of the trailer is
 * which, whether a pallet's instruction tag is on the nest itself rather
 * than only in a table, and that the size column survives (it has gone
 * missing before, when a pallet was turned on the canvas).
 */

const trailer: TrailerProfile = { name: "Test 13.6m", length: 13600, width: 2480 };

const orders: Order[] = [
  {
    id: "o1",
    jobNumber: "PO-1",
    city: "Leeds",
    state: "",
    color: "#e69f00",
    pallets: [{ id: "a", width: 1200, length: 800, shape: "rect", tag: "FRAGILE" }],
  },
  {
    id: "o2",
    jobNumber: "PO-2",
    city: "Hull",
    state: "",
    color: "#0072b2",
    pallets: [{ id: "b", width: 1000, length: 1000, shape: "round" }],
  },
];

const html = () =>
  buildPrintHtml(nestByOrders(trailer, orders), [], {
    loadName: "Load",
    truckInfo: "",
    loadDate: "2026-09-23",
    perMm: 1,
    unitLabel: "mm",
  });

/** The x attribute of the `<text>` element carrying `label`. */
function labelX(svg: string, label: string): number | null {
  const m = new RegExp(`<text x="([-0-9.]+)"[^>]*>${label}</text>`).exec(svg);
  return m ? Number(m[1]) : null;
}

describe("the printed load plan", () => {
  it("marks the nose at the deep end and the door where loading starts", () => {
    const out = html();
    const nose = labelX(out, "NOSE");
    const door = labelX(out, "DOOR");
    expect(nose).not.toBeNull();
    expect(door).not.toBeNull();
    expect(nose!).toBeLessThan(trailer.length / 2);
    expect(door!).toBeGreaterThan(trailer.length / 2);
  });

  it("draws the end labels big enough to read on paper", () => {
    // Small enough to fit, large enough not to need squinting: a fair
    // fraction of the trailer's width, which is how the plan is scaled.
    const sizes = [...html().matchAll(/<text[^>]*font-size="([\d.]+)"[^>]*>(NOSE|DOOR)</g)].map((m) => Number(m[1]));
    expect(sizes).toHaveLength(2);
    for (const s of sizes) expect(s).toBeGreaterThan(trailer.width * 0.08);
  });

  it("puts the pallet's tag on the nest, not only in the table", () => {
    const out = html();
    const svg = out.slice(out.indexOf("<svg"), out.indexOf("</svg>"));
    expect(svg).toContain(">FRAGILE<");
  });

  it("lists sizes and drops the shape column", () => {
    const out = html();
    expect(out).toContain("<th>Size</th>");
    expect(out).not.toContain("<th>Shape</th>");
    expect(out).not.toContain("<td>Rect</td>");
    // The sizes themselves are still there.
    expect(out).toContain("1200 mm × 800 mm");
    expect(out).toContain("Ø 1000 mm");
  });

  it("calls the colour key a load sequence", () => {
    expect(html()).toContain("Legend — load sequence");
    expect(html()).not.toContain("unload sequence");
  });

  it("writes light text on dark pallets and dark text on light ones", () => {
    const out = html();
    // The dark blue order must not be labelled in near-black.
    expect(out).toMatch(/fill="#ffffff"/);
    expect(out).toMatch(/fill="#111111"/);
  });
});

/**
 * The panel runs inside the plugin sandbox, where a test can't reach it —
 * so these assert on the markup that is shipped into that sandbox. Shallow
 * by nature, but they do catch the thing worth catching: a control or a
 * label that was renamed in one place and not the other.
 */
describe("the load-plan panel", () => {
  it("offers an orientation lock per pallet", () => {
    expect(PANEL_HTML).toContain("p-orient");
    expect(PANEL_HTML).toContain('{ v: "auto"');
    expect(PANEL_HTML).toContain('{ v: "fixed"');
    expect(PANEL_HTML).toContain('{ v: "turned"');
    // And writes the choice back onto the pallet.
    expect(PANEL_HTML).toContain("p.orientation = e.target.value");
  });

  it("talks about loading, not unloading", () => {
    expect(PANEL_HTML).toContain("to set load order");
    expect(PANEL_HTML).toContain("Load sequence");
    expect(PANEL_HTML).not.toContain("unload");
    expect(PANEL_HTML).not.toContain("Unload");
  });
});
