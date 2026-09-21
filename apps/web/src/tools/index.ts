import type { ToolId } from "../state/store";
import { ArcTool, CircleTool, LineTool, PointTool, PolygonTool, PolylineTool, RectangleTool, SlotTool } from "./drawTools";
import { ChamferTool, DivideTool, FilletTool, OffsetTool, SplitTool, TrimTool, ZoomWindowTool } from "./editTools";
import { CopyTool, MirrorTool, MoveTool, RotateTool, ScaleTool } from "./modifyTools";
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
  polygon: new PolygonTool(),
  slot: new SlotTool(),
  move: new MoveTool(),
  copy: new CopyTool(),
  rotate: new RotateTool(),
  scale: new ScaleTool(),
  mirror: new MirrorTool(),
  trim: new TrimTool(),
  split: new SplitTool(),
  fillet: new FilletTool(),
  chamfer: new ChamferTool(),
  offset: new OffsetTool(),
  zoom: new ZoomWindowTool(),
  divide: new DivideTool(),
};

export function getTool(id: ToolId): Tool | null {
  return TOOLS[id] ?? null;
}

export * from "./tool";
