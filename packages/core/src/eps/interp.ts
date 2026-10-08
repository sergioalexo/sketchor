/**
 * F-01 — a restricted PostScript interpreter that turns EPS drawing code into
 * Sketchor entities. Not Ghostscript: it implements the stack/dictionary/
 * control core, the path and paint operators CAD and Illustrator exports use,
 * and Adobe's AGM shorthands (`mo li cv cp f ef @ cmyk sepcs …`) natively.
 * Illustrator's heavyweight AGM/CoolType prolog is *skipped*, not executed —
 * those procsets only define the shorthands (and a lot of device plumbing)
 * this file provides directly. Anything unknown is counted and ignored; the
 * run is bounded by an operation budget, so hostile input always terminates.
 */
import type { Entity, ImageEntity, TextEntity } from "../entities";
import { newEntityId } from "../entities";
import type { Point } from "../geometry";
import { nearestLinetype } from "../svgStyle";
import { cmykToRgb, hsbToRgb, isBlackRgb, rgbToCss, type Rgb } from "./color";
import { pathSignature, pureKind, subpathToEntities, subpathsToHatch, type PSeg, type SubPath } from "./paint";
import { downscale, type RgbaImage } from "./tiff";
import { rgbaToPngDataUrl } from "./png";

/* --------------------------------- values --------------------------------- */

export class PsName {
  constructor(public s: string, public lit: boolean, public imm = false) {}
}
export class PsStr {
  constructor(public s: string) {}
}
export class PsArr {
  constructor(public a: V[], public exec = false) {}
}
export class PsDict {
  m = new Map<string, V>();
}
export class PsOp {
  constructor(public name: string, public fn: () => void) {}
}
export class PsFile {
  constructor(public filters: string[] = []) {}
}
class PsMark {}
const MARK = new PsMark();
class PsSave {
  constructor(public gs: Gs, public depth: number) {}
}
export type V = number | boolean | null | PsName | PsStr | PsArr | PsDict | PsOp | PsFile | PsMark | PsSave;

class PsError extends Error {}
class ExitSignal {}
class StopSignal {}
class BudgetExceeded {}
class Halt {}

const EOF = Symbol("eof");
const CLOSE = Symbol("close");

/* -------------------------------- matrices -------------------------------- */

type Mat = [number, number, number, number, number, number];
const IDENT: Mat = [1, 0, 0, 1, 0, 0];
/** `a` applied first, then `b` (PostScript's row-vector convention: result = a × b). */
function mmul(a: Mat, b: Mat): Mat {
  return [
    a[0] * b[0] + a[1] * b[2],
    a[0] * b[1] + a[1] * b[3],
    a[2] * b[0] + a[3] * b[2],
    a[2] * b[1] + a[3] * b[3],
    a[4] * b[0] + a[5] * b[2] + b[4],
    a[4] * b[1] + a[5] * b[3] + b[5],
  ];
}
const mapPt = (m: Mat, x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
function minv(m: Mat): Mat | null {
  const det = m[0] * m[3] - m[1] * m[2];
  if (!Number.isFinite(det) || Math.abs(det) < 1e-14) return null;
  return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det];
}
const mscale = (m: Mat): number => Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));

/* ----------------------------- graphics state ----------------------------- */

interface Gs {
  ctm: Mat;
  color: Rgb;
  cs: "gray" | "rgb" | "cmyk" | "other";
  spot: { name: string; comps: number[] } | null;
  layer: string | undefined;
  lw: number;
  dash: number[];
  fontName: string;
  fontMatrix: Mat;
  clip: [number, number, number, number] | null;
}
const newGs = (): Gs => ({ ctm: [...IDENT] as Mat, color: [0, 0, 0], cs: "gray", spot: null, layer: undefined, lw: 1, dash: [], fontName: "", fontMatrix: [10, 0, 0, 10, 0, 0], clip: null });
const cloneGs = (g: Gs): Gs => ({ ...g, ctm: [...g.ctm] as Mat, color: [...g.color] as Rgb, dash: g.dash.slice(), fontMatrix: [...g.fontMatrix] as Mat, clip: g.clip ? ([...g.clip] as Gs["clip"]) : null });

/* -------------------------------- scanner --------------------------------- */

const WS = new Uint8Array(256);
for (const c of [0, 9, 10, 12, 13, 32]) WS[c] = 1;
const DELIM = new Uint8Array(256);
for (const ch of "()<>[]{}/%") DELIM[ch.charCodeAt(0)] = 1;
const NUM_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

function indexOfStr(b: Uint8Array, needle: string, from: number, end: number): number {
  const n = needle.length;
  const c0 = needle.charCodeAt(0);
  for (let i = b.indexOf(c0, from); i >= 0 && i + n <= end; i = b.indexOf(c0, i + 1)) {
    let k = 1;
    while (k < n && b[i + k] === needle.charCodeAt(k)) k++;
    if (k === n) return i;
  }
  return -1;
}
const startsAt = (b: Uint8Array, p: number, s: string): boolean => {
  for (let i = 0; i < s.length; i++) if (b[p + i] !== s.charCodeAt(i)) return false;
  return true;
};

class Scanner {
  p: number;
  constructor(public b: Uint8Array, start: number, public end: number, private resolveImm: (n: string) => V) {
    this.p = start;
  }

  private skipComment(): void {
    const b = this.b;
    const s = this.p;
    if (b[s + 1] === 0x41 && startsAt(b, s, "%ADOBeginSubsetFont")) {
      const e = indexOfStr(b, "%ADOEndSubsetFont", s, this.end);
      this.p = e < 0 ? this.end : e + 17;
      return;
    }
    if (b[s + 1] === 0x25 && (startsAt(b, s, "%%PageTrailer") || startsAt(b, s, "%%Trailer"))) {
      this.p = this.end;
      return;
    }
    let p = s + 1;
    while (p < this.end && b[p] !== 10 && b[p] !== 13) p++;
    this.p = p;
  }

  private readString(): PsStr {
    const b = this.b;
    let depth = 1;
    let out = "";
    let p = this.p + 1;
    let run = p;
    while (p < this.end) {
      const c = b[p];
      if (c === 0x5c) {
        out += String.fromCharCode(...b.subarray(run, p));
        p++;
        const e = b[p];
        if (e >= 0x30 && e <= 0x37) {
          let v = 0;
          let n = 0;
          while (n < 3 && b[p] >= 0x30 && b[p] <= 0x37) {
            v = v * 8 + b[p] - 0x30;
            p++;
            n++;
          }
          out += String.fromCharCode(v & 255);
          run = p;
          continue;
        }
        const map: Record<number, string> = { 0x6e: "\n", 0x72: "\r", 0x74: "\t", 0x62: "\b", 0x66: "\f" };
        if (e === 10 || e === 13) {
          if (e === 13 && b[p + 1] === 10) p++;
        } else if (e !== undefined) out += map[e] ?? String.fromCharCode(e);
        p++;
        run = p;
        continue;
      }
      if (c === 0x28) depth++;
      else if (c === 0x29 && --depth === 0) break;
      p++;
    }
    for (let i = run; i < Math.min(p, this.end); i += 8192) out += String.fromCharCode(...b.subarray(i, Math.min(p, i + 8192)));
    this.p = Math.min(this.end, p + 1);
    return new PsStr(out);
  }

  private readHex(): PsStr {
    const b = this.b;
    let p = this.p + 1;
    let out = "";
    let hi = -1;
    while (p < this.end && b[p] !== 0x3e) {
      const c = b[p++];
      const v = c >= 0x30 && c <= 0x39 ? c - 0x30 : c >= 0x41 && c <= 0x46 ? c - 0x37 : c >= 0x61 && c <= 0x66 ? c - 0x57 : -1;
      if (v < 0) continue;
      if (hi < 0) hi = v;
      else {
        out += String.fromCharCode(hi * 16 + v);
        hi = -1;
      }
    }
    if (hi >= 0) out += String.fromCharCode(hi * 16);
    this.p = Math.min(this.end, p + 1);
    return new PsStr(out);
  }

  private readA85(): PsStr {
    const start = this.p + 2;
    const e = indexOfStr(this.b, "~>", start, this.end);
    const stop = e < 0 ? this.end : e;
    const bytes = ascii85(this.b, start, stop);
    this.p = e < 0 ? this.end : e + 2;
    let out = "";
    for (let i = 0; i < bytes.length; i += 8192) out += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return new PsStr(out);
  }

  next(): V | typeof EOF | typeof CLOSE {
    const b = this.b;
    for (;;) {
      while (this.p < this.end && WS[b[this.p]]) this.p++;
      if (this.p >= this.end) return EOF;
      const c = b[this.p];
      switch (c) {
        case 0x25:
          this.skipComment();
          continue;
        case 0x28:
          return this.readString();
        case 0x3c: {
          const n = b[this.p + 1];
          if (n === 0x3c) {
            this.p += 2;
            return new PsName("<<", false);
          }
          if (n === 0x7e) return this.readA85();
          if (n === 0x3f) {
            // <?xpacket … XMP metadata: skip through its end marker
            const e = indexOfStr(b, "&&end XMP packet marker&&", this.p, this.end);
            this.p = e < 0 ? this.end : e + 25;
            continue;
          }
          return this.readHex();
        }
        case 0x3e:
          if (b[this.p + 1] === 0x3e) {
            this.p += 2;
            return new PsName(">>", false);
          }
          this.p++;
          continue;
        case 0x5b:
          this.p++;
          return new PsName("[", false);
        case 0x5d:
          this.p++;
          return new PsName("]", false);
        case 0x7b:
          this.p++;
          return this.readProc();
        case 0x7d:
          this.p++;
          return CLOSE;
        case 0x29:
          this.p++;
          continue;
        case 0x2f: {
          let q = this.p + 1;
          const imm = b[q] === 0x2f;
          if (imm) q++;
          const s = q;
          while (q < this.end && !WS[b[q]] && !DELIM[b[q]]) q++;
          this.p = q;
          const name = latin(b, s, q);
          return imm ? this.resolveImm(name) : new PsName(name, true);
        }
        default: {
          let q = this.p;
          while (q < this.end && !WS[b[q]] && !DELIM[b[q]]) q++;
          const tok = latin(b, this.p, q);
          this.p = q;
          if (NUM_RE.test(tok)) return Number(tok);
          const r = /^(\d+)#([0-9a-zA-Z]+)$/.exec(tok);
          if (r) {
            const v = parseInt(r[2], Number(r[1]));
            if (Number.isFinite(v)) return v;
          }
          return new PsName(tok, false);
        }
      }
    }
  }

  private depth = 0;
  private readProc(): PsArr {
    const items: V[] = [];
    if (this.depth > 200) return new PsArr(items, true);
    this.depth++;
    for (;;) {
      const t = this.next();
      if (t === EOF || t === CLOSE) break;
      items.push(t);
    }
    this.depth--;
    return new PsArr(items, true);
  }
}

function latin(b: Uint8Array, s: number, e: number): string {
  if (e - s < 64) {
    let r = "";
    for (let i = s; i < e; i++) r += String.fromCharCode(b[i]);
    return r;
  }
  return String.fromCharCode(...b.subarray(s, e));
}

/** ASCII85 → bytes (whitespace skipped, `z` = four zeros, partial last group handled). */
export function ascii85(b: Uint8Array, start: number, end: number): Uint8Array {
  const out: number[] = [];
  const g = [0, 0, 0, 0, 0];
  let n = 0;
  for (let i = start; i < end; i++) {
    const c = b[i];
    if (WS[c]) continue;
    if (c === 0x7a && n === 0) {
      out.push(0, 0, 0, 0);
      continue;
    }
    if (c < 0x21 || c > 0x75) continue;
    g[n++] = c - 33;
    if (n === 5) {
      const v = (((g[0] * 85 + g[1]) * 85 + g[2]) * 85 + g[3]) * 85 + g[4];
      out.push((v / 16777216) & 255, (v / 65536) & 255, (v / 256) & 255, v & 255);
      n = 0;
    }
  }
  if (n > 1) {
    for (let k = n; k < 5; k++) g[k] = 84;
    const v = (((g[0] * 85 + g[1]) * 85 + g[2]) * 85 + g[3]) * 85 + g[4];
    const bytes = [(v / 16777216) & 255, (v / 65536) & 255, (v / 256) & 255, v & 255];
    for (let k = 0; k < n - 1; k++) out.push(bytes[k]);
  }
  return Uint8Array.from(out);
}

function runLengthDecode(src: Uint8Array): Uint8Array {
  const out: number[] = [];
  let i = 0;
  while (i < src.length) {
    const n = src[i++];
    if (n === 128) break;
    if (n < 128) for (let k = 0; k <= n && i < src.length; k++) out.push(src[i++]);
    else {
      const v = src[i++];
      for (let k = 0; k < 257 - n; k++) out.push(v);
    }
  }
  return Uint8Array.from(out);
}

/* -------------------------------- interpreter ----------------------------- */

export interface InterpOptions {
  /** Mapped to the output: points → world mm, relative to this origin. */
  originX: number;
  originY: number;
  maxEntities: number;
  maxOps: number;
  /** Skip the (AGM) prolog and start executing here. */
  startAt?: number;
}

export interface InterpResult {
  entities: Entity[];
  unsupported: Map<string, number>;
  /** Clip regions that don't cover the page (their cropping is not applied). */
  croppingClips: number;
  errors: number;
  truncated: boolean;
  budgetHit: boolean;
  images: number;
  texts: number;
}

const K = 25.4 / 72;
const num = (v: V): number | null => (typeof v === "number" ? v : null);

export class Interp {
  private ostack: V[] = [];
  private dstack: PsDict[] = [];
  private systemdict = new PsDict();
  private userdict = new PsDict();
  private gs: Gs = newGs();
  private gstack: Gs[] = [];
  private path: SubPath[] = [];
  private cur: SubPath | null = null;
  private pt: { x: number; y: number } | null = null;
  private out: Entity[] = [];
  private unsupported = new Map<string, number>();
  private ops = 0;
  private errors = 0;
  private truncated = false;
  private clips: [number, number, number, number][] = [];
  private lastFill: { sig: string; ents: Entity[] } | null = null;
  private resources = new Map<string, V>();
  private hiddenFilters = new Map<string, PsFile>();
  private scanner: Scanner;
  private images = 0;
  private texts = 0;
  private depth = 0;
  private halted = false;
  private readonly pageW: number;
  private readonly pageH: number;

  constructor(private bytes: Uint8Array, private o: InterpOptions, page: { w: number; h: number }) {
    this.pageW = page.w;
    this.pageH = page.h;
    this.dstack = [this.systemdict, this.userdict];
    this.scanner = new Scanner(bytes, o.startAt ?? 0, bytes.length, (n) => this.lookup(n) ?? new PsName(n, false));
    this.defineOps();
  }

  /* ------------------------------ plumbing ------------------------------ */

  private pop(): V {
    if (!this.ostack.length) throw new PsError("stackunderflow");
    return this.ostack.pop() as V;
  }
  private push(v: V): void {
    if (this.ostack.length > 500_000) throw new PsError("stackoverflow");
    this.ostack.push(v);
  }
  private popNum(): number {
    const v = this.pop();
    if (typeof v !== "number") throw new PsError("typecheck");
    return v;
  }
  private popArr(): PsArr {
    const v = this.pop();
    if (!(v instanceof PsArr)) throw new PsError("typecheck");
    return v;
  }
  private popNums(n: number): number[] {
    const r: number[] = new Array(n);
    for (let i = n - 1; i >= 0; i--) r[i] = this.popNum();
    return r;
  }
  private lookup(name: string): V | undefined {
    for (let i = this.dstack.length - 1; i >= 0; i--) {
      const v = this.dstack[i].m.get(name);
      if (v !== undefined) return v;
    }
    return undefined;
  }
  private keyOf(v: V): string {
    if (v instanceof PsName) return v.s;
    if (v instanceof PsStr) return v.s;
    if (typeof v === "number") return "#" + v;
    throw new PsError("typecheck");
  }
  private op(name: string, fn: () => void): void {
    this.systemdict.m.set(name, new PsOp(name, fn));
  }
  private alias(name: string, target: string): void {
    const t = this.systemdict.m.get(target);
    if (t) this.systemdict.m.set(name, t);
  }
  private unknown(name: string): void {
    this.unsupported.set(name, (this.unsupported.get(name) ?? 0) + 1);
  }

  private tick(): void {
    if (++this.ops > this.o.maxOps) throw new BudgetExceeded();
  }

  /** Executes one token as it appears in source: executable names run, everything else is pushed. */
  private execToken(t: V): void {
    this.tick();
    if (t instanceof PsName && !t.lit) {
      const v = this.lookup(t.s);
      if (v === undefined) {
        this.unknown(t.s);
        return;
      }
      this.callValue(v);
    } else this.push(t);
  }

  private callValue(v: V): void {
    if (v instanceof PsOp) v.fn();
    else if (v instanceof PsArr && v.exec) this.runProc(v);
    else if (v instanceof PsName && !v.lit) {
      const w = this.lookup(v.s);
      if (w === undefined) this.unknown(v.s);
      else if (w !== v) this.callValue(w);
    } else this.push(v);
  }

  private runProc(p: PsArr): void {
    if (++this.depth > 150) {
      this.depth--;
      throw new PsError("execstackoverflow");
    }
    try {
      for (let i = 0; i < p.a.length; i++) this.execToken(p.a[i]);
    } finally {
      this.depth--;
    }
  }

  /** Runs to the end of the input (or until the op budget / a `showpage` stops it). */
  run(): InterpResult {
    const sc = this.scanner;
    try {
      for (;;) {
        const t = sc.next();
        if (t === EOF) break;
        if (t === CLOSE) continue;
        try {
          this.execToken(t);
        } catch (e) {
          if (e instanceof BudgetExceeded || e instanceof Halt) throw e;
          if (e instanceof PsError) {
            if (++this.errors > 5000) break;
          } else if (!(e instanceof ExitSignal) && !(e instanceof StopSignal)) throw e;
        }
      }
    } catch (e) {
      if (!(e instanceof BudgetExceeded) && !(e instanceof Halt)) throw e;
    }
    const budgetHit = this.ops > this.o.maxOps;
    const cropping = this.clips.filter((c) => c[0] > 1 || c[1] > 1 || c[2] < this.pageW - 1 || c[3] < this.pageH - 1).length;
    return { entities: this.out, unsupported: this.unsupported, croppingClips: cropping, errors: this.errors, truncated: this.truncated, budgetHit, images: this.images, texts: this.texts };
  }

  /* ------------------------------- geometry ------------------------------ */

  private tf = (x: number, y: number): Point => ({ x: (x - this.o.originX) * K, y: (y - this.o.originY) * K });

  private userToDev(x: number, y: number): [number, number] {
    return mapPt(this.gs.ctm, x, y);
  }

  private moveTo(dx: number, dy: number): void {
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) throw new PsError("undefinedresult");
    this.cur = { x0: dx, y0: dy, segs: [], closed: false };
    this.path.push(this.cur);
    this.pt = { x: dx, y: dy };
  }
  private lineTo(dx: number, dy: number): void {
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) throw new PsError("undefinedresult");
    if (!this.pt || !this.cur) throw new PsError("nocurrentpoint");
    this.cur.segs.push({ k: "L", x: dx, y: dy });
    this.pt = { x: dx, y: dy };
  }
  private curveTo(x1: number, y1: number, x2: number, y2: number, x3: number, y3: number): void {
    if (![x1, y1, x2, y2, x3, y3].every(Number.isFinite)) throw new PsError("undefinedresult");
    if (!this.pt || !this.cur) throw new PsError("nocurrentpoint");
    this.cur.segs.push({ k: "C", x1, y1, x2, y2, x3, y3 });
    this.pt = { x: x3, y: y3 };
  }
  private closePath(): void {
    if (!this.cur) return;
    this.cur.closed = true;
    this.pt = { x: this.cur.x0, y: this.cur.y0 };
    // PostScript starts the next segment from the subpath start; a following lineto without moveto continues there
    const next: SubPath = { x0: this.cur.x0, y0: this.cur.y0, segs: [], closed: false };
    this.cur = next;
    this.path.push(next);
  }
  private newPath(): void {
    this.path = [];
    this.cur = null;
    this.pt = null;
  }

  private arc(cx: number, cy: number, r: number, a1: number, a2: number, ccw: boolean): void {
    let s = (a1 * Math.PI) / 180;
    let e = (a2 * Math.PI) / 180;
    if (ccw) while (e < s) e += 2 * Math.PI;
    else while (e > s) e -= 2 * Math.PI;
    const total = e - s;
    const n = Math.max(1, Math.ceil(Math.abs(total) / (Math.PI / 2) - 1e-9));
    const step = total / n;
    const kk = (4 / 3) * Math.tan(step / 4);
    const [sx, sy] = this.userToDev(cx + r * Math.cos(s), cy + r * Math.sin(s));
    if (this.pt) this.lineTo(sx, sy);
    else this.moveTo(sx, sy);
    for (let i = 0; i < n; i++) {
      const a = s + i * step;
      const b = a + step;
      const p1 = this.userToDev(cx + r * (Math.cos(a) - kk * Math.sin(a)), cy + r * (Math.sin(a) + kk * Math.cos(a)));
      const p2 = this.userToDev(cx + r * (Math.cos(b) + kk * Math.sin(b)), cy + r * (Math.sin(b) - kk * Math.cos(b)));
      const p3 = this.userToDev(cx + r * Math.cos(b), cy + r * Math.sin(b));
      this.curveTo(p1[0], p1[1], p2[0], p2[1], p3[0], p3[1]);
    }
  }

  private nonEmptySubs(): SubPath[] {
    return this.path.filter((s) => s.segs.length > 0);
  }

  /* -------------------------------- painting ----------------------------- */

  private add(list: Entity[]): void {
    for (const e of list) {
      if (this.out.length >= this.o.maxEntities) {
        this.truncated = true;
        throw new Halt();
      }
      this.out.push(e);
    }
  }

  private paintStyle(): { css: string; plain: boolean } {
    return { css: rgbToCss(this.gs.color), plain: isBlackRgb(this.gs.color) };
  }

  private doFill(): void {
    const subs = this.nonEmptySubs();
    this.newPath();
    if (!subs.length) return;
    const { css, plain } = this.paintStyle();
    const st = { layer: this.gs.layer, ...(plain ? {} : { color: css }) };
    const made: Entity[] = [];
    const pure = subs.length === 1 && this.singlePureClosed(subs[0]);
    if (pure) made.push(...subpathToEntities(subs[0], this.tf, st, true, css));
    else {
      for (const sp of subs) made.push(...subpathToEntities(sp, this.tf, st, true));
      const h = subpathsToHatch(subs, this.tf, css, this.gs.layer);
      if (h) made.push(h);
    }
    this.add(made);
    this.lastFill = { sig: pathSignature(subs), ents: made.filter((e) => e.type !== "hatch") };
  }

  private singlePureClosed(sp: SubPath): boolean {
    const kind = pureKind(sp);
    if (kind === "L") return sp.segs.length >= 2;
    if (kind === "C") {
      const l = sp.segs[sp.segs.length - 1] as Extract<PSeg, { k: "C" }>;
      return Math.hypot(l.x3 - sp.x0, l.y3 - sp.y0) < 1e-6;
    }
    return false;
  }

  private doStroke(): void {
    const subs = this.nonEmptySubs();
    this.newPath();
    if (!subs.length) return;
    const { css, plain } = this.paintStyle();
    const lwMm = this.gs.lw * mscale(this.gs.ctm) * K;
    const lineweight = lwMm > 0.005 ? Math.round(lwMm * 1000) / 1000 : undefined;
    let linetype: string | undefined;
    if (this.gs.dash.length) {
      const d = this.gs.dash.map((v) => Math.abs(v) * mscale(this.gs.ctm) * K);
      if (d.some((v) => v > 0)) linetype = nearestLinetype(d.length % 2 ? [...d, ...d] : d);
    }
    const st = { layer: this.gs.layer, ...(plain ? {} : { color: css }), ...(lineweight !== undefined ? { lineweight } : {}), ...(linetype ? { linetype } : {}) };
    const sig = pathSignature(subs);
    if (this.lastFill && this.lastFill.sig === sig) {
      // the stroke half of "fill then stroke the same path": restyle, don't duplicate
      for (const e of this.lastFill.ents) {
        const r = e as Entity & { color?: string; lineweight?: number; linetype?: string };
        if (plain) delete r.color;
        else r.color = css;
        if (lineweight !== undefined) r.lineweight = lineweight;
        if (linetype) r.linetype = linetype;
      }
      this.lastFill = null;
      return;
    }
    this.lastFill = null;
    const made: Entity[] = [];
    for (const sp of subs) made.push(...subpathToEntities(sp, this.tf, st, sp.closed));
    this.add(made);
  }

  private recordClip(): void {
    const subs = this.nonEmptySubs();
    if (!subs.length) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const grow = (x: number, y: number) => {
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (x > x1) x1 = x;
      if (y > y1) y1 = y;
    };
    for (const sp of subs) {
      grow(sp.x0, sp.y0);
      for (const s of sp.segs) s.k === "L" ? grow(s.x, s.y) : (grow(s.x1, s.y1), grow(s.x2, s.y2), grow(s.x3, s.y3));
    }
    const b: [number, number, number, number] = [x0 - this.o.originX, y0 - this.o.originY, x1 - this.o.originX, y1 - this.o.originY];
    this.clips.push(b);
    if (this.clips.length > 10_000) this.clips.shift();
  }

  private showText(s: string): void {
    const t = s.replace(/[\x00-\x08\x0b-\x1f]/g, "");
    if (!this.pt) return;
    const m = mmul(this.gs.fontMatrix, this.gs.ctm);
    const size = Math.hypot(m[0], m[1]);
    const adv = t.length * size * 0.5;
    const rot = Math.atan2(m[1], m[0]);
    const trimmed = t.trim();
    if (trimmed && size > 1e-6 && this.out.length < this.o.maxEntities) {
      const lead = t.length - t.trimStart().length;
      const at = this.tf(this.pt.x + Math.cos(rot) * lead * size * 0.5, this.pt.y + Math.sin(rot) * lead * size * 0.5);
      const { css, plain } = this.paintStyle();
      const e: TextEntity = { id: newEntityId(), type: "text", at, text: trimmed, height: size * K, rotation: rot };
      if (this.gs.layer) e.layer = this.gs.layer;
      if (!plain) e.color = css;
      this.add([e]);
      this.texts++;
    }
    this.pt = { x: this.pt.x + Math.cos(rot) * adv, y: this.pt.y + Math.sin(rot) * adv };
  }

  /* ---------------------------------- images ----------------------------- */

  private doImage(d: PsDict): void {
    const g = (k: string) => d.m.get(k);
    const W = num(g("W") ?? null) ?? 0;
    const H = num(g("H") ?? null) ?? 0;
    const bc = num(g("BC") ?? null) ?? 8;
    const dec = g("D");
    const comps = dec instanceof PsArr ? Math.max(1, dec.a.length >> 1) : 1;
    const ds = g("DS");
    const sources = ds instanceof PsArr ? Math.max(1, ds.a.length) : 1;
    const mAttr = g("M");
    const mDet = mAttr instanceof PsArr && mAttr.a.length >= 4 ? (num(mAttr.a[3]) ?? -1) : -1;
    const sc = this.scanner;
    const filt = this.hiddenFilters.get("AGMIMG_fl")?.filters ?? ["ASCII85Decode", "RunLengthDecode"];
    if (W <= 0 || H <= 0 || bc !== 8 || W * H > 80_000_000) {
      this.unknown("img(unsupported depth/size)");
      return;
    }
    // Encoded bytes follow the operator.
    let data: Uint8Array;
    const b = this.bytes;
    if (filt[0] === "ASCII85Decode") {
      let q = sc.p;
      while (q < sc.end && WS[b[q]]) q++;
      const e = indexOfStr(b, "~>", q, sc.end);
      data = ascii85(b, q, e < 0 ? sc.end : e);
      sc.p = e < 0 ? sc.end : e + 2;
    } else if (filt[0] === "ASCIIHexDecode") {
      let q = sc.p;
      const e = b.indexOf(0x3e, q);
      const stop = e < 0 ? sc.end : e;
      const out: number[] = [];
      let hi = -1;
      for (; q < stop; q++) {
        const c = b[q];
        const v = c >= 0x30 && c <= 0x39 ? c - 0x30 : c >= 0x41 && c <= 0x46 ? c - 0x37 : c >= 0x61 && c <= 0x66 ? c - 0x57 : -1;
        if (v < 0) continue;
        if (hi < 0) hi = v;
        else {
          out.push(hi * 16 + v);
          hi = -1;
        }
      }
      data = Uint8Array.from(out);
      sc.p = e < 0 ? sc.end : e + 1;
    } else {
      this.unknown(`img(${filt[0]})`);
      return;
    }
    for (const f of filt.slice(1)) {
      if (f === "RunLengthDecode") data = runLengthDecode(data);
      else {
        this.unknown(`img(${f})`);
        return;
      }
    }
    const need = W * H * comps;
    if (data.length < need) {
      const grown = new Uint8Array(need);
      grown.set(data);
      data = grown;
    }
    const rgba = new Uint8Array(W * H * 4);
    const planar = sources > 1 && comps > 1;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const at = (c: number): number => (planar ? data[y * W * comps + c * W + x] : data[(y * W + x) * comps + c]) / 255;
        let rgb: Rgb;
        if (comps === 4) rgb = cmykToRgb(at(0), at(1), at(2), at(3));
        else if (comps === 3) rgb = [at(0), at(1), at(2)];
        else {
          const v = at(0);
          rgb = [v, v, v];
        }
        const o = (y * W + x) * 4;
        rgba[o] = rgb[0] * 255;
        rgba[o + 1] = rgb[1] * 255;
        rgba[o + 2] = rgb[2] * 255;
        rgba[o + 3] = 255;
      }
    }
    const ctm = this.gs.ctm;
    const det = ctm[0] * ctm[3] - ctm[1] * ctm[2];
    const rowZeroTop = mDet < 0;
    const flipRows = det > 0 !== rowZeroTop;
    let img: RgbaImage = { width: W, height: H, rgba };
    if (flipRows) {
      const f = new Uint8Array(rgba.length);
      for (let y = 0; y < H; y++) f.set(rgba.subarray(y * W * 4, (y + 1) * W * 4), (H - 1 - y) * W * 4);
      img = { width: W, height: H, rgba: f };
    }
    img = downscale(img, 1024);
    const [ix, iy] = det > 0 ? mapPt(ctm, 0, 0) : mapPt(ctm, 0, 1);
    const e: ImageEntity = {
      id: newEntityId(),
      type: "image",
      insert: this.tf(ix, iy),
      width: Math.hypot(ctm[0], ctm[1]) * K,
      height: Math.hypot(ctm[2], ctm[3]) * K,
      rotation: Math.atan2(ctm[1], ctm[0]),
      dataUrl: rgbaToPngDataUrl(img.width, img.height, img.rgba),
    };
    if (this.gs.layer) e.layer = this.gs.layer;
    this.add([e]);
    this.images++;
  }

  /* ---------------------------------- colour ----------------------------- */

  private setColor(rgb: Rgb, cs: Gs["cs"]): void {
    this.gs.color = rgb;
    this.gs.cs = cs;
    this.gs.spot = null;
    this.gs.layer = undefined;
  }

  /* ----------------------------------- ops ------------------------------- */

  private defineOps(): void {
    const S = this.systemdict.m;
    S.set("systemdict", this.systemdict);
    S.set("userdict", this.userdict);
    S.set("globaldict", this.userdict);
    S.set("statusdict", new PsDict());
    S.set("errordict", new PsDict());
    S.set("$error", new PsDict());
    S.set("true", true);
    S.set("false", false);
    S.set("null", null);
    S.set("languagelevel", 2);
    S.set("level2", true);
    S.set("product", new PsStr("Sketchor"));
    S.set("version", new PsStr("3010"));
    S.set("revision", 1);

    // --- stack
    this.op("pop", () => void this.pop());
    this.op("exch", () => {
      const b = this.pop();
      const a = this.pop();
      this.push(b);
      this.push(a);
    });
    this.op("dup", () => {
      const a = this.pop();
      this.push(a);
      this.push(a);
    });
    this.op("copy", () => {
      const top = this.pop();
      if (typeof top === "number") {
        const n = top;
        if (n < 0 || n > this.ostack.length) throw new PsError("rangecheck");
        this.ostack.push(...this.ostack.slice(this.ostack.length - n));
      } else if (top instanceof PsArr) {
        const src = this.popArr();
        top.a.splice(0, src.a.length, ...src.a);
        this.push(new PsArr(top.a.slice(0, src.a.length), top.exec));
      } else throw new PsError("typecheck");
    });
    this.op("index", () => {
      const n = this.popNum();
      const v = this.ostack[this.ostack.length - 1 - n];
      if (n < 0 || v === undefined) throw new PsError("rangecheck");
      this.push(v);
    });
    this.op("roll", () => {
      const j = this.popNum();
      const n = this.popNum();
      if (n < 0 || n > this.ostack.length) throw new PsError("rangecheck");
      if (n === 0) return;
      const part = this.ostack.splice(this.ostack.length - n, n);
      const sh = ((j % n) + n) % n;
      this.ostack.push(...part.slice(n - sh), ...part.slice(0, n - sh));
    });
    this.op("clear", () => void (this.ostack.length = 0));
    this.op("count", () => this.push(this.ostack.length));
    this.op("mark", () => this.push(MARK));
    this.op("[", () => this.push(MARK));
    this.op("<<", () => this.push(MARK));
    const toMark = (): V[] => {
      const i = this.ostack.lastIndexOf(MARK);
      if (i < 0) throw new PsError("unmatchedmark");
      return this.ostack.splice(i).slice(1);
    };
    this.op("]", () => this.push(new PsArr(toMark())));
    this.op(">>", () => {
      const items = toMark();
      const d = new PsDict();
      for (let i = 0; i + 1 < items.length; i += 2) d.m.set(this.keyOf(items[i]), items[i + 1]);
      this.push(d);
    });
    this.op("cleartomark", () => void toMark());
    this.op("counttomark", () => {
      const i = this.ostack.lastIndexOf(MARK);
      if (i < 0) throw new PsError("unmatchedmark");
      this.push(this.ostack.length - 1 - i);
    });
    this.op("pdfmark", () => {
      if (this.ostack.includes(MARK)) toMark();
    });

    // --- arithmetic
    const bin = (name: string, f: (a: number, b: number) => number) =>
      this.op(name, () => {
        const b = this.popNum();
        const a = this.popNum();
        this.push(f(a, b));
      });
    const un = (name: string, f: (a: number) => number) => this.op(name, () => this.push(f(this.popNum())));
    bin("add", (a, b) => a + b);
    bin("sub", (a, b) => a - b);
    bin("mul", (a, b) => a * b);
    bin("div", (a, b) => (b === 0 ? NaN : a / b));
    bin("idiv", (a, b) => (b === 0 ? NaN : Math.trunc(a / b)));
    bin("mod", (a, b) => (b === 0 ? NaN : a % b));
    bin("exp", (a, b) => Math.pow(a, b));
    bin("atan", (a, b) => {
      const d = (Math.atan2(a, b) * 180) / Math.PI;
      return d < 0 ? d + 360 : d;
    });
    bin("max", Math.max);
    bin("min", Math.min);
    bin("bitshift", (a, s) => (s >= 0 ? a << s : a >> -s));
    un("neg", (a) => -a);
    un("abs", Math.abs);
    un("sqrt", Math.sqrt);
    un("ln", Math.log);
    un("log", Math.log10);
    un("sin", (a) => Math.sin((a * Math.PI) / 180));
    un("cos", (a) => Math.cos((a * Math.PI) / 180));
    un("ceiling", Math.ceil);
    un("floor", Math.floor);
    un("round", (a) => Math.floor(a + 0.5));
    un("truncate", Math.trunc);
    un("cvi", Math.trunc);
    un("cvr", (a) => a);
    this.op("rand", () => this.push(Math.floor(Math.random() * 2147483647)));
    this.op("srand", () => void this.pop());
    this.op("realtime", () => this.push(0));
    this.op("usertime", () => this.push(0));

    // --- relational / logic
    const eq = (a: V, b: V): boolean => {
      if (typeof a === "number" && typeof b === "number") return a === b;
      const sa = a instanceof PsName || a instanceof PsStr ? a.s : undefined;
      const sb = b instanceof PsName || b instanceof PsStr ? b.s : undefined;
      if (sa !== undefined && sb !== undefined) return sa === sb;
      return a === b;
    };
    this.op("eq", () => {
      const b = this.pop();
      this.push(eq(this.pop(), b));
    });
    this.op("ne", () => {
      const b = this.pop();
      this.push(!eq(this.pop(), b));
    });
    const cmp = (name: string, f: (c: number) => boolean) =>
      this.op(name, () => {
        const b = this.pop();
        const a = this.pop();
        if (typeof a === "number" && typeof b === "number") this.push(f(a - b));
        else if (a instanceof PsStr && b instanceof PsStr) this.push(f(a.s < b.s ? -1 : a.s > b.s ? 1 : 0));
        else throw new PsError("typecheck");
      });
    cmp("gt", (c) => c > 0);
    cmp("ge", (c) => c >= 0);
    cmp("lt", (c) => c < 0);
    cmp("le", (c) => c <= 0);
    const logic = (name: string, fb: (a: boolean, b: boolean) => boolean, fi: (a: number, b: number) => number) =>
      this.op(name, () => {
        const b = this.pop();
        const a = this.pop();
        if (typeof a === "boolean" && typeof b === "boolean") this.push(fb(a, b));
        else if (typeof a === "number" && typeof b === "number") this.push(fi(a, b));
        else throw new PsError("typecheck");
      });
    logic("and", (a, b) => a && b, (a, b) => a & b);
    logic("or", (a, b) => a || b, (a, b) => a | b);
    logic("xor", (a, b) => a !== b, (a, b) => a ^ b);
    this.op("not", () => {
      const a = this.pop();
      if (typeof a === "boolean") this.push(!a);
      else if (typeof a === "number") this.push(~a);
      else throw new PsError("typecheck");
    });

    // --- control
    const runP = (p: V): void => {
      if (p instanceof PsArr) this.runProc(p);
      else this.callValue(p);
    };
    this.op("if", () => {
      const p = this.pop();
      const c = this.pop();
      if (c === true) runP(p);
    });
    this.op("ifelse", () => {
      const f = this.pop();
      const t = this.pop();
      const c = this.pop();
      runP(c === true ? t : f);
    });
    this.op("exec", () => this.callValue(this.pop()));
    this.op("for", () => {
      const p = this.pop();
      const lim = this.popNum();
      const inc = this.popNum();
      const init = this.popNum();
      if (inc === 0) return;
      try {
        for (let i = init; inc > 0 ? i <= lim : i >= lim; i += inc) {
          this.tick();
          this.push(i);
          runP(p);
        }
      } catch (e) {
        if (!(e instanceof ExitSignal)) throw e;
      }
    });
    this.op("repeat", () => {
      const p = this.pop();
      const n = this.popNum();
      try {
        for (let i = 0; i < n; i++) {
          this.tick();
          runP(p);
        }
      } catch (e) {
        if (!(e instanceof ExitSignal)) throw e;
      }
    });
    this.op("loop", () => {
      const p = this.pop();
      try {
        for (;;) {
          this.tick();
          runP(p);
        }
      } catch (e) {
        if (!(e instanceof ExitSignal)) throw e;
      }
    });
    this.op("forall", () => {
      const p = this.pop();
      const c = this.pop();
      try {
        if (c instanceof PsArr) for (const v of c.a.slice()) { this.tick(); this.push(v); runP(p); }
        else if (c instanceof PsStr) for (let i = 0; i < c.s.length; i++) { this.push(c.s.charCodeAt(i)); runP(p); }
        else if (c instanceof PsDict) for (const [k, v] of [...c.m]) { this.push(new PsName(k, true)); this.push(v); runP(p); }
      } catch (e) {
        if (!(e instanceof ExitSignal)) throw e;
      }
    });
    this.op("exit", () => {
      throw new ExitSignal();
    });
    this.op("stop", () => {
      throw new StopSignal();
    });
    this.op("stopped", () => {
      const p = this.pop();
      const depth = this.depth;
      try {
        runP(p);
        this.push(false);
      } catch (e) {
        if (e instanceof StopSignal || e instanceof PsError) {
          this.depth = depth;
          this.push(true);
        } else throw e;
      }
    });
    this.op("quit", () => {
      throw new Halt();
    });
    this.op("bind", () => {});
    for (const n of ["readonly", "executeonly", "noaccess", "makereadonlyarray", "currentpacking", "setpacking"]) this.op(n, () => {});
    this.op("currentpacking", () => this.push(false));
    this.op("setpacking", () => void this.pop());
    this.op("cvx", () => {
      const v = this.pop();
      this.push(v instanceof PsArr ? new PsArr(v.a, true) : v instanceof PsName ? new PsName(v.s, false) : v);
    });
    this.op("cvlit", () => {
      const v = this.pop();
      this.push(v instanceof PsArr ? new PsArr(v.a, false) : v instanceof PsName ? new PsName(v.s, true) : v);
    });
    this.op("xcheck", () => {
      const v = this.pop();
      this.push((v instanceof PsArr && v.exec) || (v instanceof PsName && !v.lit) || v instanceof PsOp);
    });
    this.op("type", () => {
      const v = this.pop();
      const t =
        typeof v === "number" ? (Number.isInteger(v) ? "integertype" : "realtype") : typeof v === "boolean" ? "booleantype" : v === null ? "nulltype" : v instanceof PsName ? "nametype" : v instanceof PsStr ? "stringtype" : v instanceof PsArr ? "arraytype" : v instanceof PsDict ? "dicttype" : v instanceof PsOp ? "operatortype" : v instanceof PsFile ? "filetype" : v instanceof PsSave ? "savetype" : "marktype";
      this.push(new PsName(t, false));
    });
    this.op("cvn", () => {
      const v = this.pop();
      this.push(new PsName(v instanceof PsStr ? v.s : String(v), true));
    });
    this.op("cvs", () => {
      const buf = this.pop();
      const v = this.pop();
      const s = v instanceof PsName || v instanceof PsStr ? v.s : typeof v === "number" ? String(v) : typeof v === "boolean" ? String(v) : "--nostringval--";
      if (buf instanceof PsStr) buf.s = s + buf.s.slice(s.length);
      this.push(new PsStr(s));
    });

    // --- dictionaries / arrays / strings
    this.op("dict", () => {
      this.pop();
      this.push(new PsDict());
    });
    this.op("begin", () => {
      const d = this.pop();
      if (!(d instanceof PsDict)) throw new PsError("typecheck");
      this.dstack.push(d);
    });
    this.op("end", () => {
      if (this.dstack.length > 2) this.dstack.pop();
    });
    this.op("currentdict", () => this.push(this.dstack[this.dstack.length - 1]));
    this.op("countdictstack", () => this.push(this.dstack.length));
    this.op("def", () => {
      const v = this.pop();
      const k = this.pop();
      this.dstack[this.dstack.length - 1].m.set(this.keyOf(k), v);
    });
    this.op("load", () => {
      const k = this.keyOf(this.pop());
      const v = this.lookup(k);
      if (v === undefined) throw new PsError("undefined");
      this.push(v);
    });
    this.op("store", () => {
      const v = this.pop();
      const k = this.keyOf(this.pop());
      for (let i = this.dstack.length - 1; i >= 0; i--) {
        if (this.dstack[i].m.has(k)) {
          this.dstack[i].m.set(k, v);
          return;
        }
      }
      this.dstack[this.dstack.length - 1].m.set(k, v);
    });
    this.op("where", () => {
      const k = this.keyOf(this.pop());
      for (let i = this.dstack.length - 1; i >= 0; i--) {
        if (this.dstack[i].m.has(k)) {
          this.push(this.dstack[i]);
          this.push(true);
          return;
        }
      }
      this.push(false);
    });
    this.op("known", () => {
      const k = this.keyOf(this.pop());
      const d = this.pop();
      this.push(d instanceof PsDict && d.m.has(k));
    });
    this.op("undef", () => {
      const k = this.keyOf(this.pop());
      const d = this.pop();
      if (d instanceof PsDict) d.m.delete(k);
    });
    this.op("array", () => {
      const n = this.popNum();
      if (n < 0 || n > 10_000_000) throw new PsError("rangecheck");
      this.push(new PsArr(new Array<V>(n).fill(null)));
    });
    this.op("string", () => {
      const n = this.popNum();
      if (n < 0 || n > 10_000_000) throw new PsError("rangecheck");
      this.push(new PsStr("\0".repeat(n)));
    });
    this.op("length", () => {
      const v = this.pop();
      this.push(v instanceof PsArr ? v.a.length : v instanceof PsStr ? v.s.length : v instanceof PsName ? v.s.length : v instanceof PsDict ? v.m.size : 0);
    });
    this.op("get", () => {
      const k = this.pop();
      const c = this.pop();
      if (c instanceof PsArr && typeof k === "number") {
        const v = c.a[k];
        if (v === undefined) throw new PsError("rangecheck");
        this.push(v);
      } else if (c instanceof PsStr && typeof k === "number") {
        if (k < 0 || k >= c.s.length) throw new PsError("rangecheck");
        this.push(c.s.charCodeAt(k));
      } else if (c instanceof PsDict) {
        const v = c.m.get(this.keyOf(k));
        if (v === undefined) throw new PsError("undefined");
        this.push(v);
      } else throw new PsError("typecheck");
    });
    this.op("put", () => {
      const v = this.pop();
      const k = this.pop();
      const c = this.pop();
      if (c instanceof PsArr && typeof k === "number") c.a[k] = v;
      else if (c instanceof PsStr && typeof k === "number" && typeof v === "number") c.s = c.s.slice(0, k) + String.fromCharCode(v) + c.s.slice(k + 1);
      else if (c instanceof PsDict) c.m.set(this.keyOf(k), v);
    });
    this.op("getinterval", () => {
      const n = this.popNum();
      const i = this.popNum();
      const c = this.pop();
      if (c instanceof PsArr) this.push(new PsArr(c.a.slice(i, i + n), c.exec));
      else if (c instanceof PsStr) this.push(new PsStr(c.s.slice(i, i + n)));
      else throw new PsError("typecheck");
    });
    this.op("putinterval", () => {
      const src = this.pop();
      const i = this.popNum();
      const dst = this.pop();
      if (dst instanceof PsArr && src instanceof PsArr) dst.a.splice(i, src.a.length, ...src.a);
      else if (dst instanceof PsStr && src instanceof PsStr) dst.s = dst.s.slice(0, i) + src.s + dst.s.slice(i + src.s.length);
    });
    this.op("aload", () => {
      const a = this.popArr();
      for (const v of a.a) this.push(v);
      this.push(a);
    });
    this.op("astore", () => {
      const a = this.popArr();
      for (let i = a.a.length - 1; i >= 0; i--) a.a[i] = this.pop();
      this.push(a);
    });

    // --- misc no-ops / environment
    this.op("save", () => this.push(new PsSave(cloneGs(this.gs), this.gstack.length)));
    this.op("restore", () => {
      const s = this.pop();
      if (s instanceof PsSave) {
        this.gs = cloneGs(s.gs);
        this.gstack.length = Math.min(this.gstack.length, s.depth);
      }
    });
    this.op("currentglobal", () => this.push(false));
    this.op("setglobal", () => void this.pop());
    this.op("vmstatus", () => (this.push(0), this.push(1e7), this.push(1e8)));
    this.op("currentfile", () => this.push(new PsFile()));
    this.op("flush", () => {});
    this.op("flushfile", () => void this.pop());
    this.op("closefile", () => void this.pop());
    this.op("print", () => void this.pop());
    this.op("=", () => void this.pop());
    this.op("==", () => void this.pop());
    this.op("pstack", () => {});
    this.op("showpage", () => {
      throw new Halt();
    });
    this.op("copypage", () => {});
    this.op("erasepage", () => {});
    this.op("initclip", () => {});
    this.op("flattenpath", () => {});
    this.op("readline", () => {
      const buf = this.pop();
      const f = this.pop();
      if (!(buf instanceof PsStr) || !(f instanceof PsFile)) throw new PsError("typecheck");
      const sc = this.scanner;
      if (sc.p >= sc.end) {
        this.push(new PsStr(""));
        this.push(false);
        return;
      }
      let q = sc.p;
      while (q < sc.end && this.bytes[q] !== 10 && this.bytes[q] !== 13) q++;
      const line = latin(this.bytes, sc.p, Math.min(q, sc.p + buf.s.length));
      if (this.bytes[q] === 13 && this.bytes[q + 1] === 10) q++;
      sc.p = Math.min(sc.end, q + 1);
      this.push(new PsStr(line));
      this.push(true);
    });
    this.op("readstring", () => {
      const buf = this.pop();
      this.pop();
      if (!(buf instanceof PsStr)) throw new PsError("typecheck");
      this.push(new PsStr(buf.s));
      this.push(false);
    });
    this.op("eexec", () => {
      this.pop();
      this.unknown("eexec (embedded font data skipped)");
      const sc = this.scanner;
      const e = indexOfStr(this.bytes, "cleartomark", sc.p, sc.end);
      sc.p = e < 0 ? sc.end : e + 11;
    });
    for (const [n, c] of Object.entries({
      setlinecap: 1, setlinejoin: 1, setmiterlimit: 1, setflat: 1, setstrokeadjust: 1, setoverprint: 1, setsmoothness: 1, setscreen: 3,
      setcolorscreen: 12, sethalftone: 1, settransfer: 1, setcolortransfer: 4, setblackgeneration: 1, setundercolorremoval: 1,
      setcolorrendering: 1, setpagedevice: 1, setuserparams: 1, setsystemparams: 1, setdevparams: 2, setcachelimit: 1,
    })) {
      this.op(n, () => {
        for (let i = 0; i < c; i++) this.pop();
      });
    }
    this.alias("lc", "setlinecap");
    this.alias("lj", "setlinejoin");
    this.alias("ml", "setmiterlimit");
    this.alias("sadj", "setstrokeadjust");
    this.alias("sop", "setoverprint");

    // --- matrices / CTM
    const getM = (a: PsArr): Mat => {
      const n = a.a.map((v) => (typeof v === "number" ? v : 0));
      return [n[0] ?? 1, n[1] ?? 0, n[2] ?? 0, n[3] ?? 1, n[4] ?? 0, n[5] ?? 0];
    };
    const setM = (a: PsArr, m: Mat): void => void (a.a = [...m]);
    this.op("matrix", () => this.push(new PsArr([1, 0, 0, 1, 0, 0])));
    this.op("identmatrix", () => {
      const a = this.popArr();
      setM(a, IDENT);
      this.push(a);
    });
    this.op("concat", () => {
      const m = getM(this.popArr());
      this.gs.ctm = mmul(m, this.gs.ctm);
    });
    this.alias("ct", "concat");
    this.op("concatmatrix", () => {
      const c = this.popArr();
      const b = getM(this.popArr());
      const a = getM(this.popArr());
      setM(c, mmul(a, b));
      this.push(c);
    });
    this.op("currentmatrix", () => {
      const a = this.popArr();
      setM(a, this.gs.ctm);
      this.push(a);
    });
    this.op("defaultmatrix", () => {
      const a = this.popArr();
      setM(a, IDENT);
      this.push(a);
    });
    this.op("setmatrix", () => {
      this.gs.ctm = getM(this.popArr());
    });
    this.op("initmatrix", () => {
      this.gs.ctm = [...IDENT] as Mat;
    });
    this.op("invertmatrix", () => {
      const dst = this.popArr();
      const m = minv(getM(this.popArr())) ?? IDENT;
      setM(dst, m);
      this.push(dst);
    });
    this.op("translate", () => {
      const top = this.ostack[this.ostack.length - 1];
      if (top instanceof PsArr) {
        const m = this.popArr();
        const [ty, tx] = [this.popNum(), this.popNum()];
        setM(m, [1, 0, 0, 1, tx, ty]);
        this.push(m);
        return;
      }
      const ty = this.popNum();
      const tx = this.popNum();
      this.gs.ctm = mmul([1, 0, 0, 1, tx, ty], this.gs.ctm);
    });
    this.op("scale", () => {
      const top = this.ostack[this.ostack.length - 1];
      if (top instanceof PsArr) {
        const m = this.popArr();
        const [sy, sx] = [this.popNum(), this.popNum()];
        setM(m, [sx, 0, 0, sy, 0, 0]);
        this.push(m);
        return;
      }
      const sy = this.popNum();
      const sx = this.popNum();
      this.gs.ctm = mmul([sx, 0, 0, sy, 0, 0], this.gs.ctm);
    });
    this.op("rotate", () => {
      const a = (this.popNum() * Math.PI) / 180;
      const c = Math.cos(a);
      const s = Math.sin(a);
      this.gs.ctm = mmul([c, s, -s, c, 0, 0], this.gs.ctm);
    });
    this.op("transform", () => {
      const y = this.popNum();
      const x = this.popNum();
      const [a, b] = this.userToDev(x, y);
      this.push(a);
      this.push(b);
    });
    this.op("itransform", () => {
      const y = this.popNum();
      const x = this.popNum();
      const inv = minv(this.gs.ctm);
      const [a, b] = inv ? mapPt(inv, x, y) : [x, y];
      this.push(a);
      this.push(b);
    });
    this.op("dtransform", () => {
      const y = this.popNum();
      const x = this.popNum();
      const m = this.gs.ctm;
      this.push(m[0] * x + m[2] * y);
      this.push(m[1] * x + m[3] * y);
    });
    this.op("idtransform", () => {
      const y = this.popNum();
      const x = this.popNum();
      const inv = minv(this.gs.ctm);
      this.push(inv ? inv[0] * x + inv[2] * y : x);
      this.push(inv ? inv[1] * x + inv[3] * y : y);
    });

    // --- graphics state
    this.op("gsave", () => {
      if (this.gstack.length < 1000) this.gstack.push(cloneGs(this.gs));
    });
    this.op("grestore", () => {
      const g = this.gstack.pop();
      if (g) this.gs = g;
    });
    this.op("grestoreall", () => {
      if (this.gstack.length) this.gs = this.gstack[0];
      this.gstack.length = 0;
    });
    this.op("initgraphics", () => {
      this.gs = newGs();
      this.newPath();
    });
    this.op("setlinewidth", () => {
      this.gs.lw = Math.abs(this.popNum());
    });
    this.alias("lw", "setlinewidth");
    this.op("currentlinewidth", () => this.push(this.gs.lw));
    this.op("setdash", () => {
      this.popNum();
      const a = this.popArr();
      this.gs.dash = a.a.map((v) => (typeof v === "number" ? v : 0));
    });
    this.alias("dsh", "setdash");
    this.op("setgray", () => {
      const g = this.popNum();
      this.setColor([g, g, g], "gray");
    });
    this.alias("gry", "setgray");
    this.op("setrgbcolor", () => {
      const [r, g, b] = this.popNums(3);
      this.setColor([r, g, b], "rgb");
    });
    this.alias("rgb", "setrgbcolor");
    this.op("setcmykcolor", () => {
      const [c, m, y, k] = this.popNums(4);
      this.setColor(cmykToRgb(c, m, y, k), "cmyk");
    });
    this.alias("cmyk", "setcmykcolor");
    this.op("sethsbcolor", () => {
      const [h, s, b] = this.popNums(3);
      this.setColor(hsbToRgb(h, s, b), "rgb");
    });
    this.op("setcolorspace", () => {
      const cs = this.pop();
      const n = cs instanceof PsName ? cs.s : cs instanceof PsArr && cs.a[0] instanceof PsName ? cs.a[0].s : "";
      this.gs.cs = /CMYK/.test(n) ? "cmyk" : /RGB/.test(n) ? "rgb" : /Gray/.test(n) ? "gray" : "other";
      if (this.gs.cs === "cmyk") this.gs.color = [0, 0, 0];
    });
    this.op("setcolor", () => {
      const c = this.gs.cs;
      if (c === "cmyk") {
        const [a, b, d, e] = this.popNums(4);
        this.setColor(cmykToRgb(a, b, d, e), "cmyk");
      } else if (c === "rgb") {
        const [a, b, d] = this.popNums(3);
        this.setColor([a, b, d], "rgb");
      } else {
        const g = this.popNum();
        this.setColor([g, g, g], "gray");
      }
    });
    this.op("currentgray", () => this.push(this.gs.color[0]));
    this.op("currentrgbcolor", () => this.gs.color.forEach((v) => this.push(v)));
    // AGM resource plumbing for the (skipped) colour-space prolog
    this.op("add_res", () => {
      const cat = this.keyOf(this.pop());
      const v = this.pop();
      const k = this.keyOf(this.pop());
      this.resources.set(cat + "/" + k, v);
    });
    this.op("get_res", () => {
      const cat = this.keyOf(this.pop());
      const k = this.keyOf(this.pop());
      this.push(this.resources.get(cat + "/" + k) ?? null);
    });
    this.op("get_csa_by_name", () => {
      const k = this.keyOf(this.pop());
      this.push(this.resources.get("CSA/" + k) ?? null);
    });
    this.op("del_res", () => void this.pop());
    this.op("sepcs", () => {
      const d = this.pop();
      this.pop();
      if (d instanceof PsDict) {
        const nm = d.m.get("Name");
        const comps = d.m.get("Components");
        this.gs.spot = {
          name: nm instanceof PsStr ? nm.s : nm instanceof PsName ? nm.s : "",
          comps: comps instanceof PsArr ? comps.a.map((v) => (typeof v === "number" ? v : 0)) : [0, 0, 0, 1],
        };
      }
    });
    this.op("sep", () => {
      const tint = this.popNum();
      const sp = this.gs.spot;
      if (!sp) return;
      const c = sp.comps.map((v) => v * tint);
      this.gs.color = c.length >= 4 ? cmykToRgb(c[0], c[1], c[2], c[3]) : [1 - tint, 1 - tint, 1 - tint];
      this.gs.cs = "cmyk";
      const nm = sp.name.trim();
      this.gs.layer = nm && !/^(all|none|black|cyan|magenta|yellow)$/i.test(nm) ? nm : undefined;
    });
    this.op("add_csa", () => {
      const v = this.pop();
      this.resources.set("CSA/" + this.keyOf(this.pop()), v);
    });
    this.op("add_csd", () => {
      const v = this.pop();
      this.resources.set("CSD/" + this.keyOf(this.pop()), v);
    });
    this.op("get_csd", () => this.push(this.resources.get("CSD/" + this.keyOf(this.pop())) ?? null));
    this.op("get_csa", () => this.push(this.resources.get("CSA/" + this.keyOf(this.pop())) ?? null));
    this.op("ct_VMDictPut", () => {
      this.pop();
      this.pop();
    });
    this.alias("rp", "repeat");
    this.op("ddf", () => {
      const v = this.pop();
      const k = this.pop();
      if (v instanceof PsFile && (k instanceof PsName || k instanceof PsStr)) this.hiddenFilters.set(k.s, v);
    });
    this.op("filter", () => {
      const nm = this.pop();
      if (!(nm instanceof PsName)) throw new PsError("typecheck");
      if (nm.s === "SubFileDecode") {
        this.pop();
        this.pop();
      }
      const src = this.pop();
      this.push(new PsFile([...(src instanceof PsFile ? src.filters : []), nm.s]));
    });
    this.alias("fl", "filter");
    this.alias("cf", "currentfile");
    this.op("img", () => {
      const d = this.pop();
      if (d instanceof PsDict) this.doImage(d);
    });
    for (const n of ["snap_to_device", "pgsv", "pgrs", "gx", "nf_dummy"]) this.op(n, () => {});
    this.op("gx", () => {
      this.pop();
      this.pop();
    });

    // --- paths
    this.op("newpath", () => this.newPath());
    this.alias("np", "newpath");
    this.op("moveto", () => {
      const [x, y] = this.popNums(2);
      const [dx, dy] = this.userToDev(x, y);
      this.moveTo(dx, dy);
    });
    this.alias("mo", "moveto");
    this.op("lineto", () => {
      const [x, y] = this.popNums(2);
      const [dx, dy] = this.userToDev(x, y);
      this.lineTo(dx, dy);
    });
    this.alias("li", "lineto");
    this.op("curveto", () => {
      const [a, b, c, d, e, f] = this.popNums(6);
      const p1 = this.userToDev(a, b);
      const p2 = this.userToDev(c, d);
      const p3 = this.userToDev(e, f);
      this.curveTo(p1[0], p1[1], p2[0], p2[1], p3[0], p3[1]);
    });
    this.alias("cv", "curveto");
    const rel = (dx: number, dy: number): [number, number] => {
      if (!this.pt) throw new PsError("nocurrentpoint");
      const m = this.gs.ctm;
      return [this.pt.x + m[0] * dx + m[2] * dy, this.pt.y + m[1] * dx + m[3] * dy];
    };
    this.op("rmoveto", () => {
      const [x, y] = this.popNums(2);
      const [a, b] = rel(x, y);
      this.moveTo(a, b);
    });
    this.op("rlineto", () => {
      const [x, y] = this.popNums(2);
      const [a, b] = rel(x, y);
      this.lineTo(a, b);
    });
    this.op("rcurveto", () => {
      const v = this.popNums(6);
      const p1 = rel(v[0], v[1]);
      const p2 = rel(v[2], v[3]);
      const p3 = rel(v[4], v[5]);
      this.curveTo(p1[0], p1[1], p2[0], p2[1], p3[0], p3[1]);
    });
    this.op("closepath", () => this.closePath());
    this.alias("cp", "closepath");
    this.op("currentpoint", () => {
      if (!this.pt) throw new PsError("nocurrentpoint");
      const inv = minv(this.gs.ctm);
      const [x, y] = inv ? mapPt(inv, this.pt.x, this.pt.y) : [this.pt.x, this.pt.y];
      this.push(x);
      this.push(y);
    });
    this.op("arc", () => {
      const [x, y, r, a1, a2] = this.popNums(5);
      this.arc(x, y, r, a1, a2, true);
    });
    this.op("arcn", () => {
      const [x, y, r, a1, a2] = this.popNums(5);
      this.arc(x, y, r, a1, a2, false);
    });
    const rectPath = (x: number, y: number, w: number, h: number): void => {
      this.newPath();
      const p = [this.userToDev(x, y), this.userToDev(x + w, y), this.userToDev(x + w, y + h), this.userToDev(x, y + h)];
      this.moveTo(p[0][0], p[0][1]);
      for (let i = 1; i < 4; i++) this.lineTo(p[i][0], p[i][1]);
      this.closePath();
    };
    this.op("rectfill", () => {
      const [x, y, w, h] = this.popNums(4);
      rectPath(x, y, w, h);
      this.doFill();
    });
    this.op("rectstroke", () => {
      const [x, y, w, h] = this.popNums(4);
      rectPath(x, y, w, h);
      this.doStroke();
    });
    this.op("rectclip", () => {
      const [x, y, w, h] = this.popNums(4);
      rectPath(x, y, w, h);
      this.recordClip();
      this.newPath();
    });
    this.op("fill", () => this.doFill());
    this.alias("f", "fill");
    this.op("eofill", () => this.doFill());
    this.alias("ef", "eofill");
    this.op("stroke", () => this.doStroke());
    this.alias("@", "stroke");
    this.op("clip", () => this.recordClip());
    this.op("eoclip", () => this.recordClip());
    this.op("clp", () => {
      this.recordClip();
      this.newPath();
    });
    this.alias("eclp", "clp");
    this.op("nclp", () => {
      this.recordClip();
      this.newPath();
    });
    for (const n of ["shfill", "colorimage", "image", "imagemask", "sh_unused"]) this.op(n, () => this.unknown(n));
    this.op("shfill", () => {
      this.pop();
      this.unknown("shfill (gradients are not imported)");
    });
    this.op("image", () => {
      this.unknown("image");
      this.ostack.length = Math.max(0, this.ostack.length - 5);
    });

    // --- text
    this.op("findfont", () => {
      const k = this.pop();
      const d = new PsDict();
      d.m.set("FontName", k instanceof PsName ? k : new PsName("Font", true));
      this.push(d);
    });
    this.op("scalefont", () => {
      const s = this.popNum();
      const f = this.pop();
      if (f instanceof PsDict) f.m.set("__size", s);
      this.push(f);
    });
    this.op("makefont", () => {
      const m = getM(this.popArr());
      const f = this.pop();
      if (f instanceof PsDict) f.m.set("__matrix", new PsArr([...m]));
      this.push(f);
    });
    this.op("setfont", () => {
      const f = this.pop();
      if (f instanceof PsDict) {
        const mm = f.m.get("__matrix");
        const sz = f.m.get("__size");
        this.gs.fontMatrix = mm instanceof PsArr ? getM(mm) : typeof sz === "number" ? [sz, 0, 0, sz, 0, 0] : [10, 0, 0, 10, 0, 0];
      }
    });
    this.op("selectfont", () => {
      const sz = this.pop();
      this.pop();
      if (typeof sz === "number") this.gs.fontMatrix = [sz, 0, 0, sz, 0, 0];
      else if (sz instanceof PsArr) this.gs.fontMatrix = getM(sz);
    });
    this.op("definefont", () => {
      const f = this.pop();
      this.pop();
      this.push(f);
    });
    this.op("msf", () => {
      const m = this.pop();
      this.pop();
      if (m instanceof PsArr) this.gs.fontMatrix = getM(m);
    });
    this.op("nf", () => {
      const top = this.pop();
      if (!(top instanceof PsArr)) this.pop();
      this.pop();
    });
    const show = (...extra: number[]) =>
      () => {
        const s = this.pop();
        for (const n of extra) for (let i = 0; i < n; i++) this.pop();
        if (s instanceof PsStr) this.showText(s.s);
      };
    this.op("show", show());
    this.op("ashow", show(2));
    this.op("widthshow", show(3));
    this.op("awidthshow", show(5));
    for (const n of ["xshow", "yshow", "xyshow", "kshow"]) {
      this.op(n, () => {
        this.pop();
        const s = this.pop();
        if (s instanceof PsStr) this.showText(s.s);
      });
    }
    this.alias("sh", "show");
    this.alias("xsh", "xshow");
    this.alias("ysh", "yshow");
    this.alias("xysh", "xyshow");
    this.op("stringwidth", () => {
      const s = this.pop();
      const m = mmul(this.gs.fontMatrix, [1, 0, 0, 1, 0, 0]);
      const w = (s instanceof PsStr ? s.s.length : 0) * Math.hypot(m[0], m[1]) * 0.5;
      this.push(w);
      this.push(0);
    });
    this.op("charpath", () => {
      this.pop();
      this.pop();
      this.unknown("charpath (glyph outlines)");
    });
  }
}

export { MARK };
