//! Parsing of Sketchor's native document format (`.sketchor`) into a flat
//! list of drawable shapes.
//!
//! The on-disk format is the JSON produced by `SketchDocument.toJSON()` in
//! `@sketchor/core`:
//!
//! ```json
//! { "version": 1, "entities": [
//!   { "id": "e1", "type": "line",   "a": {"x":0,"y":0}, "b": {"x":100,"y":0} },
//!   { "id": "e2", "type": "circle", "center": {"x":50,"y":30}, "radius": 15 }
//! ] }
//! ```
//!
//! Kept intentionally tolerant: unknown entity types and extra fields are
//! ignored so newer documents still thumbnail on older shells.

use serde::Deserialize;

#[derive(Clone, Copy, Debug)]
pub struct Pt {
    pub x: f64,
    pub y: f64,
}

/// A drawable primitive. Mirrors the reduced shape set the GDI rasteriser
/// understands; higher-level entity kinds are lowered to these.
#[derive(Clone, Copy, Debug)]
pub enum Shape {
    Line(Pt, Pt),
    Circle(Pt, f64),
    /// center, radius, start angle, end angle (radians), sweep-is-counterclockwise.
    /// Mirrors `ArcEntity` in `@sketchor/core` exactly — see its doc comment.
    Arc(Pt, f64, f64, f64, bool),
}

const TAU: f64 = std::f64::consts::PI * 2.0;

/// Magnitude of the sweep (0, TAU] from `start` to `end`; mirrors the
/// TypeScript `arcSweep` in `packages/core/src/geometry.ts`.
pub fn arc_sweep(start: f64, end: f64, ccw: bool) -> f64 {
    let raw = if ccw { end - start } else { start - end };
    let s = ((raw % TAU) + TAU) % TAU;
    if s == 0.0 {
        TAU
    } else {
        s
    }
}

pub fn arc_point_at(center: Pt, radius: f64, angle: f64) -> Pt {
    Pt {
        x: center.x + radius * angle.cos(),
        y: center.y + radius * angle.sin(),
    }
}

fn angle_in_sweep(angle: f64, start: f64, end: f64, ccw: bool) -> bool {
    let sweep = arc_sweep(start, end, ccw);
    let raw = if ccw { angle - start } else { start - angle };
    let rel = ((raw % TAU) + TAU) % TAU;
    rel <= sweep + 1e-9
}

/// Points needed to bound an arc precisely: its two ends plus any
/// axis-aligned extrema it sweeps through.
fn arc_extent_points(center: Pt, radius: f64, start: f64, end: f64, ccw: bool) -> Vec<Pt> {
    let mut pts = vec![
        arc_point_at(center, radius, start),
        arc_point_at(center, radius, end),
    ];
    for k in [0.0, std::f64::consts::FRAC_PI_2, std::f64::consts::PI, 3.0 * std::f64::consts::FRAC_PI_2] {
        if angle_in_sweep(k, start, end, ccw) {
            pts.push(arc_point_at(center, radius, k));
        }
    }
    pts
}

/* --------------------------- JSON schema ---------------------------- */

#[derive(Deserialize)]
struct JsonPoint {
    #[serde(default)]
    x: f64,
    #[serde(default)]
    y: f64,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum JsonEntity {
    Line {
        a: JsonPoint,
        b: JsonPoint,
    },
    Circle {
        center: JsonPoint,
        radius: f64,
    },
    Arc {
        center: JsonPoint,
        radius: f64,
        #[serde(rename = "startAngle")]
        start_angle: f64,
        #[serde(rename = "endAngle")]
        end_angle: f64,
        #[serde(default)]
        ccw: bool,
    },
    /// Any entity kind we don't render yet (polyline, block-ref, ...).
    /// Silently skipped rather than failing the whole parse.
    #[serde(other)]
    Unknown,
}

#[derive(Deserialize)]
struct JsonDoc {
    #[serde(default)]
    entities: Vec<JsonEntity>,
}

/// Parse a `.sketchor` document, returning the shapes it can draw. A
/// malformed file yields an empty list rather than an error, so the shell
/// still gets a (blank) thumbnail instead of falling back to a generic
/// icon mid-render.
pub fn parse(text: &str) -> Vec<Shape> {
    let doc: JsonDoc = match serde_json::from_str(text) {
        Ok(d) => d,
        Err(_) => return Vec::new(),
    };
    let mut shapes = Vec::with_capacity(doc.entities.len());
    for e in doc.entities {
        match e {
            JsonEntity::Line { a, b } => shapes.push(Shape::Line(
                Pt { x: a.x, y: a.y },
                Pt { x: b.x, y: b.y },
            )),
            JsonEntity::Circle { center, radius } if radius.is_finite() && radius > 0.0 => {
                shapes.push(Shape::Circle(Pt { x: center.x, y: center.y }, radius))
            }
            JsonEntity::Arc {
                center,
                radius,
                start_angle,
                end_angle,
                ccw,
            } if radius.is_finite() && radius > 0.0 => shapes.push(Shape::Arc(
                Pt { x: center.x, y: center.y },
                radius,
                start_angle,
                end_angle,
                ccw,
            )),
            _ => {}
        }
    }
    shapes
}

/* ------------------------------ bounds ------------------------------ */

pub struct Bounds {
    pub min_x: f64,
    pub min_y: f64,
    pub max_x: f64,
    pub max_y: f64,
}

/// Axis-aligned bounding box of all shapes (circles expanded by radius).
/// Returns `None` when there is nothing finite to frame.
pub fn bounds(shapes: &[Shape]) -> Option<Bounds> {
    let mut min_x = f64::INFINITY;
    let mut min_y = f64::INFINITY;
    let mut max_x = f64::NEG_INFINITY;
    let mut max_y = f64::NEG_INFINITY;

    let mut acc = |x: f64, y: f64| {
        if x.is_finite() && y.is_finite() {
            min_x = min_x.min(x);
            min_y = min_y.min(y);
            max_x = max_x.max(x);
            max_y = max_y.max(y);
        }
    };

    for s in shapes {
        match s {
            Shape::Line(a, b) => {
                acc(a.x, a.y);
                acc(b.x, b.y);
            }
            Shape::Circle(c, r) => {
                acc(c.x - r, c.y - r);
                acc(c.x + r, c.y + r);
            }
            Shape::Arc(c, r, start, end, ccw) => {
                for p in arc_extent_points(*c, *r, *start, *end, *ccw) {
                    acc(p.x, p.y);
                }
            }
        }
    }

    if min_x <= max_x && min_y <= max_y {
        Some(Bounds { min_x, min_y, max_x, max_y })
    } else {
        None
    }
}
