import { parseClipboard, pasteCommands, payloadBase, serializeSelection, type Point } from "@sketchor/core";
import { bus, doc, useApp } from "../state/store";

/**
 * Copy / cut / paste for the drawing (roadmap T-11), on top of
 * @sketchor/core's clipboard.ts. The system clipboard gets the sketch-code
 * text (so a copy can go straight into a chat or an editor); a copy of the
 * same text is kept here too, because reading the system clipboard back is
 * permission-gated in browsers and may simply be refused — an in-app paste
 * must still work then.
 */

let internal = "";

export async function copySelectionToClipboard(
  ids: readonly string[],
  cut: boolean,
  options: { internalOnly?: boolean } = {},
): Promise<void> {
  const text = serializeSelection(doc, ids);
  if (!text) return;
  internal = text;
  if (!options.internalOnly) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      /* clipboard write refused — the in-app copy still pastes */
    }
  }
  if (cut) {
    bus.execute({ type: "delete-entities", ids: [...ids] });
    useApp.getState().setSelection([]);
  }
}

/**
 * Pastes whatever is on the clipboard (system first, falling back to the
 * in-app copy). `at` positions the payload's bottom-left corner there;
 * null pastes in place, plus `offset`. Returns the new entity ids.
 */
export async function pasteFromClipboard(at: Point | null, offset: Point = { x: 0, y: 0 }): Promise<string[]> {
  let text = "";
  try {
    text = await Promise.race([navigator.clipboard.readText(), new Promise<string>((r) => setTimeout(() => r(""), 800))]);
  } catch {
    text = "";
  }
  let payload = text ? parseClipboard(text) : null;
  if (!payload && internal) payload = parseClipboard(internal);
  if (!payload) return [];
  const base = payloadBase(payload);
  const shift = at && base ? { x: at.x - base.x + offset.x, y: at.y - base.y + offset.y } : offset;
  const { commands, ids } = pasteCommands(payload, shift);
  if (commands.length === 0) return [];
  bus.execute({ type: "batch", commands });
  useApp.getState().syncLayersFromDoc?.();
  return ids;
}
