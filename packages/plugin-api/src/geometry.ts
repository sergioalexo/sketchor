/**
 * A plain 2D point. Deliberately re-declared here rather than imported from
 * `@sketchor/core` — see the package README: the plugin boundary is a type
 * boundary too, so a plugin depends on this package alone and never on
 * core's internals, even for something this small.
 */
export interface Point {
  x: number;
  y: number;
}
