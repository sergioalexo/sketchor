/**
 * Why this is worth testing: an EPS import that drops a path, mis-scales it,
 * or hangs on a hostile file is a silent wrong cut-line. These tests pin the
 * geometry in mm for the two dialects we meet (plain PostScript from
 * Inkscape/LibreCAD-style writers, and Illustrator's AGM shorthands), the DOS
 * binary container, the TIFF-preview fallbacks, and the "empty, truncated,
 * malformed → returns, never throws, always terminates" rule. Fixtures are
 * tiny synthetic files — real customer artwork never goes in the repo.
 */
import { describe, expect, it } from "vitest";
import type { Entity, HatchEntity, ImageEntity, PolylineEntity, SplineEntity } from "../entities";
import { kindTessellate } from "../kinds/registry";
import "../kinds/builtin";
import { ascii85 } from "./interp";
import { hasDosHeader, parseDosHeader, parseEpsHeader, splitEps } from "./dsc";
import { importEps } from "./index";
import { decodeTiff } from "./tiff";
import { encodePng } from "./png";

const K = 25.4 / 72;
const enc = (s: string): Uint8Array => Uint8Array.from(s, (c) => c.charCodeAt(0) & 255);
const near = (a: number, b: number, tol = 1e-6) => expect(Math.abs(a - b)).toBeLessThan(tol);

function bounds(es: Entity[]) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const e of es) {
    if (e.type === "image" || e.type === "hatch") continue;
    for (const pl of kindTessellate(e)) for (const p of pl) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
  }
  return { x0, y0, x1, y1 };
}

/** A 2x2 RGB uncompressed little-endian TIFF. */
function tinyTiff(): Uint8Array {
  const px = [255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255];
  const entries: [number, number, number, number][] = [
    [256, 3, 1, 2], [257, 3, 1, 2], [258, 3, 3, 0], [259, 3, 1, 1], [262, 3, 1, 2], [273, 4, 1, 0], [277, 3, 1, 3], [278, 3, 1, 2], [279, 4, 1, 12],
  ];
  const ifdAt = 8 + px.length;
  const bpsAt = ifdAt + 2 + entries.length * 12 + 4;
  const buf = new Uint8Array(bpsAt + 6);
  const dv = new DataView(buf.buffer);
  buf.set([0x49, 0x49, 42, 0]);
  dv.setUint32(4, ifdAt, true);
  buf.set(px, 8);
  dv.setUint16(ifdAt, entries.length, true);
  entries.forEach(([tag, type, count, val], i) => {
    const o = ifdAt + 2 + i * 12;
    dv.setUint16(o, tag, true);
    dv.setUint16(o + 2, type, true);
    dv.setUint32(o + 4, count, true);
    if (tag === 258) dv.setUint32(o + 8, bpsAt, true);
    else if (tag === 273) dv.setUint32(o + 8, 8, true);
    else if (type === 3) dv.setUint16(o + 8, val, true);
    else dv.setUint32(o + 8, val, true);
  });
  dv.setUint16(bpsAt, 8, true);
  dv.setUint16(bpsAt + 2, 8, true);
  dv.setUint16(bpsAt + 4, 8, true);
  return buf;
}

function dosEps(ps: string, tiff: Uint8Array | null): Uint8Array {
  const p = enc(ps);
  const total = 30 + p.length + (tiff?.length ?? 0);
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  out.set([0xc5, 0xd0, 0xd3, 0xc6]);
  dv.setUint32(4, 30, true);
  dv.setUint32(8, p.length, true);
  dv.setUint32(20, tiff ? 30 + p.length : 0, true);
  dv.setUint32(24, tiff?.length ?? 0, true);
  dv.setUint16(28, 0xffff, true);
  out.set(p, 30);
  if (tiff) out.set(tiff, 30 + p.length);
  return out;
}

const GENERIC = `%!PS-Adobe-3.0 EPSF-3.0
%%Creator: Inkscape
%%BoundingBox: 10 20 110 70
%%HiResBoundingBox: 10 20 110 70
%%EndComments
/bd { bind def } bind def
/box { newpath 3 index 3 index moveto 1 index 0 rlineto 0 exch rlineto neg 0 rlineto closepath } bd
gsave
2 setlinewidth
0 0 1 setrgbcolor
10 20 moveto 110 20 lineto 110 70 lineto 10 70 lineto closepath stroke
grestore
1 0 0 setrgbcolor
newpath 60 45 15 0 360 arc closepath fill
0 setgray
newpath 20 30 moveto 40 30 40 50 20 50 curveto stroke
showpage
`;

describe("EPS import — plain PostScript (Inkscape/LibreCAD style)", () => {
  const r = importEps(enc(GENERIC));

  it("reads the DSC header", () => {
    expect(r.header.bbox).toEqual([10, 20, 110, 70]);
    expect(r.header.kind).toBe("generic");
  });

  it("imports a stroked rectangle at the right size in mm, origin at the bounding-box corner", () => {
    const rect = r.entities.find((e) => e.type === "polyline") as PolylineEntity;
    expect(rect.closed).toBe(true);
    const b = bounds([rect]);
    near(b.x0, 0);
    near(b.y0, 0);
    near(b.x1, 100 * K);
    near(b.y1, 50 * K);
    expect(rect.color).toBe("#0000ff");
    near(rect.lineweight ?? 0, 2 * K, 1e-3);
  });

  it("turns a full arc into a circle with the fill colour", () => {
    const c = r.entities.find((e) => e.type === "circle");
    expect(c && c.type === "circle").toBe(true);
    if (c && c.type === "circle") {
      near(c.center.x, 50 * K, 1e-3);
      near(c.center.y, 25 * K, 1e-3);
      near(c.radius, 15 * K, 1e-3);
      expect(c.fill).toBe("#ff0000");
    }
  });

  it("keeps a lone Bezier as an exact cubic spline", () => {
    const s = r.entities.find((e) => e.type === "spline") as SplineEntity;
    expect(s.degree).toBe(3);
    expect(s.controlPoints).toHaveLength(4);
    near(s.controlPoints[1].x, (40 - 10) * K, 1e-6);
  });

  it("stops at showpage and reports nothing unsupported", () => {
    expect(r.unsupported).toEqual({});
    expect(r.warnings).toEqual([]);
  });
});

const AGM = `%!PS-Adobe-3.1 EPSF-3.0
%%Creator: Adobe Illustrator(R) 23.0
%%BoundingBox: 0 0 200 100
%%HiResBoundingBox: 0 0 200.0 100.0
%%LanguageLevel: 2
%%DocumentNeededResources:
%%+ procset Adobe_AGM_Core 2.0 0
%%EndComments
%%BeginProlog
/Adobe_AGM_Core 100 dict def
Adobe_AGM_Core begin /mo {this is not valid postscript at all ( unbalanced
%%EndProlog
%%BeginSetup
%%EndSetup
%%Page: 1 1
%%BeginPageSetup
%%EndPageSetup
1 -1 scale 0 -100 translate
pgsv
[1 0 0 1 0 0 ]ct
gsave
np
gsave
0 0 mo
0 100 li
200 100 li
200 0 li
cp
clp
1 lw
false sop
/0
<<
/Name (CutContour)
/0
[/DeviceCMYK] /CSA add_res
/CSA /0 get_csa_by_name
/MappedCSA /0 /CSA get_res
/TintMethod /Subtractive
/NComponents 4
/Components [ 0 1 0 0 ]
>>
/CSD add_res
1 /0 /CSD get_res sepcs
1 sep
10 10 mo
110 10 li
110 60 li
10 60 li
cp
@
0 0 0 1 cmyk
120 20 mo
150 20 li
150 50 li
120 50 li
cp
130 30 mo
140 30 li
140 40 li
130 40 li
cp
f
20 20 mo
(AB)sh
grestore
grestore
pgrs
%%PageTrailer
%%Trailer
`;

describe("EPS import — Illustrator AGM shorthands", () => {
  const r = importEps(enc(AGM));

  it("skips the prolog and detects AGM", () => {
    expect(r.header.agm).toBe(true);
    expect(r.header.kind).toBe("illustrator");
    expect(r.entities.length).toBeGreaterThan(0);
  });

  it("flips Illustrator's y-down page into y-up mm", () => {
    const b = bounds(r.entities);
    near(b.x0, 10 * K);
    near(b.x1, 150 * K);
    // y was 10..60 in the flipped space → 40..90 bottom-up
    near(b.y0, 40 * K, 1e-6);
    near(b.y1, 90 * K, 1e-6);
  });

  it("puts a spot colour on a layer named after it, with the tinted CMYK colour", () => {
    const p = r.entities.find((e) => e.type === "polyline") as PolylineEntity;
    expect(p.layer).toBe("CutContour");
    expect(p.color).toBe("#ff00ff");
  });

  it("makes a compound fill one solid hatch (hole kept as its own loop) and black stays automatic", () => {
    const h = r.entities.find((e) => e.type === "hatch") as HatchEntity;
    expect(h.loops).toHaveLength(2);
    expect(h.paint).toEqual({ kind: "solid", color: "#000000" });
    expect(h.layer).toBeUndefined();
  });

  it("emits text for a show", () => {
    const t = r.entities.find((e) => e.type === "text");
    expect(t && t.type === "text" && t.text).toBe("AB");
  });
});

describe("EPS import — circles and fill-then-stroke", () => {
  it("recognises the four-Bezier circle Illustrator draws and merges a stroke onto the same path", () => {
    const k = 0.5522847498 * 25;
    const ps = `%!PS-Adobe-3.0 EPSF-3.0
%%BoundingBox: 0 0 100 100
%%EndComments
newpath 75 50 moveto 75 ${50 + k} ${50 + k} 75 50 75 curveto ${50 - k} 75 25 ${50 + k} 25 50 curveto 25 ${50 - k} ${50 - k} 25 50 25 curveto ${50 + k} 25 75 ${50 - k} 75 50 curveto closepath
gsave 1 0 0 setrgbcolor fill grestore
newpath 75 50 moveto 75 ${50 + k} ${50 + k} 75 50 75 curveto ${50 - k} 75 25 ${50 + k} 25 50 curveto 25 ${50 - k} ${50 - k} 25 50 25 curveto ${50 + k} 25 75 ${50 - k} 75 50 curveto closepath
0 0 1 setrgbcolor 3 setlinewidth stroke
`;
    const r = importEps(enc(ps));
    expect(r.entities).toHaveLength(1);
    const c = r.entities[0];
    expect(c.type).toBe("circle");
    if (c.type === "circle") {
      near(c.radius, 25 * K, 1e-4);
      expect(c.fill).toBe("#ff0000");
      expect(c.color).toBe("#0000ff");
      near(c.lineweight ?? 0, 3 * K, 1e-3);
    }
  });
});

describe("EPS container (DOS binary header) and previews", () => {
  it("strips the DOS header and finds the TIFF preview", () => {
    const file = dosEps(GENERIC, tinyTiff());
    expect(hasDosHeader(file)).toBe(true);
    const dos = parseDosHeader(file)!;
    expect(dos.psOffset).toBe(30);
    const parts = splitEps(file);
    expect(parts.ps!.length).toBe(enc(GENERIC).length);
    expect(parts.tiff!.length).toBe(tinyTiff().length);
    const r = importEps(file);
    expect(r.entities.filter((e) => e.type === "polyline")).toHaveLength(1);
  });

  it("decodes the baseline TIFF preview to RGBA", () => {
    const img = decodeTiff(tinyTiff())!;
    expect(img.width).toBe(2);
    expect(Array.from(img.rgba.slice(0, 4))).toEqual([255, 0, 0, 255]);
    expect(Array.from(img.rgba.slice(12, 16))).toEqual([255, 255, 255, 255]);
  });

  it("imports a Photoshop EPS as its preview image at the bounding-box size", () => {
    const ps = `%!PS-Adobe-3.0 EPSF-3.0\n%%Creator: Adobe Photoshop Version 11.0\n%%BoundingBox: 0 0 72 36\n%%EndComments\n`;
    const r = importEps(dosEps(ps, tinyTiff()));
    expect(r.header.kind).toBe("photoshop");
    expect(r.fromPreview).toBe(true);
    const im = r.entities[0] as ImageEntity;
    expect(im.type).toBe("image");
    near(im.width, 25.4, 1e-9);
    near(im.height, 12.7, 1e-9);
    expect(im.dataUrl.startsWith("data:image/png;base64,")).toBe(true);
  });

  it("falls back to the preview when no geometry can be read", () => {
    const ps = `%!PS-Adobe-3.0 EPSF-3.0\n%%BoundingBox: 0 0 72 72\n%%EndComments\nshowpage\n`;
    const r = importEps(dosEps(ps, tinyTiff()));
    expect(r.fromPreview).toBe(true);
    expect(r.warnings.join(" ")).toMatch(/preview/);
  });

  it("explains a PDF-based .ai instead of crashing", () => {
    const r = importEps(enc("%PDF-1.6\n1 0 obj\n<<>>\nendobj\n"));
    expect(r.header.kind).toBe("pdf");
    expect(r.entities).toEqual([]);
    expect(r.warnings.join(" ")).toMatch(/PDF-based/);
  });

  it("parses header comments (creator in parentheses, hi-res box)", () => {
    const h = parseEpsHeader(enc("%!PS-Adobe-3.0 EPSF-3.0\n%%Creator: (Adobe Illustrator\\(R\\) 25.1)\n%%BoundingBox: 0 0 10 10\n%%HiResBoundingBox: 0 0 9.5 9.5\n%%EndComments\n"));
    expect(h.kind).toBe("illustrator");
    expect(h.hiResBbox).toEqual([0, 0, 9.5, 9.5]);
  });
});

describe("EPS import — AGM images", () => {
  it("places an ASCII85 + run-length CMYK image by the CTM", () => {
    // 2x1 CMYK pixels, planar per row: c0 c1 m0 m1 y0 y1 k0 k1; run-length literal run of 8 bytes then EOD.
    const raw = [7, 255, 0, 0, 0, 0, 0, 0, 0, 128];
    const a85: number[] = [];
    for (let i = 0; i < raw.length; i += 4) {
      const chunk = raw.slice(i, i + 4);
      const n = chunk.length;
      while (chunk.length < 4) chunk.push(0);
      let v = chunk[0] * 16777216 + chunk[1] * 65536 + chunk[2] * 256 + chunk[3];
      const d: number[] = [];
      for (let k = 0; k < 5; k++) { d.unshift(v % 85); v = Math.floor(v / 85); }
      a85.push(...d.slice(0, n + 1).map((x) => x + 33));
    }
    const data = String.fromCharCode(...a85) + "~>";
    const ps = `%!PS-Adobe-3.0 EPSF-3.0
%%Creator: Adobe Illustrator(R) 23.0
%%BoundingBox: 0 0 40 20
%%HiResBoundingBox: 0 0 40 20
%%DocumentNeededResources:
%%+ procset Adobe_AGM_Core 2.0 0
%%EndComments
%%EndPageSetup
1 -1 scale 0 -20 translate
gsave
[1 0 0 -1 0 20 ]ct
[40 0 0 20 0 0 ]ct
Adobe_AGM_Image/AGMIMG_fl cf /ASCII85Decode fl /RunLengthDecode filter ddf
<<
/T 1
/W 2
/H 1
/M[2 0 0 -1 0 1 ]
/BC 8
/D[0 1 0 1 0 1 0 1 ]
/DS [
[AGMIMG_fl 2 string /rs cvx /pop cvx] cvx
[AGMIMG_fl 2 string /rs cvx /pop cvx] cvx
[AGMIMG_fl 2 string /rs cvx /pop cvx] cvx
[AGMIMG_fl 2 string /rs cvx /pop cvx] cvx
]
/O 3
>>
img
${data}
grestore
`;
    const r = importEps(enc(ps));
    const im = r.entities.find((e) => e.type === "image") as ImageEntity;
    expect(im).toBeDefined();
    near(im.insert.x, 0);
    near(im.insert.y, 0);
    near(im.width, 40 * K, 1e-9);
    near(im.height, 20 * K, 1e-9);
    expect(im.dataUrl.startsWith("data:image/png")).toBe(true);
  });
});

describe("helpers", () => {
  it("decodes ASCII85 with z and partial groups", () => {
    const s = enc("87cURD]i,\"Ebo80~>");
    expect(String.fromCharCode(...ascii85(s, 0, s.length - 2))).toBe("Hello World!");
    const z = enc("z");
    expect(Array.from(ascii85(z, 0, 1))).toEqual([0, 0, 0, 0]);
  });

  it("writes a PNG with a valid signature and IHDR", () => {
    const png = encodePng(2, 2, new Uint8Array(16));
    expect(Array.from(png.slice(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(String.fromCharCode(...png.slice(12, 16))).toBe("IHDR");
  });
});

describe("EPS import — hostile input always returns", () => {
  const cases: [string, Uint8Array][] = [
    ["empty", new Uint8Array(0)],
    ["garbage", Uint8Array.from({ length: 5000 }, (_, i) => (i * 7919) & 255)],
    ["truncated DOS header", Uint8Array.from([0xc5, 0xd0, 0xd3, 0xc6, 1, 2, 3])],
    ["DOS header pointing past the end", (() => { const f = dosEps("%!PS\n", null); new DataView(f.buffer).setUint32(8, 1e9, true); return f; })()],
    ["unbalanced string/proc/array", enc("%!PS-Adobe-3.0 EPSF-3.0\n%%BoundingBox: 0 0 1 1\n%%EndComments\n(abc {[ <ab")],
    ["infinite loop", enc("%!PS-Adobe-3.0 EPSF-3.0\n%%BoundingBox: 0 0 1 1\n%%EndComments\n{ } loop\n")],
    ["runaway recursion", enc("%!PS-Adobe-3.0 EPSF-3.0\n%%BoundingBox: 0 0 1 1\n%%EndComments\n/f { f } def f\n")],
    ["stack growth", enc("%!PS-Adobe-3.0 EPSF-3.0\n%%BoundingBox: 0 0 1 1\n%%EndComments\n{ 1 } loop\n")],
    ["huge array", enc("%!PS-Adobe-3.0 EPSF-3.0\n%%BoundingBox: 0 0 1 1\n%%EndComments\n999999999 array pop 0 0 moveto 1 0 div 5 lineto fill\n")],
    ["NaN coordinates", enc("%!PS-Adobe-3.0 EPSF-3.0\n%%BoundingBox: 0 0 1 1\n%%EndComments\n0 0 moveto 1e999 1e999 lineto 5 5 lineto fill\n")],
  ];
  for (const [name, bytes] of cases) {
    it(name, () => {
      const r = importEps(bytes, { maxOps: 200_000 });
      expect(Array.isArray(r.entities)).toBe(true);
      expect(Array.isArray(r.warnings)).toBe(true);
      for (const e of r.entities) expect(JSON.stringify(e)).not.toMatch(/null|NaN|Infinity/);
    });
  }

  it("caps entities", () => {
    let ps = "%!PS-Adobe-3.0 EPSF-3.0\n%%BoundingBox: 0 0 100 100\n%%EndComments\n";
    for (let i = 0; i < 200; i++) ps += `${i} 0 moveto ${i + 1} 5 lineto stroke\n`;
    const r = importEps(enc(ps), { maxEntities: 50 });
    expect(r.entities.length).toBeLessThanOrEqual(50);
    expect(r.warnings.join(" ")).toMatch(/limit/);
  });
});
