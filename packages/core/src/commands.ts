import type { Entity, EntityId } from "./entities";
import { transformed, translated } from "./entities";
import type { GroupId } from "./groups";
import type { Constraint, ConstraintId } from "./constraints";
import { solveSketch, type SolveOptions, type SolveResult } from "./solver/solve";
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
  | { type: "group-entities"; groupId: GroupId; ids: (EntityId | GroupId)[]; name?: string; parent?: GroupId }
  | { type: "ungroup"; groupId: GroupId }
  | { type: "add-constraint"; constraint: Constraint }
  | { type: "remove-constraint"; id: ConstraintId }
  | { type: "batch"; commands: Command[] };

interface HistoryEntry {
  command: Command;
  inverse: Command[];
}

export class CommandBus {
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  private listeners = new Set<() => void>();
  private solving = false;
  /**
   * What the solver said after the most recent command — degrees of
   * freedom, conflicts, redundancy. Null while the document has no
   * constraints, which is every drawing until someone adds one.
   */
  lastSolve: SolveResult | null = null;

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
    // The solver runs as a middleware here (roadmap T-40): whatever the
    // command did, the constraints then have their say, and the moves
    // they cause join the *same* undo entry. Anything else would make
    // Ctrl+Z leave a sketch that satisfies nothing.
    this.undoStack.push({ command, inverse: [...this.solveAfterCommand(), ...inverse] });
    this.redoStack = [];
    this.emit();
  }

  /**
   * Re-solves the sketch and applies what moved, returning the inverse
   * commands. No constraints, no work — and never while undoing or
   * redoing, where the recorded geometry is already solved.
   */
  private solveAfterCommand(): Command[] {
    const constraints = this.doc.constraints();
    if (this.solving || constraints.length === 0) {
      if (constraints.length === 0) this.lastSolve = null;
      return [];
    }
    this.solving = true;
    try {
      const result = solveSketch(this.doc.all(), constraints);
      this.lastSolve = result;
      const inverse: Command[] = [];
      for (const entity of result.updates) {
        inverse.unshift(...this.apply({ type: "update-entity", entity }));
      }
      return inverse;
    } finally {
      this.solving = false;
    }
  }

  /**
   * Solves without recording history — for a live drag, where the moves
   * are previewed every frame and only the final position is committed.
   */
  solveSilently(options?: SolveOptions): SolveResult | null {
    const constraints = this.doc.constraints();
    if (constraints.length === 0) return null;
    return solveSketch(this.doc.all(), constraints, options);
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
    // Undo restores geometry that was already solved, so nothing needs
    // moving — but the *verdict* has to be re-read, or the status bar goes
    // on warning about a conflict the user has just undone.
    this.refreshDiagnosis();
    this.redoStack.push(entry);
    this.emit();
  }

  /** Re-reads the solver's verdict for the current document without moving anything. */
  private refreshDiagnosis(): void {
    const constraints = this.doc.constraints();
    this.lastSolve = constraints.length === 0 ? null : solveSketch(this.doc.all(), constraints, { maxIterations: 0 });
  }

  redo(): void {
    const entry = this.redoStack.pop();
    if (!entry) return;
    // Redo re-solves for the same reason execute does: the command alone
    // doesn't describe where the constraints then put the geometry.
    const inverse = this.apply(entry.command);
    entry.inverse = [...this.solveAfterCommand(), ...inverse];
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
      case "group-entities": {
        doc._putGroup({
          id: command.groupId,
          name: command.name ?? command.groupId,
          members: command.ids,
          ...(command.parent ? { parent: command.parent } : {}),
        });
        return [{ type: "ungroup", groupId: command.groupId }];
      }
      case "ungroup": {
        const group = doc.getGroup(command.groupId);
        if (!group) return [];
        doc._removeGroup(command.groupId);
        return [
          {
            type: "group-entities",
            groupId: group.id,
            ids: group.members,
            name: group.name,
            ...(group.parent ? { parent: group.parent } : {}),
          },
        ];
      }
      case "add-constraint": {
        doc._putConstraint(command.constraint);
        return [{ type: "remove-constraint", id: command.constraint.id }];
      }
      case "remove-constraint": {
        const existing = doc.getConstraint(command.id);
        if (!existing) return [];
        doc._removeConstraint(command.id);
        return [{ type: "add-constraint", constraint: existing }];
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
