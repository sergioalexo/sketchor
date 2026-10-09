import type { Entity, EntityId } from "../entities";
import type { TableRecord } from "../tables";

/**
 * What a dimension needs from its document to lay itself out: entities (to
 * follow the geometry it references) and the `dimStyles` table. Like block
 * definitions (blocks/context.ts) the kind registry hands methods only the
 * entity, so `CommandBus` activates its document on construction and on every
 * execute/undo/redo; code on a bare `SketchDocument` uses {@link withDimHost}.
 */
export interface DimHost {
  get(id: EntityId): Entity | undefined;
  getRecord(table: string, name: string): TableRecord | undefined;
  readonly tablesRevision: number;
}

/** A host that serves styles but no entities: for dimensions inside block definitions, whose references mean nothing in the drawing. */
export function styleOnlyHost(host: DimHost | null): DimHost | null {
  return host ? { get: () => undefined, getRecord: (t, n) => host.getRecord(t, n), tablesRevision: host.tablesRevision } : null;
}

let active: DimHost | null = null;

export function setActiveDimHost(host: DimHost | null): void {
  active = host;
}

export function activeDimHost(): DimHost | null {
  return active;
}

export function withDimHost<T>(host: DimHost, fn: () => T): T {
  const prev = active;
  active = host;
  try {
    return fn();
  } finally {
    active = prev;
  }
}
