/**
 * Hex handle allocation for the AC1032 writer (X-01). Every TABLE, BLOCK,
 * entity and OBJECTS record in a modern DXF carries a unique handle (group
 * 5, or 105 for DIMSTYLE table entries) plus an owner pointer (group 330) to
 * the record that contains it — unlike R12, which needs none of this.
 *
 * Handles only need to be unique and hex; nothing reads meaning into their
 * value. We allocate sequentially and record `$HANDSEED` one past the
 * highest handle issued, as the spec requires.
 */
export class HandleAllocator {
  private counter: number;

  constructor(start = 0x10) {
    this.counter = start;
  }

  alloc(): string {
    const h = this.counter.toString(16).toUpperCase();
    this.counter++;
    return h;
  }

  /** `$HANDSEED`: one past the highest handle issued so far. */
  seed(): string {
    return this.counter.toString(16).toUpperCase();
  }
}
