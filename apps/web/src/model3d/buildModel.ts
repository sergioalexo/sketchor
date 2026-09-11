import type { Bounds3, Model3D, ModelFormat, ModelNode, ModelPart, OcctMesh, OcctNode, OcctResult } from "./types";

/**
 * Flattens an occt-import-js result into a `Model3D`: one merged buffer set
 * with a part table, per-vertex colours baked in, and the B-rep edges
 * extracted. Pure and synchronous — it runs inside the import worker, right
 * after tessellation, so the main thread never touches the per-mesh JS
 * arrays OpenCascade produces (millions of boxed numbers on a big assembly).
 *
 * Tolerant by design: a mesh with a missing or truncated attribute is
 * skipped, never thrown on. A file that tessellates to nothing yields an
 * empty model with zero bounds, which the viewer knows how to show.
 */

/** Part colour when the file doesn't carry one — a neutral CAD grey. */
const DEFAULT_COLOR: [number, number, number] = [0.78, 0.79, 0.82];

const EMPTY_BOUNDS = (): Bounds3 => ({ min: [0, 0, 0], max: [0, 0, 0] });

interface PreparedMesh {
  name: string;
  positions: Float32Array;
  normals: Float32Array;
  colors: Uint8Array;
  indices: Uint32Array;
  edges: Float32Array;
  bounds: Bounds3;
}

export function buildModel(result: OcctResult, name: string, hash: string, format: ModelFormat): Model3D {
  const source = Array.isArray(result?.meshes) ? result.meshes : [];
  // Index into `source` -> index into `prepared` (skipped meshes have none),
  // so the hierarchy can still point at the parts that survived.
  const partIndexOf = new Map<number, number>();
  const prepared: PreparedMesh[] = [];
  for (let i = 0; i < source.length; i++) {
    const m = prepareMesh(source[i]);
    if (!m) continue;
    partIndexOf.set(i, prepared.length);
    prepared.push(m);
  }

  let vertexTotal = 0;
  let indexTotal = 0;
  let edgeTotal = 0;
  for (const m of prepared) {
    vertexTotal += m.positions.length / 3;
    indexTotal += m.indices.length;
    edgeTotal += m.edges.length;
  }

  const positions = new Float32Array(vertexTotal * 3);
  const normals = new Float32Array(vertexTotal * 3);
  const colors = new Uint8Array(vertexTotal * 3);
  const indices = new Uint32Array(indexTotal);
  const edges = new Float32Array(edgeTotal);
  const parts: ModelPart[] = [];

  let v = 0;
  let ix = 0;
  let ed = 0;
  for (const m of prepared) {
    const vertexCount = m.positions.length / 3;
    positions.set(m.positions, v * 3);
    normals.set(m.normals, v * 3);
    colors.set(m.colors, v * 3);
    for (let k = 0; k < m.indices.length; k++) indices[ix + k] = m.indices[k] + v;
    edges.set(m.edges, ed);
    parts.push({
      name: m.name,
      vertexStart: v,
      vertexCount,
      indexStart: ix,
      indexCount: m.indices.length,
      edgeStart: ed / 6,
      edgeCount: m.edges.length / 6,
      bounds: m.bounds,
    });
    v += vertexCount;
    ix += m.indices.length;
    ed += m.edges.length;
  }

  return {
    name,
    hash,
    format,
    positions,
    normals,
    colors,
    indices,
    edges,
    parts,
    tree: buildTree(result?.root, partIndexOf, parts, name),
    bounds: unionBounds(parts.map((p) => p.bounds)),
    triangleCount: indexTotal / 3,
  };
}

/* ------------------------------- per mesh -------------------------------- */

function prepareMesh(mesh: OcctMesh | undefined): PreparedMesh | null {
  const posSrc = mesh?.attributes?.position?.array;
  const idxSrc = mesh?.index?.array;
  if (!posSrc || !idxSrc || posSrc.length < 9 || idxSrc.length < 3) return null;

  const vertexCount = Math.floor(posSrc.length / 3);
  const positions = new Float32Array(vertexCount * 3);
  for (let i = 0; i < positions.length; i++) positions[i] = +posSrc[i] || 0;

  // Drop any triangle that points outside the vertex range rather than
  // letting a corrupt index crash the GPU upload later.
  const triCount = Math.floor(idxSrc.length / 3);
  const indices = new Uint32Array(triCount * 3);
  let t = 0;
  const triKept = new Int32Array(triCount).fill(-1);
  for (let i = 0; i < triCount; i++) {
    const a = idxSrc[i * 3] | 0;
    const b = idxSrc[i * 3 + 1] | 0;
    const c = idxSrc[i * 3 + 2] | 0;
    if (a < 0 || b < 0 || c < 0 || a >= vertexCount || b >= vertexCount || c >= vertexCount) continue;
    indices[t * 3] = a;
    indices[t * 3 + 1] = b;
    indices[t * 3 + 2] = c;
    triKept[i] = t;
    t += 1;
  }
  const keptIndices = t === triCount ? indices : indices.subarray(0, t * 3);
  if (t === 0) return null;

  const normSrc = mesh.attributes?.normal?.array;
  const normals =
    normSrc && normSrc.length >= vertexCount * 3
      ? Float32Array.from({ length: vertexCount * 3 }, (_, i) => +normSrc[i] || 0)
      : computeNormals(positions, keptIndices);

  // Per-triangle B-rep face id (from the original triangle numbering), used
  // for both face colours and edge extraction.
  const faceOfTri = new Int32Array(t).fill(0);
  const faces = Array.isArray(mesh.brep_faces) ? mesh.brep_faces : [];
  for (let f = 0; f < faces.length; f++) {
    const face = faces[f];
    const first = Math.max(0, face?.first | 0);
    const last = Math.min(triCount - 1, face?.last | 0);
    for (let i = first; i <= last; i++) {
      const k = triKept[i];
      if (k >= 0) faceOfTri[k] = f;
    }
  }

  const colors = new Uint8Array(vertexCount * 3);
  const base = toRgb8(mesh.color ?? DEFAULT_COLOR);
  for (let i = 0; i < vertexCount; i++) colors.set(base, i * 3);
  // Face colours override the part colour. OpenCascade meshes each face
  // with its own vertices, so painting by triangle never bleeds across faces.
  for (let f = 0; f < faces.length; f++) {
    const fc = faces[f]?.color;
    if (!fc) continue;
    const rgb = toRgb8(fc);
    const first = Math.max(0, faces[f].first | 0);
    const last = Math.min(triCount - 1, faces[f].last | 0);
    for (let i = first; i <= last; i++) {
      const k = triKept[i];
      if (k < 0) continue;
      colors.set(rgb, keptIndices[k * 3] * 3);
      colors.set(rgb, keptIndices[k * 3 + 1] * 3);
      colors.set(rgb, keptIndices[k * 3 + 2] * 3);
    }
  }

  const bounds = boundsOf(positions);
  return {
    name: typeof mesh.name === "string" && mesh.name.trim() ? mesh.name.trim() : "Part",
    positions,
    normals,
    colors,
    indices: keptIndices,
    edges: extractEdges(positions, keptIndices, faceOfTri, bounds),
    bounds,
  };
}

function toRgb8(c: ArrayLike<number>): Uint8Array {
  const out = new Uint8Array(3);
  for (let i = 0; i < 3; i++) {
    const v = +c[i];
    out[i] = Math.max(0, Math.min(255, Math.round((Number.isFinite(v) ? v : 0.8) * 255)));
  }
  return out;
}

function computeNormals(positions: Float32Array, indices: Uint32Array): Float32Array {
  const n = new Float32Array(positions.length);
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i] * 3;
    const b = indices[i + 1] * 3;
    const c = indices[i + 2] * 3;
    const abx = positions[b] - positions[a];
    const aby = positions[b + 1] - positions[a + 1];
    const abz = positions[b + 2] - positions[a + 2];
    const acx = positions[c] - positions[a];
    const acy = positions[c + 1] - positions[a + 1];
    const acz = positions[c + 2] - positions[a + 2];
    const nx = aby * acz - abz * acy;
    const ny = abz * acx - abx * acz;
    const nz = abx * acy - aby * acx;
    for (const k of [a, b, c]) {
      n[k] += nx;
      n[k + 1] += ny;
      n[k + 2] += nz;
    }
  }
  for (let i = 0; i < n.length; i += 3) {
    const len = Math.hypot(n[i], n[i + 1], n[i + 2]) || 1;
    n[i] /= len;
    n[i + 1] /= len;
    n[i + 2] /= len;
  }
  return n;
}

/**
 * B-rep edges: triangle edges shared by two triangles of *different* faces,
 * plus open boundaries (an edge with only one triangle — sheet bodies).
 *
 * Adjacent faces don't share vertex indices (each face is tessellated on
 * its own), so vertices are first welded by quantised position; the maps
 * are per mesh and therefore small even on a huge assembly.
 */
function extractEdges(positions: Float32Array, indices: Uint32Array, faceOfTri: Int32Array, bounds: Bounds3): Float32Array {
  const vertexCount = positions.length / 3;
  const diag = Math.hypot(
    bounds.max[0] - bounds.min[0],
    bounds.max[1] - bounds.min[1],
    bounds.max[2] - bounds.min[2],
  );
  const inv = 1 / (diag > 0 ? diag * 1e-6 : 1e-6);

  const weld = new Uint32Array(vertexCount);
  const byKey = new Map<string, number>();
  let welded = 0;
  for (let i = 0; i < vertexCount; i++) {
    const key = `${Math.round(positions[i * 3] * inv)},${Math.round(positions[i * 3 + 1] * inv)},${Math.round(positions[i * 3 + 2] * inv)}`;
    let id = byKey.get(key);
    if (id === undefined) {
      id = welded++;
      byKey.set(key, id);
    }
    weld[i] = id;
  }

  // key -> face id of first triangle seen; -1 = interior (same face twice),
  // -2 = crease (two faces). Third+ occurrences (non-manifold) are ignored.
  const seen = new Map<number, number>();
  // A representative original vertex per welded id, for output coordinates.
  const rep = new Uint32Array(welded);
  for (let i = vertexCount - 1; i >= 0; i--) rep[weld[i]] = i;

  const triCount = indices.length / 3;
  for (let tri = 0; tri < triCount; tri++) {
    const face = faceOfTri[tri];
    const a = weld[indices[tri * 3]];
    const b = weld[indices[tri * 3 + 1]];
    const c = weld[indices[tri * 3 + 2]];
    visitEdge(seen, welded, a, b, face);
    visitEdge(seen, welded, b, c, face);
    visitEdge(seen, welded, c, a, face);
  }

  const out: number[] = [];
  for (const [key, state] of seen) {
    if (state === -1) continue;
    const u = Math.floor(key / welded);
    const w = key - u * welded;
    if (u === w) continue;
    const pu = rep[u] * 3;
    const pw = rep[w] * 3;
    out.push(positions[pu], positions[pu + 1], positions[pu + 2], positions[pw], positions[pw + 1], positions[pw + 2]);
  }
  return Float32Array.from(out);
}

function visitEdge(seen: Map<number, number>, welded: number, a: number, b: number, face: number): void {
  const lo = a < b ? a : b;
  const hi = a < b ? b : a;
  const key = lo * welded + hi;
  const prev = seen.get(key);
  if (prev === undefined) seen.set(key, face);
  else if (prev >= 0) seen.set(key, prev === face ? -1 : -2);
}

/* ------------------------------ hierarchy ------------------------------- */

const MAX_TREE_DEPTH = 64;

/**
 * The assembly tree as the file declares it, tidied: STEP wraps every part
 * in a product node of its own ("SCREW" → "SCREW"), which would make the
 * tree twice as deep as it reads, so single-part leaf nodes are hoisted into
 * their parent (the part takes the node's name when its own is generic).
 * Parts the hierarchy doesn't reference still get listed, at the root.
 */
function buildTree(
  root: OcctNode | undefined,
  partIndexOf: Map<number, number>,
  parts: { name: string }[],
  fallbackName: string,
): ModelNode {
  const visit = (node: OcctNode | undefined, depth: number): ModelNode | null => {
    if (!node || typeof node !== "object" || depth > MAX_TREE_DEPTH) return null;
    const own: number[] = [];
    for (const i of Array.isArray(node.meshes) ? node.meshes : []) {
      const p = partIndexOf.get(i | 0);
      if (p !== undefined) own.push(p);
    }
    const children: ModelNode[] = [];
    for (const c of Array.isArray(node.children) ? node.children : []) {
      const child = visit(c, depth + 1);
      if (!child || (child.parts.length === 0 && child.children.length === 0)) continue;
      if (child.children.length === 0 && child.parts.length === 1) {
        const part = parts[child.parts[0]];
        if (child.name && (part.name === "Part" || part.name === child.name)) part.name = child.name;
        own.push(child.parts[0]);
        continue;
      }
      children.push(child);
    }
    return { name: typeof node.name === "string" && node.name.trim() ? node.name.trim() : "", parts: own, children };
  };
  const tree = visit(root, 0) ?? { name: "", parts: [], children: [] };
  if (!tree.name) tree.name = fallbackName;
  const referenced = new Set<number>();
  const collect = (n: ModelNode) => {
    n.parts.forEach((p) => referenced.add(p));
    n.children.forEach(collect);
  };
  collect(tree);
  for (let i = 0; i < partIndexOf.size; i++) if (!referenced.has(i)) tree.parts.push(i);
  return tree;
}

/* -------------------------------- bounds -------------------------------- */

function boundsOf(positions: Float32Array): Bounds3 {
  if (positions.length < 3) return EMPTY_BOUNDS();
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = positions[i + k];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  }
  return { min, max };
}

export function unionBounds(list: Bounds3[]): Bounds3 {
  if (list.length === 0) return EMPTY_BOUNDS();
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const b of list) {
    for (let k = 0; k < 3; k++) {
      if (b.min[k] < min[k]) min[k] = b.min[k];
      if (b.max[k] > max[k]) max[k] = b.max[k];
    }
  }
  return { min, max };
}
