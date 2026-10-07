import type { BlocksHost } from "./types";

/**
 * The document whose `blocks` table `insert` entities resolve against when
 * generic code (bounds, hit test, snapping, drawing) asks the kind registry —
 * whose methods take only the entity. `CommandBus` activates its document on
 * construction and on every execute/undo/redo, so the app and tests that go
 * through the bus need not think about it; code working on a bare
 * `SketchDocument` uses {@link withBlocks}.
 */
let active: BlocksHost | null = null;

export function setActiveBlocks(host: BlocksHost | null): void {
  active = host;
}

export function activeBlocks(): BlocksHost | null {
  return active;
}

/** Runs `fn` with `host` as the active block source, then restores the previous one. */
export function withBlocks<T>(host: BlocksHost, fn: () => T): T {
  const prev = active;
  active = host;
  try {
    return fn();
  } finally {
    active = prev;
  }
}
