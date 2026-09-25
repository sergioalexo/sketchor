/**
 * `clipper-lib` ships no types (and no `@types` package) — a minimal ambient
 * declaration covering only the offset API `polygonOps.ts` actually calls.
 */
declare module "clipper-lib" {
  export interface IntPoint {
    X: number;
    Y: number;
  }

  export type Path = IntPoint[];
  export type Paths = Path[];

  export const JoinType: {
    jtSquare: number;
    jtRound: number;
    jtMiter: number;
  };

  export const EndType: {
    etOpenSquare: number;
    etOpenRound: number;
    etOpenButt: number;
    etClosedLine: number;
    etClosedPolygon: number;
  };

  export class ClipperOffset {
    constructor(miterLimit?: number, roundPrecision?: number);
    AddPath(path: Path, joinType: number, endType: number): void;
    AddPaths(paths: Paths, joinType: number, endType: number): void;
    Execute(solution: Paths, delta: number): void;
  }

  export const Clipper: {
    /** `true` for a positively (CCW, in a Y-up frame) wound polygon — what `MinkowskiSum` expects. */
    Orientation(poly: Path): boolean;
    /** `pattern` is always one closed path; `path_or_paths` may be a single path or many. */
    MinkowskiSum(pattern: Path, path_or_paths: Path | Paths, pathIsClosed: boolean): Paths;
  };

  const ClipperLibDefault: {
    ClipperOffset: typeof ClipperOffset;
    JoinType: typeof JoinType;
    EndType: typeof EndType;
    Clipper: typeof Clipper;
  };
  export default ClipperLibDefault;
}
