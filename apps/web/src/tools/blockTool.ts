import { newEntityId, uniqueBlockName } from "@sketchor/core";
import { useApp } from "../state/store";
import type { Pick, Tool, ToolContext } from "./tool";

/**
 * The Create-block tool (B-03): with objects selected, name the block in the
 * panel (blank = BLOCK1, BLOCK2, …) and click its base point. Emits one
 * `define-block` command — one undo step — and returns to Select.
 */
export class BlockTool implements Tool {
  readonly id = "block" as const;
  private error = "";

  prompt(ctx: ToolContext): string {
    if (this.error) return this.error;
    const n = ctx.selection().filter((id) => ctx.doc.has(id)).length;
    return n === 0 ? "Create block: select the objects first (Esc, then select, then B)" : `Create block from ${n} object(s): click the base point`;
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
    const ids = ctx.selection().filter((id) => ctx.doc.has(id));
    if (ids.length === 0) {
      this.error = "Create block: nothing is selected";
      ctx.redraw();
      return;
    }
    const s = useApp.getState().blockSettings;
    const name = s.name.trim() || uniqueBlockName(ctx.doc);
    if (ctx.doc.hasRecord("blocks", name)) {
      this.error = `A block named '${name}' already exists - pick another name`;
      ctx.redraw();
      return;
    }
    this.error = "";
    const insertId = newEntityId();
    ctx.execute({
      type: "define-block",
      name,
      basePoint: { x: pick.point.x, y: pick.point.y },
      ids,
      insertId,
      mode: s.mode,
      explodable: s.explodable,
      scaleUniformly: s.scaleUniformly,
      ...(s.description.trim() ? { description: s.description.trim() } : {}),
    });
    useApp.getState().setBlockSettings({ name: "" });
    ctx.setSelection(s.mode === "convert" ? [insertId] : []);
    ctx.setTool("select");
  }

  preview() {
    return [];
  }
}
