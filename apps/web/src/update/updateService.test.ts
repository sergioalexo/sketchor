import { describe, expect, it } from "vitest";
import { canInstallUnattended, isNewer, shouldAutoDownload } from "./updateService";

/**
 * The updater is the one subsystem that can close the app out from under the
 * user and replace its own binary. Two things have to hold, and neither is
 * visible until it has already gone wrong on someone's machine:
 *
 * - `isNewer` gates *every* update. Get it wrong one way and nobody is ever
 *   offered a release; wrong the other way and the app offers to "update" to
 *   the version it is already running, forever.
 * - The unattended path installs without being asked, and installing hands
 *   control to the NSIS installer, which closes Sketchor. If that can happen
 *   while a tab is unsaved, the update eats the user's drawing.
 */

describe("isNewer", () => {
  it("compares dotted versions numerically, not as strings", () => {
    // The string comparison this replaces would call 0.9.0 newer than 0.10.0.
    expect(isNewer("0.10.0", "0.9.0")).toBe(true);
    expect(isNewer("0.9.0", "0.10.0")).toBe(false);
    expect(isNewer("0.13.10", "0.13.9")).toBe(true);
  });

  it("tolerates a leading v on either side", () => {
    expect(isNewer("v0.13.3", "0.13.2")).toBe(true);
    expect(isNewer("v0.13.2", "v0.13.2")).toBe(false);
  });

  it("is false for the same version, so a release never re-offers itself", () => {
    expect(isNewer("0.13.3", "0.13.3")).toBe(false);
  });

  it("treats a missing segment as zero", () => {
    expect(isNewer("0.14", "0.13.9")).toBe(true);
    expect(isNewer("0.13", "0.13.0")).toBe(false);
  });

  it("ignores prerelease and build suffixes rather than choking on them", () => {
    expect(isNewer("0.14.0-beta.1", "0.13.3")).toBe(true);
    expect(isNewer("0.13.3+build7", "0.13.3")).toBe(false);
  });
});

describe("shouldAutoDownload", () => {
  const found = { autoUpdate: true, phase: "available", channel: "install" } as const;

  it("starts on a signed update the start-up check found", () => {
    expect(shouldAutoDownload(found)).toBe(true);
  });

  it("stays out of the way when the user turned auto-update off", () => {
    expect(shouldAutoDownload({ ...found, autoUpdate: false })).toBe(false);
  });

  it("does nothing unless a check actually found something", () => {
    for (const phase of ["idle", "checking", "up-to-date", "error", "downloaded"] as const) {
      expect(shouldAutoDownload({ ...found, phase })).toBe(false);
    }
  });

  it("never fires on the download channel — there is nothing it could install", () => {
    // That channel only knows a release page URL; auto-opening a browser at
    // launch would be a worse surprise than the update it's announcing.
    expect(shouldAutoDownload({ ...found, channel: "download" })).toBe(false);
  });
});

describe("canInstallUnattended", () => {
  it("allows the silent restart only when every tab is saved", () => {
    expect(canInstallUnattended(0)).toBe(true);
  });

  it("holds the install while any tab has unsaved changes", () => {
    expect(canInstallUnattended(1)).toBe(false);
    expect(canInstallUnattended(4)).toBe(false);
  });
});
