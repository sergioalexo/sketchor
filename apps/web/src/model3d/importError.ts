/**
 * Turns a raw crash into a message a user can act on: which file, how big,
 * and — for the wasm heap's 4 GB ceiling specifically — plainly that it ran
 * out of memory rather than a generic "import worker crashed"/"OpenCascade
 * failed to read the file: RuntimeError: memory access out of bounds".
 */

const OOM_PATTERN = /\bOOM\b|out of memory|memory access out of bounds|cannot enlarge memory/i;

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "unknown size";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  const mb = bytes / (1024 * 1024);
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

export function isOomError(rawMessage: string): boolean {
  return OOM_PATTERN.test(rawMessage);
}

export function describeImportError(rawMessage: string, name: string, bytes: number): string {
  const size = formatBytes(bytes);
  if (isOomError(rawMessage)) {
    return `Ran out of memory reading ${name} (${size}) — OpenCascade's wasm import is capped at 4 GB and this file exceeded it.`;
  }
  return `${rawMessage} (reading ${name}, ${size})`;
}
