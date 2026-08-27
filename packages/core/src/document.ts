import type { Entity, EntityId } from "./entities";
import type { Group, GroupId } from "./groups";
import type { Constraint, ConstraintId } from "./constraints";
import type { Json } from "./meta";

/**
 * The drawing document: a flat store of entities, a registry of groups
 * over them (see groups.ts), and a constraint list (see constraints.ts —
 * scaffolding only; nothing reads these yet, see R2's status).
 *
 * Deliberately dumb — all mutations go through the CommandBus so that
 * every change is serializable, undoable, and (later) producible by an
 * AI assistant or a constraint solver.
 */
export class SketchDocument {
  private entities = new Map<EntityId, Entity>();
  private groupsMap = new Map<GroupId, Group>();
  private constraintsMap = new Map<ConstraintId, Constraint>();
  /** `meta.get(pluginId).get(targetId)` — see meta.ts. Empty inner maps are never left lying around (see `_setMeta`/`_clearMeta`). */
  private metaMap = new Map<string, Map<string, Json>>();
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

  /** A plugin's stored value for one entity or group, or `undefined` if it never set one. */
  getMeta(pluginId: string, targetId: EntityId | GroupId): Json | undefined {
    return this.metaMap.get(pluginId)?.get(targetId);
  }

  /** Every `targetId -> value` pair a plugin has stored — e.g. so it can rebuild its item catalogue from the document on load. */
  metaFor(pluginId: string): Record<string, Json> {
    const inner = this.metaMap.get(pluginId);
    return inner ? Object.fromEntries(inner) : {};
  }

  /** Internal — used by the command bus only. */
  _setMeta(pluginId: string, targetId: EntityId | GroupId, value: Json): void {
    let inner = this.metaMap.get(pluginId);
    if (!inner) {
      inner = new Map();
      this.metaMap.set(pluginId, inner);
    }
    inner.set(targetId, value);
    this.revision += 1;
  }

  /** Internal — used by the command bus only. */
  _clearMeta(pluginId: string, targetId: EntityId | GroupId): void {
    const inner = this.metaMap.get(pluginId);
    if (!inner) return;
    inner.delete(targetId);
    if (inner.size === 0) this.metaMap.delete(pluginId);
    this.revision += 1;
  }

  getConstraint(id: ConstraintId): Constraint | undefined {
    return this.constraintsMap.get(id);
  }

  constraints(): Constraint[] {
    return [...this.constraintsMap.values()];
  }

  /** Internal — used by the command bus only. */
  _putConstraint(constraint: Constraint): void {
    this.constraintsMap.set(constraint.id, constraint);
    this.revision += 1;
  }

  /** Internal — used by the command bus only. */
  _removeConstraint(id: ConstraintId): void {
    this.constraintsMap.delete(id);
    this.revision += 1;
  }

  toJSON(): {
    version: 3;
    entities: Entity[];
    groups: Group[];
    constraints: Constraint[];
    meta: Record<string, Record<string, Json>>;
  } {
    const meta: Record<string, Record<string, Json>> = {};
    for (const [pluginId, inner] of this.metaMap) meta[pluginId] = Object.fromEntries(inner);
    return { version: 3, entities: this.all(), groups: this.groups(), constraints: this.constraints(), meta };
  }

  static fromJSON(json: {
    entities: Entity[];
    groups?: Group[];
    constraints?: Constraint[];
    /** Absent on documents saved before version 3 — plugins simply start with no stored data. */
    meta?: Record<string, Record<string, Json>>;
  }): SketchDocument {
    const doc = new SketchDocument();
    for (const e of json.entities) doc._put(e);
    for (const g of json.groups ?? []) doc._putGroup(g);
    for (const c of json.constraints ?? []) doc._putConstraint(c);
    for (const [pluginId, inner] of Object.entries(json.meta ?? {})) {
      for (const [targetId, value] of Object.entries(inner)) doc._setMeta(pluginId, targetId, value);
    }
    return doc;
  }
}
