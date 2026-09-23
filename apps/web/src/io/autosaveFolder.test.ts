import { describe, expect, it } from "vitest";
import { safeFileName, standalonePrintDocument } from "./autosaveFolder";

/**
 * Autosaving a printed sheet writes a file whose name comes from a load
 * name the user typed — so it can contain anything, including the
 * characters Windows refuses outright. A name that throws at
 * `getFileHandle` means a plan went to the printer and quietly wasn't
 * filed, which is the one failure this feature exists to prevent. The
 * saved document also has to stand on its own: it is opened later, from a
 * folder, with no app around it.
 */

describe("safeFileName", () => {
  it("keeps a readable name", () => {
    expect(safeFileName("2026-09-23 Dallas run")).toBe("2026-09-23 Dallas run.html");
  });

  it("strips the characters a file system refuses", () => {
    // Trailing space from the stripped "<2>" is trimmed too, or Windows
    // silently drops it and the name stops matching what was written.
    expect(safeFileName('PO 12/34: "big" load <2>')).toBe("PO 12 34 big load 2.html");
  });

  it("never produces an empty name", () => {
    expect(safeFileName("")).toBe("Sketchor print.html");
    expect(safeFileName("///")).toBe("Sketchor print.html");
  });

  it("caps a runaway name rather than failing the write", () => {
    const long = safeFileName("x".repeat(400));
    expect(long.length).toBeLessThanOrEqual(126);
    expect(long.endsWith(".html")).toBe(true);
  });
});

describe("standalonePrintDocument", () => {
  it("wraps the sheet in a document that opens on its own", () => {
    const out = standalonePrintDocument("<div class='load-plan'>x</div>", "Dallas");
    expect(out.startsWith("<!doctype html>")).toBe(true);
    expect(out).toContain("<title>Dallas</title>");
    expect(out).toContain("<div class='load-plan'>x</div>");
    // Print margins, so the copy prints like the original rather than
    // wherever the browser's defaults happen to fall.
    expect(out).toContain("@page");
  });

  it("escapes the title, which comes from whatever the user typed", () => {
    const out = standalonePrintDocument("", 'Load "A" <b>');
    expect(out).toContain("<title>Load &quot;A&quot; &lt;b&gt;</title>");
  });
});
