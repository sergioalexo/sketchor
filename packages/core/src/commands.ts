import type { Entity, EntityId } from "./entities";
import { transformed, translated } from "./entities";
import type { Point } from "./geometry";
import type { SketchDocument } from "./document";

/**
 * Every mutation of the document is a plain-data command.
 *
 * This is the seam where future integrations plug in: an AI assistant,
 * a parametric constraint solver, or a collaboration layer all just
 * produce Command values — they never touch the document directly.
 */
export type Command =
  | { type: "add-entity"; entity: Entity }
  | { type: "delete-entities"; ids: EntityId[] }
  | { type: "move-entities"; ids: EntityId[]; dx: number; dy: number }
  | { type: "update-entity"; entity: Entity }
  | {
      type: "transform-entities";
      ids: EntityId[];
      pivot: Point;
      dx?: number;
      dy?: number;
      rotation?: number;
      scale?: number;
    }
  | { type: "batch"; commands: Command[] };

interface HistoryEntry {
  command: Command;
  inverse: Command[];
}

export class CommandBus {
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  private listeners = new Set<() => void>();

  constructor(readonly doc: SketchDocument) {}

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  execute(command: Command): void {
    const inverse = this.apply(command);
    this.undoStack.push({ command, inverse });
    this.redoStack = [];
    this.emit();
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  undo(): void {
    const entry = this.undoStack.pop();
    if (!entry) return;
    for (const inv of entry.inverse) this.apply(inv);
    this.redoStack.push(entry);
    this.emit();
  }

  redo(): void {
    const entry = this.redoStack.pop();
    if (!entry) return;
    entry.inverse = this.apply(entry.command);
    this.undoStack.push(entry);
    this.emit();
  }

  /** Applies a command and returns the commands that revert it. */
  private apply(command: Command): Command[] {
    const doc = this.doc;
    switch (command.type) {
      case "add-entity": {
        doc._put(command.entity);
        return [{ type: "delete-entities", ids: [command.entity.id] }];
      }
      case "delete-entities": {
        const inverse: Command[] = [];
        for (const id of command.ids) {
          const existing = doc.get(id);
          if (existing) {
            inverse.push({ type: "add-entity", entity: existing });
            doc._remove(id);
          }
        }
        return inverse;
      }
      case "move-entities": {
        for (const id of command.ids) {
          const existing = doc.get(id);
          if (existing) doc._put(translated(existing, command.dx, command.dy));
        }
        return [
          {
            type: "move-entities",
            ids: command.ids,
            dx: -command.dx,
            dy: -command.dy,
          },
        ];
      }
      case "update-entity": {
        const previous = doc.get(command.entity.id);
        doc._put(command.entity);
        return previous
          ? [{ type: "update-entity", entity: previous }]
          : [{ type: "delete-entities", ids: [command.entity.id] }];
      }
      case "transform-entities": {
        const inverse: Command[] = [];
        for (const id of command.ids) {
          const existing = doc.get(id);
          if (!existing) continue;
          inverse.push({ type: "update-entity", entity: existing });
          doc._put(
            transformed(
              existing,
              command.pivot,
              command.dx ?? 0,
              command.dy ?? 0,
              command.rotation ?? 0,
              command.scale ?? 1,
            ),
          );
        }
        return inverse;
      }
      case "batch": {
        const inverse: Command[] = [];
        for (const child of command.commands) {
          inverse.unshift(...this.apply(child));
        }
        return inverse;
      }
    }
  }
}
