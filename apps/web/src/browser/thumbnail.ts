import { dxfToSvg, entitiesToSvg, parseSvgText, type ThumbnailOptions } from "@sketchor/core";

/**
 * True for drawing file kinds the in-app file browser lists thumbnails for.
 * DWG is import-only and not text-readable, so it's opened via the Open
 * dialog / file association rather than browsed here — see drawingFile.ts.
 */
export function isDrawingFile(name: string): boolean {
  return /\.(dxf|svg)$/i.test(name);
}

/**
 * Renders either file kind to a thumbnail SVG string, reusing the same
 * headless renderer that backs the native Explorer thumbnailer, so previews
 * everywhere agree.
 */
export function fileToSvg(name: string, text: string, opts?: ThumbnailOptions): string {
  if (/\.dxf$/i.test(name)) return dxfToSvg(text, opts);
  try {
    const { entities } = parseSvgText(text);
    return entitiesToSvg(entities, opts);
  } catch {
    return entitiesToSvg([], opts);
  }
}

/* --------------------------- background rendering ------------------------- */

/**
 * Thumbnail work queue.
 *
 * Reading and parsing a DXF is synchronous and can take a while on a big
 * file. Firing one off per visible card meant opening a folder of hundreds of
 * drawings saturated the main thread and froze the whole app — including the
 * drawing the user was already working on.
 *
 * Jobs are therefore run one at a time, with a yield between each so input,
 * rendering and the canvas keep getting their turn. `requestIdleCallback`
 * schedules the next job in whatever slack the browser has; where it isn't
 * available a macrotask hop gives the same ordering, just less politely.
 * Thumbnails consequently fill in progressively instead of all at once, which
 * is the intended trade.
 */
type Job = () => Promise<void> | void;

const pending: { job: Job; cancelled: boolean }[] = [];
let draining = false;

const nextIdle = (): Promise<void> =>
  new Promise((resolve) => {
    const ric = (window as unknown as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number })
      .requestIdleCallback;
    if (ric) ric(() => resolve(), { timeout: 250 });
    else setTimeout(resolve, 0);
  });

async function drain(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    while (pending.length > 0) {
      await nextIdle();
      const entry = pending.shift();
      if (!entry || entry.cancelled) continue;
      try {
        await entry.job();
      } catch {
        // one bad file must not stall the rest of the queue
      }
    }
  } finally {
    draining = false;
  }
}

/**
 * Queues thumbnail work to run off the critical path. Returns a cancel
 * function — call it on unmount so scrolled-away cards don't keep the queue
 * busy rendering previews nobody is looking at.
 */
export function queueThumbnail(job: Job): () => void {
  const entry = { job, cancelled: false };
  pending.push(entry);
  void drain();
  return () => {
    entry.cancelled = true;
  };
}
