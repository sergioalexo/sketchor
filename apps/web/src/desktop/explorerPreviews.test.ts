import { describe, expect, it } from "vitest";
import { shouldPromptForPreviews } from "./explorerPreviews";

/**
 * The launch-time UAC prompt for Explorer previews is "on by default", so
 * the only guard rails are these: never when the markers already exist,
 * never while an update is about to relaunch the app (the prompt would be
 * orphaned or double up), and not again within a week of a decline. Get one
 * wrong and the app either nags on every launch or never asks at all.
 */

const need = { applicable: true, needs_elevation: true };

describe("shouldPromptForPreviews", () => {
  it("prompts on a plain launch that lacks the markers", () => {
    expect(shouldPromptForPreviews(need, "idle", false)).toBe(true);
    expect(shouldPromptForPreviews(need, "up-to-date", false)).toBe(true);
  });

  it("never prompts when the markers exist or off Windows", () => {
    expect(shouldPromptForPreviews({ applicable: true, needs_elevation: false }, "idle", false)).toBe(false);
    expect(shouldPromptForPreviews({ applicable: false, needs_elevation: true }, "idle", false)).toBe(false);
  });

  it("waits out an update that is about to relaunch the app", () => {
    for (const phase of ["downloading", "downloaded", "installing", "ready"]) {
      expect(shouldPromptForPreviews(need, phase, false)).toBe(false);
    }
  });

  it("respects a recent decline", () => {
    expect(shouldPromptForPreviews(need, "idle", true)).toBe(false);
  });
});
