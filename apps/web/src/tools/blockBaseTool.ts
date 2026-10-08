import { setBlockEditBase } from "../state/store";
import type { Pick, Tool, ToolContext } from "./tool";

/** B-04: while editing a block, one click sets the block's base point (local coordinates). */
export class BlockBaseTool implements Tool {
  readonly id = "blockbase" as const;

  prompt(): string {
    return "Block base point: click the point instances are placed by";
  }

  busy(): boolean {
    return false;
  }

  anchor() {
    return null;
  }

  cancel(): void {}

  pick(ctx: ToolContext, pick: Pick): void {
    setBlockEditBase(pick.point);
    ctx.setTool("select");
  }

  preview() {
    return [];
  }
}
