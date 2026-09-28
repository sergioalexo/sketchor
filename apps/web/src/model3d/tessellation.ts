/**
 * OCCT tessellation density, size-adaptive. Reading the STEP/IGES B-rep
 * dominates wall time and the deflection barely moves it (see
 * occt.worker.ts's own note, measured on real Onshape exports) — but that
 * measurement was on files up to ~6 MB. A 58 MB assembly tessellated at the
 * same fine deflection produces proportionally more triangles for the same
 * reason, which pushes wasm heap and IndexedDB cache size up for no benefit
 * the user can see at that scale. Above the threshold, use a coarser
 * deflection instead.
 */

export type TessellationParams = {
  linearUnit: string;
  linearDeflectionType: "bounding_box_ratio";
  linearDeflection: number;
  angularDeflection: number;
};

/** Above this input size, switch to COARSE. */
export const COARSE_THRESHOLD_BYTES = 30 * 1024 * 1024;

const FINE: TessellationParams = {
  linearUnit: "millimeter",
  linearDeflectionType: "bounding_box_ratio",
  linearDeflection: 0.002,
  angularDeflection: 0.5,
};

const COARSE: TessellationParams = {
  linearUnit: "millimeter",
  linearDeflectionType: "bounding_box_ratio",
  linearDeflection: 0.005,
  angularDeflection: 0.8,
};

export function tessellationFor(byteLength: number): TessellationParams {
  return byteLength > COARSE_THRESHOLD_BYTES ? COARSE : FINE;
}
