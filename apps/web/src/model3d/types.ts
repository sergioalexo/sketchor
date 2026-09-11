/**
 * A tessellated 3D model as the viewer consumes it: one merged vertex buffer
 * for the whole file plus a part table indexing into it.
 *
 * STEP/IGES files are B-rep; the OpenCascade worker (occt.worker.ts)
 * tessellates them and `buildModel` flattens the result into this shape so
 * the main thread does nothing but hand typed arrays to the GPU. Everything
 * here survives structured cloning (postMessage / IndexedDB) — that is what
 * makes the persistent model cache and the worker hand-off zero-copy.
 *
 * This is a *viewing* format, deliberately separate from the 2D document
 * model in @sketchor/core: a model tab has no entities, no command bus, and
 * nothing to save.
 */
export interface Model3D {
  /** Original filename (for the tab title). */
  name: string;
  /** SHA-256 of the source bytes — the cache key, and how re-opens are deduplicated. */
  hash: string;
  format: ModelFormat;
  /** Vertex positions, xyz triplets, in millimeters. */
  positions: Float32Array;
  /** Per-vertex unit normals, xyz triplets, parallel to `positions`. */
  normals: Float32Array;
  /** Per-vertex RGB, 0–255, parallel to `positions` (three.js reads it as a normalized attribute). */
  colors: Uint8Array;
  /** Triangle vertex indices into `positions`. */
  indices: Uint32Array;
  /**
   * B-rep edge segments as xyz pairs (two points per segment), for the dark
   * outline that makes a shaded CAD model readable. Extracted where two
   * triangles of *different* B-rep faces meet, so tangent edges draw too —
   * the convention CAD packages use.
   */
  edges: Float32Array;
  parts: ModelPart[];
  /** Assembly hierarchy as the file declared it; leaves reference `parts` by index. */
  tree: ModelNode;
  bounds: Bounds3;
  triangleCount: number;
}

export type ModelFormat = "step" | "iges";

export interface ModelPart {
  name: string;
  /** Vertex range in the merged buffers (`positions`/`normals`/`colors`). */
  vertexStart: number;
  vertexCount: number;
  /** Index range in `indices` (a multiple of 3). */
  indexStart: number;
  indexCount: number;
  /** Segment range in `edges` (one segment = 6 floats). */
  edgeStart: number;
  edgeCount: number;
  bounds: Bounds3;
}

export interface ModelNode {
  name: string;
  parts: number[];
  children: ModelNode[];
}

export interface Bounds3 {
  min: [number, number, number];
  max: [number, number, number];
}

/** The shape occt-import-js returns from ReadStepFile / ReadIgesFile (see its README). */
export interface OcctResult {
  success: boolean;
  root?: OcctNode;
  meshes?: OcctMesh[];
}

export interface OcctNode {
  name?: string;
  meshes?: number[];
  children?: OcctNode[];
}

export interface OcctMesh {
  name?: string;
  color?: [number, number, number];
  brep_faces?: { first: number; last: number; color?: [number, number, number] | null }[];
  attributes?: {
    position?: { array: ArrayLike<number> };
    normal?: { array: ArrayLike<number> };
  };
  index?: { array: ArrayLike<number> };
}

/** Bytes of typed-array payload a model carries — what the cache budget counts. */
export function modelByteSize(m: Model3D): number {
  return (
    m.positions.byteLength + m.normals.byteLength + m.colors.byteLength + m.indices.byteLength + m.edges.byteLength
  );
}
