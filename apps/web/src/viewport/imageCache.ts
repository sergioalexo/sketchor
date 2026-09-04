/**
 * Decodes each image entity's `dataUrl` once and caches the resulting
 * `HTMLImageElement`, since `drawEntity` runs synchronously on every redraw
 * and can't itself await a decode. `getCachedImage` returns `null` while a
 * decode is still pending (the caller draws a placeholder that frame) and
 * fires the registered callback once it resolves, so the viewport knows to
 * redraw and pick up the now-ready bitmap.
 */

const cache = new Map<string, HTMLImageElement>();
const pending = new Set<string>();
let onDecoded: (() => void) | null = null;

/** Viewport registers a redraw here on mount, and clears it (`null`) on unmount. */
export function setImageDecodeCallback(cb: (() => void) | null): void {
  onDecoded = cb;
}

export function getCachedImage(dataUrl: string): HTMLImageElement | null {
  const cached = cache.get(dataUrl);
  if (cached) return cached;
  if (!pending.has(dataUrl) && dataUrl) {
    pending.add(dataUrl);
    const img = new Image();
    img.onload = () => {
      cache.set(dataUrl, img);
      pending.delete(dataUrl);
      onDecoded?.();
    };
    img.onerror = () => pending.delete(dataUrl);
    img.src = dataUrl;
  }
  return null;
}
