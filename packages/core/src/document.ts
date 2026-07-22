import type { Entity, EntityId } from "./entities";
import type { Group, GroupId } from "./groups";

/**
 * The drawing document: a flat store of entities, plus a registry of
 * groups over them (see groups.ts).
 *
 * Deliberately dumb — all mutations go through the CommandBus so that
 * every change is serializable, undoable, and (later) producible by an
 * AI assistant or a constraint solver.
 */
export class SketchDocument {
  private entities = new Map<EntityId, Entity>();
  private groupsMap = new Map<GroupId, Group>();
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

  getGroup(id: GroupId): Group | undefined {
    return this.groupsMap.get(id);
  }

  groups(): Group[] {
    return [...this.groupsMap.values()];
  }

  /** Internal — used by the command bus only. */
  _putGroup(group: Group): void {
    this.groupsMap.set(group.id, group);
    this.revision += 1;
  }

  /** Internal — used by the command bus only. */
  _removeGroup(id: GroupId): void {
    this.groupsMap.delete(id);
    this.revision += 1;
  }

  /** The group (if any) that directly lists `memberId` (an entity or nested group) as a member. */
  groupContaining(memberId: EntityId | GroupId): Group | undefined {
    for (const g of this.groupsMap.values()) {
      if (g.members.includes(memberId)) return g;
    }
    return undefined;
  }

  /** Walks up the parent chain from `id`'s group to the outermost containing group. */
  topLevelGroupOf(id: EntityId): Group | undefined {
    let current = this.groupContaining(id);
    if (!current) return undefined;
    const seen = new Set<GroupId>();
    while (current.parent && !seen.has(current.id)) {
      seen.add(current.id);
      const parent = this.groupsMap.get(current.parent);
      if (!parent) break;
      current = parent;
    }
    return current;
  }

  /** Every entity id under `groupId`, recursively flattening nested groups. Skips members that no longer exist. */
  groupEntityIds(groupId: GroupId): EntityId[] {
    const group = this.groupsMap.get(groupId);
    if (!group) return [];
    const out: EntityId[] = [];
    for (const m of group.members) {
      if (this.groupsMap.has(m)) out.push(...this.groupEntityIds(m));
      else if (this.entities.has(m)) out.push(m);
    }
    return out;
  }

  toJSON(): { version: 2; entities: Entity[]; groups: Group[] } {
    return { version: 2, entities: this.all(), groups: this.groups() };
  }

  static fromJSON(json: { entities: Entity[]; groups?: Group[] }): SketchDocument {
    const doc = new SketchDocument();
    for (const e of json.entities) doc._put(e);
    for (const g of json.groups ?? []) doc._putGroup(g);
    return doc;
  }
}
