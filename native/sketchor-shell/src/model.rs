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
    /// Any entity kind we don't render yet (arc, polyline, ...). Silently
    /// skipped rather than failing the whole parse.
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
        }
    }

    if min_x <= max_x && min_y <= max_y {
        Some(Bounds { min_x, min_y, max_x, max_y })
    } else {
        None
    }
}
