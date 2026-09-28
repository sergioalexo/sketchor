import { describe, expect, it } from "vitest";
import { describeImportError, formatBytes, isOomError } from "./importError";

// A large STEP file failing used to surface as an opaque "import worker
// crashed" or "OpenCascade failed to read the file: RuntimeError: memory
// access out of bounds" with no size or OOM context — this is what a user
// actually needs to know before they can do anything about it.

describe("formatBytes", () => {
  it("formats bytes, kilobytes and megabytes", () => {
    expect(formatBytes(500)).toBe("500 B");
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatBytes(1_500_000)).toBe("1.4 MB");
    expect(formatBytes(64 * 1024 * 1024)).toBe("64 MB");
  });

  it("never throws on bad input", () => {
    expect(formatBytes(Number.NaN)).toBe("unknown size");
    expect(formatBytes(-1)).toBe("unknown size");
  });
});

describe("isOomError", () => {
  it("matches the OOM messages emscripten actually throws", () => {
    expect(isOomError("RuntimeError: memory access out of bounds")).toBe(true);
    expect(isOomError("Aborted(OOM)")).toBe(true);
    expect(isOomError("Cannot enlarge memory arrays")).toBe(true);
    expect(isOomError("out of memory")).toBe(true);
  });

  it("does not flag an unrelated error as OOM", () => {
    expect(isOomError("not a readable STEP/IGES file (unsupported schema or corrupt data)")).toBe(false);
    expect(isOomError("network error")).toBe(false);
  });
});

describe("describeImportError", () => {
  it("names the file and calls out the 4 GB ceiling for an OOM failure", () => {
    const msg = describeImportError("RuntimeError: memory access out of bounds", "large-sample.STEP", 64 * 1024 * 1024);
    expect(msg).toContain("large-sample.STEP");
    expect(msg).toContain("64 MB");
    expect(msg).toContain("Ran out of memory");
    expect(msg).toContain("4 GB");
  });

  it("appends file name and size to a non-OOM error instead of replacing it", () => {
    const msg = describeImportError("import worker crashed", "part.step", 1024);
    expect(msg).toContain("import worker crashed");
    expect(msg).toContain("part.step");
    expect(msg).toContain("1 KB");
  });
});
