import { showcaseCommands } from "@sketchor/core";
import { isTauri } from "../update/updateService";
import { bus, doc, useApp } from "../state/store";
import { shouldLoadDemo } from "./policy";

const SEEN_KEY = "sketchor.demoSeen.v1";

function readSeen(): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) === "1";
  } catch {
    return false;
  }
}

function markSeen(): void {
  try {
    localStorage.setItem(SEEN_KEY, "1");
  } catch {
    // storage blocked: the demo may show again next time, which is harmless
  }
}

/** Loads the built-in showcase into the (empty) first tab as one undoable step, then remembers it was shown. */
export function initFirstOpenDemo(): void {
  const empty = doc.all().length === 0;
  if (!shouldLoadDemo(window.location.search, readSeen(), isTauri(), empty)) return;
  // `?demo` never replaces a drawing that already has content.
  if (!empty) return;
  bus.execute({ type: "batch", commands: showcaseCommands() });
  useApp.getState().syncLayersFromDoc(true);
  useApp.getState().requestFit();
  markSeen();
}
