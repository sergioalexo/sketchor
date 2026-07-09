//! Minimal ASCII DXF parsing + shape model, mirroring the TypeScript
//! parser in `@sketchor/core`. Arcs and polylines are approximated with
//! line segments. Kept dependency-free so it is easy to audit.

#[derive(Clone, Copy)]
pub struct Pt {
    pub x: f64,
    pub y: f64,
}

pub enum Shape {
    Line(Pt, Pt),
    Circle(Pt, f64),
}

struct Raw {
    kind: String,
    pairs: Vec<(i32, String)>,
}

fn tokenize(text: &str) -> Vec<(i32, String)> {
    let lines: Vec<&str> = text.lines().collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i + 1 < lines.len() {
        if let Ok(code) = lines[i].trim().parse::<i32>() {
            out.push((code, lines[i + 1].to_string()));
        }
        i += 2;
    }
    out
}

fn collect(pairs: &[(i32, String)]) -> Vec<Raw> {
    let mut raws = Vec::new();
    let mut in_entities = false;
    let mut current: Option<Raw> = None;

    let mut i = 0;
    while i < pairs.len() {
        let (code, value) = &pairs[i];
        let v = value.trim();
        if *code == 0 && v == "SECTION" {
            let name = pairs.get(i + 1).map(|p| p.1.trim()).unwrap_or("");
            in_entities = name == "ENTITIES";
        } else if *code == 0 && v == "ENDSEC" {
            if let Some(c) = current.take() {
                raws.push(c);
            }
            in_entities = false;
        } else if in_entities {
            if *code == 0 {
                if let Some(c) = current.take() {
                    raws.push(c);
                }
                current = Some(Raw {
                    kind: v.to_uppercase(),
                    pairs: Vec::new(),
                });
            } else if let Some(c) = current.as_mut() {
                c.pairs.push((*code, value.clone()));
            }
        }
        i += 1;
    }
    if let Some(c) = current.take() {
        raws.push(c);
    }
    raws
}

fn num(raw: &Raw, code: i32, fallback: f64) -> f64 {
    raw.pairs
        .iter()
        .find(|(c, _)| *c == code)
        .and_then(|(_, v)| v.trim().parse::<f64>().ok())
        .unwrap_or(fallback)
}

fn nums(raw: &Raw, code: i32) -> Vec<f64> {
    raw.pairs
        .iter()
        .filter(|(c, _)| *c == code)
        .filter_map(|(_, v)| v.trim().parse::<f64>().ok())
        .collect()
}

fn arc_to_lines(cx: f64, cy: f64, r: f64, a0deg: f64, a1deg: f64, out: &mut Vec<Shape>) {
    let a0 = a0deg.to_radians();
    let mut sweep = (a1deg - a0deg).rem_euclid(360.0);
    if sweep == 0.0 {
        sweep = 360.0;
    }
    let steps = ((sweep / 6.0).ceil() as i32).clamp(2, 64);
    let mut prev = Pt {
        x: cx + r * a0.cos(),
        y: cy + r * a0.sin(),
    };
    for i in 1..=steps {
        let a = a0 + sweep.to_radians() * (i as f64 / steps as f64);
        let p = Pt {
            x: cx + r * a.cos(),
            y: cy + r * a.sin(),
        };
        out.push(Shape::Line(prev, p));
        prev = p;
    }
}

pub fn parse(text: &str) -> Vec<Shape> {
    let raws = collect(&tokenize(text));
    let mut out = Vec::new();

    // Legacy POLYLINE/VERTEX stitching state.
    let mut poly: Option<Vec<Pt>> = None;
    let mut poly_closed = false;
    let flush_poly = |poly: &mut Option<Vec<Pt>>, closed: &mut bool, out: &mut Vec<Shape>| {
        if let Some(v) = poly.take() {
            if v.len() > 1 {
                for i in 0..v.len() - 1 {
                    out.push(Shape::Line(v[i], v[i + 1]));
                }
                if *closed && v.len() > 2 {
                    out.push(Shape::Line(v[v.len() - 1], v[0]));
                }
            }
        }
        *closed = false;
    };

    for raw in &raws {
        match raw.kind.as_str() {
            "LINE" => out.push(Shape::Line(
                Pt {
                    x: num(raw, 10, 0.0),
                    y: num(raw, 20, 0.0),
                },
                Pt {
                    x: num(raw, 11, 0.0),
                    y: num(raw, 21, 0.0),
                },
            )),
            "CIRCLE" => {
                let r = num(raw, 40, 0.0);
                if r > 0.0 {
                    out.push(Shape::Circle(
                        Pt {
                            x: num(raw, 10, 0.0),
                            y: num(raw, 20, 0.0),
                        },
                        r,
                    ));
                }
            }
            "ARC" => {
                let r = num(raw, 40, 0.0);
                if r > 0.0 {
                    arc_to_lines(
                        num(raw, 10, 0.0),
                        num(raw, 20, 0.0),
                        r,
                        num(raw, 50, 0.0),
                        num(raw, 51, 0.0),
                        &mut out,
                    );
                }
            }
            "LWPOLYLINE" => {
                let xs = nums(raw, 10);
                let ys = nums(raw, 20);
                let closed = (num(raw, 70, 0.0) as i64) & 1 == 1;
                let n = xs.len().min(ys.len());
                let verts: Vec<Pt> = (0..n).map(|i| Pt { x: xs[i], y: ys[i] }).collect();
                for i in 0..verts.len().saturating_sub(1) {
                    out.push(Shape::Line(verts[i], verts[i + 1]));
                }
                if closed && verts.len() > 2 {
                    out.push(Shape::Line(verts[verts.len() - 1], verts[0]));
                }
            }
            "POLYLINE" => {
                flush_poly(&mut poly, &mut poly_closed, &mut out);
                poly = Some(Vec::new());
                poly_closed = (num(raw, 70, 0.0) as i64) & 1 == 1;
            }
            "VERTEX" => {
                if let Some(v) = poly.as_mut() {
                    v.push(Pt {
                        x: num(raw, 10, 0.0),
                        y: num(raw, 20, 0.0),
                    });
                }
            }
            "SEQEND" => flush_poly(&mut poly, &mut poly_closed, &mut out),
            _ => {}
        }
    }
    flush_poly(&mut poly, &mut poly_closed, &mut out);
    out
}

pub struct Bounds {
    pub min_x: f64,
    pub min_y: f64,
    pub max_x: f64,
    pub max_y: f64,
}

pub fn bounds(shapes: &[Shape]) -> Option<Bounds> {
    let mut b = Bounds {
        min_x: f64::INFINITY,
        min_y: f64::INFINITY,
        max_x: f64::NEG_INFINITY,
        max_y: f64::NEG_INFINITY,
    };
    let mut acc = |x: f64, y: f64| {
        b.min_x = b.min_x.min(x);
        b.min_y = b.min_y.min(y);
        b.max_x = b.max_x.max(x);
        b.max_y = b.max_y.max(y);
    };
    for s in shapes {
        match s {
            Shape::Line(a, c) => {
                acc(a.x, a.y);
                acc(c.x, c.y);
            }
            Shape::Circle(c, r) => {
                acc(c.x - r, c.y - r);
                acc(c.x + r, c.y + r);
            }
        }
    }
    if b.min_x.is_finite() {
        Some(b)
    } else {
        None
    }
}
