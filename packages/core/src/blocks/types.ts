import type { Constraint } from "../constraints";
import type { Entity } from "../entities";
import type { Point } from "../geometry";
import type { TableRecord } from "../tables";

/** B-05 attribute definition — authored in the block editor; values live on the insert. */
export interface AttributeDef {
  tag: string;
  prompt?: string;
  default?: string;
  /** Local position of the attribute text. */
  at: Point;
  height: number;
  rotation: number;
  textStyle?: string;
  flags?: { invisible?: boolean; constant?: boolean; verify?: boolean; preset?: boolean; multiline?: boolean };
  fieldExpr?: string;
}

/**
 * A record of the `blocks` table (B-01). `entities` are in local coordinates
 * with their own ids; an `insert` entity shows them under
 * translate(insert) · rotate · scale · translate(-basePoint).
 */
export interface BlockDefinition extends TableRecord {
  name: string;
  basePoint: Point;
  entities: Entity[];
  constraints?: Constraint[];
  attributeDefs: AttributeDef[];
  description?: string;
  units?: number;
  /** false = the Explode command refuses instances of this block. */
  explodable: boolean;
  /** true = instances keep scale.x === scale.y. */
  scaleUniformly: boolean;
  /** Phase 6 parametric spec; opaque here. */
  dynamic?: unknown;
  /** Cached SVG thumbnail. */
  preview?: string;
}

/** What the evaluator needs from a document: the `blocks` records and a revision that changes when any table does. */
export interface BlocksHost {
  getRecord(table: string, name: string): TableRecord | undefined;
  readonly tablesRevision: number;
}

/** Nested inserts are followed at most this deep. */
export const MAX_BLOCK_DEPTH = 8;
