/**
 * The solver's public surface. The parameter mapping, the residual rows
 * and the auto-differentiating scalars underneath are implementation —
 * they are imported directly by the solver's own tests, not re-exported
 * here, so that swapping the engine stays a local change (and so generic
 * names like `add`/`sub` don't collide with the geometry module's).
 */
export { solveSketch, type SolveOptions, type SolveResult, type SolveStatus } from "./solve";
