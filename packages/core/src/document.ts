import type { Entity, EntityId } from "./entities";

/**
 * The drawing document: a flat store of entities.
 *
 * Deliberately dumb — all mutations go through the CommandBus so that
 * every change is serializable, undoable, and (later) producible by an
 * AI assistant or a constraint solver.
 */
export class SketchDocument {
  private entities = new Map<EntityId, Entity>();
  /** Bumped on every mutation; cheap dirty-check for renderers. */
  revision = 0;

  get(id: EntityId): Entity | undefined {
    return this.entities.get(id);
  }

  all(): Entity[] {
    return [...this.entities.values()];
  }

  has(id: EntityId): boolean {
    return this.entities.has(id);
  }

  /** Internal — used by the command bus only. */
  _put(entity: Entity): void {
    this.entities.set(entity.id, entity);
    this.revision += 1;
  }

  /** Internal — used by the command bus only. */
  _remove(id: EntityId): void {
    this.entities.delete(id);
    this.revision += 1;
  }

  toJSON(): { version: 1; entities: Entity[] } {
    return { version: 1, entities: this.all() };
  }

  static fromJSON(json: { entities: Entity[] }): SketchDocument {
    const doc = new SketchDocument();
    for (const e of json.entities) doc._put(e);
    return doc;
  }
}
