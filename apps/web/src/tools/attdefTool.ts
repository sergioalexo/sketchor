import { type AttributeDef } from "@sketchor/core";
import { activeBlockEdit, setBlockEditAttributes, useApp } from "../state/store";
import type { Pick, Tool, ToolContext } from "./tool";

/**
 * The Attribute-definition tool (B-05): inside the block editor, click where
 * the attribute's text goes. The panel supplies tag, prompt, default, height
 * and flags; the definition is stored on the block (saved with Save).
 */
export class AttdefTool implements Tool {
  readonly id = "attdef" as const;
  private error = "";

  prompt(): string {
    if (this.error) return this.error;
    if (!activeBlockEdit()) return "Attribute: open a block for editing first (double-click an insert, or bedit NAME)";
    return "Attribute definition: set the tag in the panel, then click its text position";
  }

  busy(): boolean {
    return false;
  }

  anchor() {
    return null;
  }

  cancel(): void {
    this.error = "";
  }

  pick(ctx: ToolContext, pick: Pick): void {
    const edit = activeBlockEdit();
    if (!edit) {
      this.error = "Attribute: open a block for editing first";
      ctx.redraw();
      return;
    }
    const s = useApp.getState().attdefSettings;
    const tag = s.tag.trim().replace(/\s+/g, "_").toUpperCase();
    if (tag === "") {
      this.error = "Attribute: enter a tag in the panel";
      ctx.redraw();
      return;
    }
    if (edit.attributeDefs.some((a) => a.tag === tag)) {
      this.error = `Attribute: the tag ${tag} already exists in this block`;
      ctx.redraw();
      return;
    }
    this.error = "";
    const def: AttributeDef = {
      tag,
      at: { x: pick.point.x, y: pick.point.y },
      height: s.height > 0 ? s.height : 2.5,
      rotation: 0,
      ...(s.prompt.trim() ? { prompt: s.prompt.trim() } : {}),
      ...(s.default !== "" ? { default: s.default } : {}),
      ...(s.fieldExpr.trim() ? { fieldExpr: s.fieldExpr.trim() } : {}),
      flags: { invisible: s.invisible, constant: s.constant, verify: s.verify, preset: s.preset, multiline: s.multiline },
    };
    setBlockEditAttributes([...edit.attributeDefs, def]);
    useApp.getState().setAttdefSettings({ tag: "" });
    ctx.redraw();
  }

  preview() {
    return [];
  }
}
