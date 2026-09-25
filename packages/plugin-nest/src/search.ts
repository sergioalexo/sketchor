import { nestTrueShape, type TrueNestOptions, type TrueNestPart, type TrueNestResult } from "./trueNest";
import type { StockRow } from "./stock";

/**
 * Time-budgeted search (N-14): `nestTrueShape` itself is one deterministic
 * placement pass. This tries several — the default ordering plus a handful
 * of alternates and seeded shuffles — within a time budget, and keeps
 * whichever pass placed the most (ties broken by utilisation). "Quick" is
 * exactly today's single pass (zero behaviour change for anyone who doesn't
 * ask for more); "Normal"/"Thorough" spend a few seconds/tens of seconds
 * trying alternates. Every plugin already runs in its own worker
 * (`PluginHost.ts`), so a long search doesn't freeze the app's UI thread —
 * only the panel that's waiting on it, which progress messages and
 * cancellation are for.
 */

export type SearchLevel = "quick" | "normal" | "thorough";

export const LEVEL_BUDGET_MS: Record<SearchLevel, number> = {
  quick: 0,
  normal: 3000,
  thorough: 15000,
};

export interface SearchProgress {
  attempt: number;
  bestPlaced: number;
  bestUnplaced: number;
  bestUtilisation: number;
  elapsedMs: number;
}

export interface SearchOptions extends TrueNestOptions {
  level: SearchLevel;
  /** Overrides the level's own time budget, ms — mainly for tests. */
  budgetMs?: number;
  /** Called after every attempt. */
  onProgress?: (progress: SearchProgress) => void;
  /** Polled between attempts; returning true stops the search after the current attempt. */
  isCancelled?: () => boolean;
  /** Yields control between attempts so a pending cancel message can be processed. Defaults to a real `setTimeout(0)`; tests override it to resolve immediately. */
  yield?: () => Promise<void>;
  /** Clock override, for deterministic tests. */
  now?: () => number;
}

export interface SearchResult {
  result: TrueNestResult;
  attempts: number;
  cancelled: boolean;
}

const defaultYield = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function unplacedCount(result: TrueNestResult): number {
  return result.unplaced.reduce((n, u) => n + u.count, 0);
}

/** Fewer unplaced always wins; utilisation only breaks ties among equally-placed attempts. */
function isBetter(candidate: TrueNestResult, best: TrueNestResult): boolean {
  const cu = unplacedCount(candidate);
  const bu = unplacedCount(best);
  if (cu !== bu) return cu < bu;
  return candidate.utilisation > best.utilisation;
}

/** The orders tried, beyond the default — plain heuristics first (cheap, sometimes just better), then an open-ended sequence of seeded shuffles for however long the budget allows. */
function* candidateOrders(): Generator<TrueNestOptions["order"]> {
  yield "area-asc";
  yield "bbox-desc";
  for (let seed = 1; ; seed++) yield seed;
}

export async function nestTrueShapeSearch(parts: TrueNestPart[], stock: StockRow[], opts: SearchOptions): Promise<SearchResult> {
  const now = opts.now ?? Date.now;
  const yieldFn = opts.yield ?? defaultYield;
  const budget = opts.budgetMs ?? LEVEL_BUDGET_MS[opts.level];
  const start = now();

  let best = nestTrueShape(parts, stock, { ...opts, order: opts.order ?? "area-desc" });
  let attempts = 1;
  opts.onProgress?.({ attempt: attempts, bestPlaced: best.placed.length, bestUnplaced: unplacedCount(best), bestUtilisation: best.utilisation, elapsedMs: now() - start });

  let cancelled = false;
  if (opts.level !== "quick") {
    const orders = candidateOrders();
    while (true) {
      if (now() - start >= budget) break;
      if (opts.isCancelled?.()) {
        cancelled = true;
        break;
      }
      await yieldFn();
      if (opts.isCancelled?.()) {
        cancelled = true;
        break;
      }
      const order = orders.next().value;
      const candidate = nestTrueShape(parts, stock, { ...opts, order });
      attempts++;
      if (isBetter(candidate, best)) best = candidate;
      opts.onProgress?.({ attempt: attempts, bestPlaced: best.placed.length, bestUnplaced: unplacedCount(best), bestUtilisation: best.utilisation, elapsedMs: now() - start });
    }
  }

  return { result: best, attempts, cancelled };
}
