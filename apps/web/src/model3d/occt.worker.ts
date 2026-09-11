import occtimportjs from "occt-import-js";
import wasmUrl from "occt-import-js/dist/occt-import-js.wasm?url";
import { buildModel } from "./buildModel";
import { getCachedModel, putCachedModel } from "./modelCache";
import type { Model3D, ModelFormat, OcctResult } from "./types";

/**
 * Import worker: OpenCascade (occt-import-js, LGPL — see NOTICE.md) reads a
 * STEP/IGES file and tessellates it; `buildModel` flattens the result; the
 * model is cached and handed back with its buffers *transferred*, not
 * copied. One worker holds one wasm instance; the pool in stepImport.ts
 * decides how many run at once.
 *
 * Everything slow lives here on purpose. A 10 MB assembly can take a couple
 * of minutes to read, and the UI keeps drawing throughout.
 */

export interface ParseRequest {
  id: number;
  name: string;
  hash: string;
  format: ModelFormat;
  buffer: ArrayBuffer;
}

export type ParseResponse =
  | { id: number; phase: "reading" | "cached" }
  | { id: number; ok: true; model: Model3D; fromCache: boolean; ms: number }
  | { id: number; ok: false; error: string };

interface OcctModule {
  ReadStepFile(content: Uint8Array, params: Record<string, unknown> | null): OcctResult;
  ReadIgesFile(content: Uint8Array, params: Record<string, unknown> | null): OcctResult;
}

/**
 * Tessellation density. Measured on real Onshape assemblies: reading the
 * B-rep dominates and the deflection barely moves the wall time, so this is
 * chosen for how the result *looks* and how much it weighs in the cache —
 * about 1.6M triangles for a 3,000-part assembly, smooth on any GPU.
 */
const TESSELLATION = {
  linearUnit: "millimeter",
  linearDeflectionType: "bounding_box_ratio",
  linearDeflection: 0.002,
  angularDeflection: 0.5,
};

let occtPromise: Promise<OcctModule> | null = null;

function occt(): Promise<OcctModule> {
  if (!occtPromise) {
    const resolved = new URL(wasmUrl, self.location.href).href;
    occtPromise = occtimportjs({ locateFile: () => resolved }) as Promise<OcctModule>;
  }
  return occtPromise;
}

function post(msg: ParseResponse, transfer?: Transferable[]): void {
  (self as unknown as Worker).postMessage(msg, transfer ?? []);
}

function transferables(m: Model3D): Transferable[] {
  return [m.positions.buffer, m.normals.buffer, m.colors.buffer, m.indices.buffer, m.edges.buffer];
}

async function handle(req: ParseRequest): Promise<void> {
  const t0 = performance.now();
  const cached = await getCachedModel(req.hash);
  if (cached) {
    post({ id: req.id, phase: "cached" });
    // Cached models come from the file as it was; the name may differ if
    // it was renamed since — the tab should say what the user opened.
    cached.name = req.name;
    post({ id: req.id, ok: true, model: cached, fromCache: true, ms: performance.now() - t0 }, transferables(cached));
    return;
  }

  post({ id: req.id, phase: "reading" });
  const lib = await occt();
  const bytes = new Uint8Array(req.buffer);
  let result: OcctResult;
  try {
    result = req.format === "iges" ? lib.ReadIgesFile(bytes, TESSELLATION) : lib.ReadStepFile(bytes, TESSELLATION);
  } catch (err) {
    post({ id: req.id, ok: false, error: `OpenCascade failed to read the file: ${(err as Error)?.message ?? String(err)}` });
    return;
  }
  if (!result?.success) {
    post({ id: req.id, ok: false, error: "not a readable STEP/IGES file (unsupported schema or corrupt data)" });
    return;
  }
  const model = buildModel(result, req.name, req.hash, req.format);
  if (model.parts.length === 0) {
    post({ id: req.id, ok: false, error: "the file contains no solid or surface geometry to show" });
    return;
  }
  // Cache before transferring: the put needs the buffers still attached.
  await putCachedModel(model);
  post({ id: req.id, ok: true, model, fromCache: false, ms: performance.now() - t0 }, transferables(model));
}

self.onmessage = (ev: MessageEvent<ParseRequest>) => {
  void handle(ev.data).catch((err) => {
    post({ id: ev.data.id, ok: false, error: (err as Error)?.message ?? String(err) });
  });
};
