import { describe, expect, it, vi } from "vitest";

/**
 * A plugin asks the host to print, and can name the sheet so the autosaved
 * copy lands in the folder with a useful file name rather than a date
 * stamp. The name crosses the sandbox boundary, so it is untrusted input
 * like everything else from a plugin: anything that isn't a string has to
 * be ignored rather than reaching the file system.
 */

const printHtml = vi.fn();
vi.mock("../../print/printHtml", () => ({ printHtml: (html: string, options?: unknown) => printHtml(html, options) }));
vi.mock("../../state/store", () => ({ bus: {}, doc: {}, useApp: { getState: () => ({ displayUnit: "mm" }) } }));
vi.mock("./uiManager", () => ({ hidePanel: vi.fn(), postToPanel: vi.fn(), showPanel: vi.fn(), subscribeToPanel: vi.fn() }));

const { dispatchPost } = await import("./hostMethods");
const ctx = { pluginId: "test" };

describe("ui.print options", () => {
  it("passes a plugin's file name through to the print preview", () => {
    printHtml.mockClear();
    dispatchPost(ctx, "ui.print", ["<p>sheet</p>", { fileName: "2026-09-23 Dallas" }]);
    expect(printHtml).toHaveBeenCalledWith("<p>sheet</p>", { fileName: "2026-09-23 Dallas" });
  });

  it("still prints when a plugin passes no options at all", () => {
    printHtml.mockClear();
    dispatchPost(ctx, "ui.print", ["<p>sheet</p>"]);
    expect(printHtml).toHaveBeenCalledWith("<p>sheet</p>", { fileName: undefined });
  });

  it("ignores a file name that isn't a string", () => {
    printHtml.mockClear();
    dispatchPost(ctx, "ui.print", ["<p>sheet</p>", { fileName: { toString: () => "../../etc/passwd" } }]);
    expect(printHtml).toHaveBeenCalledWith("<p>sheet</p>", { fileName: undefined });
    dispatchPost(ctx, "ui.print", ["<p>sheet</p>", "not an object"]);
    expect(printHtml).toHaveBeenLastCalledWith("<p>sheet</p>", { fileName: undefined });
  });
});
