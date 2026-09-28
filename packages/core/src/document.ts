import type { Entity, EntityId } from "./entities";
import type { Group, GroupId } from "./groups";
import type { Constraint, ConstraintId } from "./constraints";
import { DOCUMENT_VERSION, sanitizeRecords, type DocSettings, type DocumentJson, type TableRecord } from "./tables";

/**
 * The drawing document: a flat store of entities, a registry of groups
 * over them (see groups.ts), a constraint list (see constraints.ts), the
 * named tables (layers, blocks, styles… — see tables.ts) and the document
 * settings.
 *
 * Deliberately dumb — all mutations go through the CommandBus so that
 * every change is serializable, undoable, and (later) producible by an
 * AI assistant or a constraint solver.
 */
export class SketchDocument {
  private entities = new Map<EntityId, Entity>();
  private groupsMap = new Map<GroupId, Group>();
  private constraintsMap = new Map<ConstraintId, Constraint>();
  /** Named tables, in insertion order — a record's position is its order in the layer panel, style list, etc. */
  private tablesMap = new Map<string, Map<string, TableRecord>>();
  private settingsValue: DocSettings = {};
  /** Bumped on every mutation; cheap dirty-check for renderers. */
  revision = 0;
  /** Bumped on every table or settings mutation, so views of them (the layer list) refresh only when they changed. */
  tablesRevision = 0;

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

  /**
   * Every entity id under `groupId`, recursively flattening nested groups.
   * Skips members that no longer exist, and visits each group at most once —
   * group membership arrives as plain `Command` data, so a cycle (or a group
   * reachable by two paths) is possible and must not recurse forever.
   */
  groupEntityIds(groupId: GroupId): EntityId[] {
    const out: EntityId[] = [];
    const visited = new Set<GroupId>();
    const walk = (id: GroupId): void => {
      if (visited.has(id)) return;
      visited.add(id);
      const group = this.groupsMap.get(id);
      if (!group) return;
      for (const m of group.members) {
        if (this.groupsMap.has(m)) walk(m);
        else if (this.entities.has(m)) out.push(m);
      }
    };
    walk(groupId);
    return out;
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

  /* ------------------------------- tables -------------------------------- */

  /** The records of `table` in order (empty for a table nothing has written to). */
  records(table: string): TableRecord[] {
    return [...(this.tablesMap.get(table)?.values() ?? [])];
  }

  getRecord(table: string, name: string): TableRecord | undefined {
    return this.tablesMap.get(table)?.get(name);
  }

  hasRecord(table: string, name: string): boolean {
    return this.tablesMap.get(table)?.has(name) ?? false;
  }

  /** Every table that has at least one record. */
  tableNames(): string[] {
    return [...this.tablesMap.entries()].filter(([, m]) => m.size > 0).map(([n]) => n);
  }

  /**
   * Internal — used by the command bus only. Replaces the record of that name
   * in place, else inserts it at `index` (default: the end).
   */
  _putRecord(table: string, record: TableRecord, index?: number): void {
    let map = this.tablesMap.get(table);
    if (!map) {
      map = new Map();
      this.tablesMap.set(table, map);
    }
    if (map.has(record.name) || index === undefined || index >= map.size) {
      map.set(record.name, record);
    } else {
      const entries = [...map.entries()];
      entries.splice(Math.max(0, index), 0, [record.name, record]);
      map.clear();
      for (const [k, v] of entries) map.set(k, v);
    }
    this.tablesRevision += 1;
    this.revision += 1;
  }

  /** Internal — used by the command bus only. */
  _removeRecord(table: string, name: string): void {
    if (this.tablesMap.get(table)?.delete(name)) {
      this.tablesRevision += 1;
      this.revision += 1;
    }
  }

  /** Internal — used by the command bus only. Renames keeping the record's position. */
  _renameRecord(table: string, from: string, to: string): void {
    const map = this.tablesMap.get(table);
    if (!map || !map.has(from)) return;
    const entries = [...map.entries()].map(([k, v]) => (k === from ? ([to, { ...v, name: to }] as [string, TableRecord]) : ([k, v] as [string, TableRecord])));
    map.clear();
    for (const [k, v] of entries) map.set(k, v);
    this.tablesRevision += 1;
    this.revision += 1;
  }

  /** The document settings (a copy — change them with the `set-settings` command). */
  get settings(): DocSettings {
    return { ...this.settingsValue };
  }

  /** Internal — used by the command bus only. A `null` or `undefined` value removes the key. */
  _patchSettings(patch: DocSettings): void {
    const next = { ...this.settingsValue };
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined || v === null) delete next[k];
      else next[k] = v;
    }
    this.settingsValue = next;
    this.tablesRevision += 1;
    this.revision += 1;
  }

  /* ------------------------------ serialisation ------------------------------ */

  toJSON(): {
    version: typeof DOCUMENT_VERSION;
    entities: Entity[];
    groups: Group[];
    constraints: Constraint[];
    tables: Record<string, TableRecord[]>;
    settings: DocSettings;
  } {
    const tables: Record<string, TableRecord[]> = {};
    for (const name of this.tableNames()) tables[name] = this.records(name);
    return {
      version: DOCUMENT_VERSION,
      entities: this.all(),
      groups: this.groups(),
      constraints: this.constraints(),
      tables,
      settings: this.settings,
    };
  }

  /**
   * Reads any document version (1, 2 or 3, or none) and never throws on the
   * parts it can skip: a malformed record or an unknown table name is kept or
   * dropped, not fatal — a document from a newer build should still open.
   */
  static fromJSON(json: DocumentJson): SketchDocument {
    const doc = new SketchDocument();
    for (const e of json.entities ?? []) doc._put(e);
    for (const g of json.groups ?? []) doc._putGroup(g);
    for (const c of json.constraints ?? []) doc._putConstraint(c);
    if (json.tables && typeof json.tables === "object") {
      for (const [table, raw] of Object.entries(json.tables)) {
        for (const record of sanitizeRecords(raw)) doc._putRecord(table, record);
      }
    }
    if (json.settings && typeof json.settings === "object" && !Array.isArray(json.settings)) doc._patchSettings(json.settings);
    return doc;
  }
}
