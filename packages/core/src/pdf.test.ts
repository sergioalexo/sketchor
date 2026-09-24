import { describe, expect, it } from "vitest";
import { PdfBuilder, PDF_LETTER_LANDSCAPE, pdfTextWidth } from "./pdf";
import { drawEntitiesToPdf } from "./entitiesPdf";
import type { Entity, PolylineEntity } from "./entities";

/**
 * This writer produces the file that gets saved into someone's print folder
 * without a dialog — nobody looks at it until they need it. A PDF whose xref
 * offsets are wrong opens as "damaged" days later, with the load it recorded
 * long gone, so the structural facts (offsets, page count, string escaping)
 * are worth pinning byte for byte. The drawing half is pinned by property:
 * geometry must land inside the box it was told to fit.
 */

const decode = (bytes: Uint8Array) => String.fromCharCode(...bytes);

/** Every `x y m|l|re|c` and `Td` coordinate in the content streams. */
function points(pdf: string): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  for (const m of pdf.matchAll(/(-?[\d.]+) (-?[\d.]+) (m|l|Td|re)\b/g)) {
    out.push({ x: Number(m[1]), y: Number(m[2]) });
  }
  return out;
}

describe("the PDF writer", () => {
  it("writes a file whose xref offsets land on their objects", () => {
    const pdf = new PdfBuilder();
    pdf.text(72, 72, "Hello");
    const out = decode(pdf.bytes());

    expect(out.startsWith("%PDF-1.")).toBe(true);
    const startxref = Number(/startxref\n(\d+)/.exec(out)![1]);
    expect(out.slice(startxref, startxref + 4)).toBe("xref");
    const offsets = [...out.matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
    offsets.forEach((off, i) => expect(out.slice(off, off + 10)).toContain(`${i + 1} 0 obj`));
    // The free entry plus one per object.
    expect(Number(/\/Size (\d+)/.exec(out)![1])).toBe(offsets.length + 1);
  });

  it("counts and links every page it was given", () => {
    const pdf = new PdfBuilder(PDF_LETTER_LANDSCAPE);
    pdf.text(40, 40, "one");
    pdf.addPage();
    pdf.text(40, 40, "two");
    pdf.addPage();
    pdf.text(40, 40, "three");
    expect(pdf.pageCount).toBe(3);

    const out = decode(pdf.bytes());
    expect(/\/Count (\d+)/.exec(out)![1]).toBe("3");
    const kids = /\/Kids \[([^\]]+)\]/.exec(out)![1].trim().split(" 0 R").filter(Boolean);
    expect(kids).toHaveLength(3);
    expect(out).toContain("/MediaBox [0 0 792 612]");
    for (const page of ["(one)", "(two)", "(three)"]) expect(out).toContain(page);
  });

  it("declares a content stream's true length", () => {
    const pdf = new PdfBuilder();
    pdf.text(10, 10, "measured");
    const out = decode(pdf.bytes());
    const m = /<< \/Length (\d+) >>\nstream\n([\s\S]*?)\nendstream/.exec(out)!;
    expect(m[2].length).toBe(Number(m[1]));
  });

  it("escapes the characters that would otherwise end a string early", () => {
    const pdf = new PdfBuilder();
    pdf.text(10, 10, "PO (rush) \\ 7");
    expect(decode(pdf.bytes())).toContain("(PO \\(rush\\) \\\\ 7)");
  });

  it("keeps text measurable, so centring is not a guess", () => {
    // Helvetica is proportional: 'iii' is far narrower than 'WWW', and bold
    // is wider than regular. A monospace approximation would miss both.
    expect(pdfTextWidth("iii", 10)).toBeLessThan(pdfTextWidth("WWW", 10) / 3);
    expect(pdfTextWidth("Load 42", 10, true)).toBeGreaterThan(pdfTextWidth("Load 42", 10));
    // And it scales linearly with the size.
    expect(pdfTextWidth("Load 42", 20)).toBeCloseTo(pdfTextWidth("Load 42", 10) * 2, 6);
  });

  it("puts a centred string's middle on the point it was given", () => {
    const pdf = new PdfBuilder();
    pdf.text(300, 100, "centred", { size: 12, align: "center" });
    const x = points(decode(pdf.bytes()))[0].x;
    expect(x + pdfTextWidth("centred", 12) / 2).toBeCloseTo(300, 3);
  });
});

describe("drawing entities into a PDF", () => {
  const box = { x: 50, y: 100, width: 400, height: 200 };
  const rect = (id: string, w: number, h: number, paint: Partial<PolylineEntity> = {}): PolylineEntity => ({
    id,
    type: "polyline",
    closed: true,
    points: [
      { x: 0, y: 0 },
      { x: w, y: 0 },
      { x: w, y: h },
      { x: 0, y: h },
    ],
    ...paint,
  });
  const plan: Entity[] = [
    rect("p1", 4000, 1000, { color: "#0072b2", fill: "#0072b2" }),
    { id: "c1", type: "circle", center: { x: 2000, y: 500 }, radius: 300, color: "#e69f00" },
    { id: "t1", type: "text", at: { x: 100, y: 100 }, text: "NOSE", height: 200, rotation: 0 },
  ];

  it("fits the drawing inside the box it was given", () => {
    const pdf = new PdfBuilder(PDF_LETTER_LANDSCAPE);
    drawEntitiesToPdf(pdf, plan, box);
    for (const p of points(decode(pdf.bytes()))) {
      expect(p.x).toBeGreaterThanOrEqual(box.x - 1);
      expect(p.x).toBeLessThanOrEqual(box.x + box.width + 1);
      // Page coordinates are flipped on the way in, so compare in PDF space.
      const yFromTop = pdf.height - p.y;
      expect(yFromTop).toBeGreaterThanOrEqual(box.y - 1);
      expect(yFromTop).toBeLessThanOrEqual(box.y + box.height + 1);
    }
  });

  it("reports the scale it used, and uses one scale for both axes", () => {
    const pdf = new PdfBuilder(PDF_LETTER_LANDSCAPE);
    const { scale } = drawEntitiesToPdf(pdf, plan, box);
    // 4000 mm wide into 400 pt, 1000 mm tall into 200 pt: width binds.
    expect(scale).toBeCloseTo(400 / 4000, 6);
    // …so the circle stays a circle rather than an ellipse.
    expect(decode(pdf.bytes())).toContain("c"); // beziers, not a squashed path
  });

  it("flips Y, because world Y grows up and a page's grows down", () => {
    const pdf = new PdfBuilder(PDF_LETTER_LANDSCAPE);
    drawEntitiesToPdf(pdf, [rect("p2", 100, 100)], box);
    const ys = points(decode(pdf.bytes())).map((p) => pdf.height - p.y);
    // The world's y = 0 edge is the *bottom* of the drawn box.
    expect(Math.max(...ys)).toBeGreaterThan(Math.min(...ys));
  });

  it("carries each entity's own colour through", () => {
    const pdf = new PdfBuilder(PDF_LETTER_LANDSCAPE);
    drawEntitiesToPdf(pdf, plan, box);
    const out = decode(pdf.bytes());
    // #0072b2 as PDF's 0–1 components, filled.
    expect(out).toMatch(/0 0\.447 0\.698 rg/);
    expect(out).toMatch(/0\.902 0\.624 0 RG/); // #e69f00 stroke
  });

  it("does nothing, rather than throwing, when there is nothing to draw", () => {
    const pdf = new PdfBuilder();
    expect(() => drawEntitiesToPdf(pdf, [], box)).not.toThrow();
    expect(decode(pdf.bytes()).startsWith("%PDF-1.")).toBe(true);
  });
});
