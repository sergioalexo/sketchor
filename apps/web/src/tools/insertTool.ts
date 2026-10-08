import { makeInsert, newEntityId, type Entity, type Point } from "@sketchor/core";
import { useApp } from "../state/store";
import { layerProp, type Pick, type Tool, type ToolContext } from "./tool";

/**
 * The Insert tool (B-05/B-06): the panel names the block, scale, rotation and
 * the attribute values (the prompt dialog); each click places one instance.
 * It stays active so a part can be dropped repeatedly — Esc leaves it.
 */
export class InsertTool implements Tool {
  readonly id = "insert" as const;
  private error = "";

  private build(ctx: ToolContext, at: Point, id: string) {
    const s = useApp.getState().insertSettings;
    const values: Record<string, string> = {};
    for (const [k, v] of Object.entries(s.values)) if (v !== "") values[k] = v;
    const scale = Number.isFinite(s.scale) && s.scale !== 0 ? s.scale : 1;
    return makeInsert(id, s.block, at, {
      scale: { x: scale, y: scale },
      rotation: ((Number.isFinite(s.rotation) ? s.rotation : 0) * Math.PI) / 180,
      attributes: values,
      ...layerProp(ctx.activeLayer()),
    });
  }

  prompt(ctx: ToolContext): string {
    if (this.error) return this.error;
    const s = useApp.getState().insertSettings;
    if (!s.block || !ctx.doc.hasRecord("blocks", s.block)) return "Insert: choose a block in the panel (or create one with B)";
    return `Insert ${s.block}: click the insertion point - Esc finishes`;
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
    const s = useApp.getState().insertSettings;
    if (!s.block || !ctx.doc.hasRecord("blocks", s.block)) {
      this.error = "Insert: choose a block in the panel first";
      ctx.redraw();
      return;
    }
    this.error = "";
    const id = newEntityId();
    ctx.execute({ type: "add-entity", entity: this.build(ctx, pick.point, id) });
    ctx.setSelection([id]);
  }

  preview(ctx: ToolContext, cursor: Point | null): Entity[] {
    const s = useApp.getState().insertSettings;
    if (!cursor || !s.block || !ctx.doc.hasRecord("blocks", s.block)) return [];
    return [this.build(ctx, cursor, "insert-preview")];
  }
}
