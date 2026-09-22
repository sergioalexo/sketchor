/**
 * A scalar that carries its own derivatives — forward-mode automatic
 * differentiation, sparse, one entry per sketch parameter it depends on.
 *
 * The solver needs a Jacobian, and hand-deriving one per constraint is
 * where geometry solvers go wrong: a sign error in a partial derivative
 * doesn't crash, it just makes the sketch drift somewhere unexpected when
 * dragged. Composing derivatives here instead means a constraint is
 * written the way it reads — "the distance between these two points minus
 * the value" — and its gradient falls out correct by construction.
 *
 * Gradients are `Map<paramIndex, number>`: a sketch has tens of
 * parameters and each residual touches a handful of them, so sparse maps
 * beat dense rows both in memory and in the inner loop.
 */

export interface Num {
  readonly v: number;
  readonly d: ReadonlyMap<number, number>;
}

const NO_GRAD: ReadonlyMap<number, number> = new Map();

/** A constant: a number with no dependence on any parameter. */
export function konst(v: number): Num {
  return { v, d: NO_GRAD };
}

/** The free parameter at `index`, whose derivative with respect to itself is 1. */
export function variable(index: number, v: number): Num {
  return { v, d: new Map([[index, 1]]) };
}

function combine(a: Num, b: Num, da: number, db: number): Map<number, number> {
  const d = new Map<number, number>();
  for (const [i, g] of a.d) d.set(i, g * da);
  for (const [i, g] of b.d) d.set(i, (d.get(i) ?? 0) + g * db);
  return d;
}

function scaled(a: Num, factor: number): Map<number, number> {
  const d = new Map<number, number>();
  for (const [i, g] of a.d) d.set(i, g * factor);
  return d;
}

export function add(a: Num, b: Num): Num {
  return { v: a.v + b.v, d: combine(a, b, 1, 1) };
}

export function sub(a: Num, b: Num): Num {
  return { v: a.v - b.v, d: combine(a, b, 1, -1) };
}

export function mul(a: Num, b: Num): Num {
  return { v: a.v * b.v, d: combine(a, b, b.v, a.v) };
}

export function div(a: Num, b: Num): Num {
  return { v: a.v / b.v, d: combine(a, b, 1 / b.v, -a.v / (b.v * b.v)) };
}

export function scale(a: Num, factor: number): Num {
  return { v: a.v * factor, d: scaled(a, factor) };
}

export function neg(a: Num): Num {
  return scale(a, -1);
}

export function sqrtNum(a: Num): Num {
  const v = Math.sqrt(Math.max(a.v, 0));
  // At zero the derivative is infinite; clamp so a degenerate length (two
  // coincident points in a distance constraint) nudges instead of exploding.
  return { v, d: scaled(a, 1 / (2 * Math.max(v, 1e-9))) };
}

export function sinNum(a: Num): Num {
  return { v: Math.sin(a.v), d: scaled(a, Math.cos(a.v)) };
}

export function cosNum(a: Num): Num {
  return { v: Math.cos(a.v), d: scaled(a, -Math.sin(a.v)) };
}

/** atan2(y, x), with the standard partials y' x − y x' over (x² + y²). */
export function atan2Num(y: Num, x: Num): Num {
  const denom = x.v * x.v + y.v * y.v || 1e-18;
  return { v: Math.atan2(y.v, x.v), d: combine(y, x, x.v / denom, -y.v / denom) };
}

/** Euclidean length of a 2-vector, the building block of every distance constraint. */
export function hypotNum(x: Num, y: Num): Num {
  return sqrtNum(add(mul(x, x), mul(y, y)));
}

export interface Vec {
  x: Num;
  y: Num;
}

export function vsub(a: Vec, b: Vec): Vec {
  return { x: sub(a.x, b.x), y: sub(a.y, b.y) };
}

export function vadd(a: Vec, b: Vec): Vec {
  return { x: add(a.x, b.x), y: add(a.y, b.y) };
}

export function vscale(a: Vec, factor: number): Vec {
  return { x: scale(a.x, factor), y: scale(a.y, factor) };
}

export function dot(a: Vec, b: Vec): Num {
  return add(mul(a.x, b.x), mul(a.y, b.y));
}

/** The 2D cross product (a scalar): zero when the vectors are parallel. */
export function cross(a: Vec, b: Vec): Num {
  return sub(mul(a.x, b.y), mul(a.y, b.x));
}

export function length(a: Vec): Num {
  return hypotNum(a.x, a.y);
}

/** Distance between two points. */
export function distanceNum(a: Vec, b: Vec): Num {
  return length(vsub(a, b));
}
