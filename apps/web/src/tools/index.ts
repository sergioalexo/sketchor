import type { ToolId } from "../state/store";
import { ArcTool, CircleTool, LineTool, PointTool, PolylineTool, RectangleTool } from "./drawTools";
import type { Tool } from "./tool";

/**
 * The tools that run on the framework, one instance each (their in-progress
 * state must survive re-renders and tab switches, as the old interaction
 * ref did). Tools missing here still run on Viewport.tsx's legacy switch.
 */
const TOOLS: Partial<Record<ToolId, Tool>> = {
  line: new LineTool(),
  polyline: new PolylineTool(),
  rectangle: new RectangleTool(),
  circle: new CircleTool(),
  point: new PointTool(),
  arc: new ArcTool(),
};

export function getTool(id: ToolId): Tool | null {
  return TOOLS[id] ?? null;
}

export * from "./tool";
