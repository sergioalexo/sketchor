//! Wireframe extraction from STEP (ISO 10303-21) text, without a geometry
//! kernel — the fallback preview for Explorer thumbnails of `.step` files
//! Sketchor hasn't rendered yet (see native/dxf-thumbnailer).
//!
//! A STEP B-rep stores its topology explicitly: every `EDGE_CURVE` names its
//! two `VERTEX_POINT`s and its curve. That is enough to draw the model's
//! edges without evaluating a single surface: straight edges are the segment
//! between the vertices, circles and ellipses are arcs stepped between the
//! vertex angles, and B-spline edges are drawn through their control points.
//! Everything else degrades to a chord. The result is a wireframe a person
//! recognises at thumbnail size, not a shaded model.
//!
//! Assemblies are resolved: `NEXT_ASSEMBLY_USAGE_OCCURRENCE` gives the
//! product tree, and the `CONTEXT_DEPENDENT_SHAPE_REPRESENTATION` /
//! `ITEM_DEFINED_TRANSFORMATION` pairs place each occurrence. Without this,
//! every unique part would land at the origin on top of the others. Mapped
//! items (`MAPPED_ITEM` / `REPRESENTATION_MAP`, the other instancing scheme)
//! are handled too.
//!
//! Tolerant by design: the parser is a single linear pass, never panics on
//! malformed input, and every reference is looked up defensively. Bad input
//! yields fewer segments, never an error.

use std::collections::{HashMap, HashSet};

pub type P3 = [f64; 3];

/// A 3D line segment in the file's world coordinates.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Segment {
    pub a: P3,
    pub b: P3,
}

/// A projected 2D segment (unscaled; fit-to-box is the renderer's job).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Line2 {
    pub x1: f64,
    pub y1: f64,
    pub x2: f64,
    pub y2: f64,
}

/// Caps that keep a pathological file from running away: a thumbnail needs
/// nowhere near this much.
const MAX_SEGMENTS: usize = 2_000_000;
const MAX_INSTANCES: usize = 200_000;
const MAX_DEPTH: usize = 64;
/// Segments per full circle when stepping arcs.
const ARC_STEPS: usize = 24;

/* ------------------------------ entities ------------------------------ */

struct Entity<'a> {
    /// Body after `#id=`: `NAME(args)` or a complex `(A(..) B(..))`.
    body: &'a str,
    /// The entity's primary type name — for a complex entity, the whole body
    /// is searched by name instead, see `has`.
    name: &'a str,
    refs: Vec<u32>,
}

impl<'a> Entity<'a> {
    fn is(&self, name: &str) -> bool {
        self.name == name
    }
    /// True if this (possibly complex) entity includes the type `name`.
    fn has(&self, name: &str) -> bool {
        self.is(name) || (self.name.is_empty() && find_type(self.body, name).is_some())
    }
    /// The primary name, or the first type name of a complex entity.
    fn kind(&self) -> &'a str {
        if !self.name.is_empty() {
            return self.name;
        }
        let inner = self.body.trim_start_matches('(');
        let end = inner.find('(').unwrap_or(inner.len());
        inner[..end].trim()
    }
}

/// Splits the DATA section into `#id = body` entities. One linear pass;
/// strings (`'...'`, with `''` as the escaped quote) are respected so a `;`
/// or `#` in a part name can't derail it.
fn parse_entities(text: &str) -> HashMap<u32, Entity<'_>> {
    let mut map = HashMap::new();
    let start = match text.find("DATA;") {
        Some(i) => i + 5,
        None => return map,
    };
    let bytes = text.as_bytes();
    let mut i = start;
    let mut stmt_start = start;
    let mut in_str = false;
    while i < bytes.len() {
        let c = bytes[i];
        if in_str {
            if c == b'\'' {
                in_str = false;
            }
        } else if c == b'\'' {
            in_str = true;
        } else if c == b';' {
            let stmt = text[stmt_start..i].trim();
            stmt_start = i + 1;
            if stmt == "ENDSEC" {
                break;
            }
            if let Some(e) = parse_statement(stmt) {
                map.insert(e.0, e.1);
            }
        }
        i += 1;
    }
    map
}

fn parse_statement(stmt: &str) -> Option<(u32, Entity<'_>)> {
    let rest = stmt.strip_prefix('#')?;
    let eq = rest.find('=')?;
    let id: u32 = rest[..eq].trim().parse().ok()?;
    let body = rest[eq + 1..].trim();
    if body.is_empty() {
        return None;
    }
    let name = if body.starts_with('(') {
        ""
    } else {
        let p = body.find('(')?;
        body[..p].trim()
    };
    Some((id, Entity { body, name, refs: scan_refs(body) }))
}

/// Every `#n` in `s` outside strings, in order of appearance.
fn scan_refs(s: &str) -> Vec<u32> {
    let bytes = s.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    let mut in_str = false;
    while i < bytes.len() {
        let c = bytes[i];
        if in_str {
            if c == b'\'' {
                in_str = false;
            }
        } else if c == b'\'' {
            in_str = true;
        } else if c == b'#' {
            let mut j = i + 1;
            while j < bytes.len() && bytes[j].is_ascii_digit() {
                j += 1;
            }
            if let Ok(n) = s[i + 1..j].parse() {
                out.push(n);
            }
            i = j;
            continue;
        }
        i += 1;
    }
    out
}

/// Locates `name(` as a whole type name inside `body` (simple or complex),
/// returning the argument list slice `(...)` with its parentheses.
fn find_type<'a>(body: &'a str, name: &str) -> Option<&'a str> {
    let bytes = body.as_bytes();
    let mut from = 0;
    while let Some(pos) = body[from..].find(name) {
        let at = from + pos;
        let before_ok = at == 0 || !(bytes[at - 1].is_ascii_alphanumeric() || bytes[at - 1] == b'_');
        let after = at + name.len();
        let after_ok = after < bytes.len() && bytes[after] == b'(';
        if before_ok && after_ok {
            return balanced(body, after);
        }
        from = at + 1;
    }
    None
}

/// The slice from the `(` at `open` to its matching `)`, inclusive.
fn balanced(s: &str, open: usize) -> Option<&str> {
    let bytes = s.as_bytes();
    let mut depth = 0i32;
    let mut in_str = false;
    let mut i = open;
    while i < bytes.len() {
        let c = bytes[i];
        if in_str {
            if c == b'\'' {
                in_str = false;
            }
        } else if c == b'\'' {
            in_str = true;
        } else if c == b'(' {
            depth += 1;
        } else if c == b')' {
            depth -= 1;
            if depth == 0 {
                return Some(&s[open..=i]);
            }
        }
        i += 1;
    }
    None
}

/// Splits `(a,b,(c,d),'e,f')` into its top-level arguments.
fn top_args(list: &str) -> Vec<&str> {
    let inner = list.strip_prefix('(').and_then(|s| s.strip_suffix(')')).unwrap_or(list);
    let bytes = inner.as_bytes();
    let mut out = Vec::new();
    let mut depth = 0i32;
    let mut in_str = false;
    let mut start = 0;
    for (i, &c) in bytes.iter().enumerate() {
        if in_str {
            if c == b'\'' {
                in_str = false;
            }
        } else if c == b'\'' {
            in_str = true;
        } else if c == b'(' {
            depth += 1;
        } else if c == b')' {
            depth -= 1;
        } else if c == b',' && depth == 0 {
            out.push(inner[start..i].trim());
            start = i + 1;
        }
    }
    if start <= inner.len() {
        let last = inner[start..].trim();
        if !last.is_empty() || !out.is_empty() {
            out.push(last);
        }
    }
    out
}

/// Arguments of type `name` within an entity (simple or complex).
fn args_of<'a>(e: &Entity<'a>, name: &str) -> Option<Vec<&'a str>> {
    find_type(e.body, name).map(top_args)
}

fn ref_of(tok: &str) -> Option<u32> {
    tok.strip_prefix('#')?.trim().parse().ok()
}

fn triple(tok: &str) -> Option<P3> {
    let parts = top_args(tok);
    if parts.len() < 3 {
        return None;
    }
    let mut p = [0.0; 3];
    for k in 0..3 {
        p[k] = parts[k].parse::<f64>().ok().filter(|v| v.is_finite())?;
    }
    Some(p)
}

/* ------------------------------ geometry ------------------------------ */

/// Rigid transform: 3x3 rotation rows with a translation column.
#[derive(Clone, Copy, Debug)]
struct Mat {
    r: [[f64; 3]; 3],
    t: P3,
}

impl Mat {
    const IDENTITY: Mat = Mat { r: [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]], t: [0.0; 3] };

    fn apply(&self, p: P3) -> P3 {
        let mut out = self.t;
        for i in 0..3 {
            out[i] += self.r[i][0] * p[0] + self.r[i][1] * p[1] + self.r[i][2] * p[2];
        }
        out
    }
    /// `self ∘ other`: apply `other` first, then `self`.
    fn mul(&self, other: &Mat) -> Mat {
        let mut r = [[0.0; 3]; 3];
        for i in 0..3 {
            for j in 0..3 {
                r[i][j] = (0..3).map(|k| self.r[i][k] * other.r[k][j]).sum();
            }
        }
        Mat { r, t: self.apply(other.t) }
    }
    /// Inverse of a rigid transform (rotation part orthonormal).
    fn inverse(&self) -> Mat {
        let mut r = [[0.0; 3]; 3];
        for i in 0..3 {
            for j in 0..3 {
                r[i][j] = self.r[j][i];
            }
        }
        let rt = Mat { r, t: [0.0; 3] };
        let t = rt.apply([-self.t[0], -self.t[1], -self.t[2]]);
        Mat { r, t }
    }
    /// Frame from an origin and unit axes (columns x, y, z).
    fn from_axes(origin: P3, x: P3, y: P3, z: P3) -> Mat {
        Mat { r: [[x[0], y[0], z[0]], [x[1], y[1], z[1]], [x[2], y[2], z[2]]], t: origin }
    }
}

fn sub(a: P3, b: P3) -> P3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
fn dot(a: P3, b: P3) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
fn cross(a: P3, b: P3) -> P3 {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}
fn norm(a: P3) -> Option<P3> {
    let l = dot(a, a).sqrt();
    if l > 1e-12 && l.is_finite() {
        Some([a[0] / l, a[1] / l, a[2] / l])
    } else {
        None
    }
}
fn scaled(a: P3, s: f64) -> P3 {
    [a[0] * s, a[1] * s, a[2] * s]
}
fn add(a: P3, b: P3) -> P3 {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}

/* ------------------------------ the model ------------------------------ */

struct Model<'a> {
    ents: HashMap<u32, Entity<'a>>,
    /// Memoised local wireframe per shape representation.
    rep_cache: HashMap<u32, Vec<Segment>>,
    /// Non-transform SHAPE_REPRESENTATION_RELATIONSHIP links, symmetric.
    linked: HashMap<u32, Vec<u32>>,
    total: usize,
}

impl<'a> Model<'a> {
    fn ent(&self, id: u32) -> Option<&Entity<'a>> {
        self.ents.get(&id)
    }

    fn point(&self, id: u32) -> Option<P3> {
        let e = self.ent(id)?;
        if !e.has("CARTESIAN_POINT") {
            return None;
        }
        let args = args_of(e, "CARTESIAN_POINT")?;
        triple(args.get(1)?)
    }

    fn direction(&self, id: u32) -> Option<P3> {
        let e = self.ent(id)?;
        let args = args_of(e, "DIRECTION")?;
        norm(triple(args.get(1)?)?)
    }

    fn vertex(&self, id: u32) -> Option<P3> {
        let e = self.ent(id)?;
        if e.has("VERTEX_POINT") {
            let args = args_of(e, "VERTEX_POINT")?;
            return self.point(ref_of(args.get(1)?)?);
        }
        self.point(id)
    }

    /// AXIS2_PLACEMENT_3D as a frame; missing axes default like the spec says.
    fn placement(&self, id: u32) -> Option<Mat> {
        let e = self.ent(id)?;
        let args = args_of(e, "AXIS2_PLACEMENT_3D")?;
        let origin = self.point(ref_of(args.get(1)?)?)?;
        let z = args.get(2).and_then(|t| ref_of(t)).and_then(|r| self.direction(r)).unwrap_or([0.0, 0.0, 1.0]);
        let xr = args.get(3).and_then(|t| ref_of(t)).and_then(|r| self.direction(r));
        // Reference direction is projected perpendicular to the axis; when
        // absent (or parallel), pick any perpendicular.
        let x = xr
            .and_then(|v| norm(sub(v, scaled(z, dot(v, z)))))
            .or_else(|| norm(cross([0.0, 1.0, 0.0], z)))
            .or_else(|| norm(cross([1.0, 0.0, 0.0], z)))?;
        let y = cross(z, x);
        Some(Mat::from_axes(origin, x, y, z))
    }

    /// Segments of one edge, in the representation's local frame.
    fn edge(&self, e: &Entity<'a>, out: &mut Vec<Segment>) {
        let Some(args) = args_of(e, "EDGE_CURVE") else { return };
        let (Some(v1), Some(v2)) = (
            args.get(1).and_then(|t| ref_of(t)).and_then(|r| self.vertex(r)),
            args.get(2).and_then(|t| ref_of(t)).and_then(|r| self.vertex(r)),
        ) else {
            return;
        };
        let same_sense = args.get(4).map(|t| t.trim() != ".F.").unwrap_or(true);
        let curve = args.get(3).and_then(|t| ref_of(t)).and_then(|r| self.ent(r));
        let kind = curve.map(|c| c.kind()).unwrap_or("");
        if let Some(c) = curve {
            if kind.contains("CIRCLE") || kind.contains("ELLIPSE") {
                if self.conic(c, v1, v2, same_sense, out) {
                    return;
                }
            } else if c.has("B_SPLINE_CURVE") || c.has("B_SPLINE_CURVE_WITH_KNOTS") {
                if self.spline(c, v1, v2, out) {
                    return;
                }
            }
        }
        out.push(Segment { a: v1, b: v2 });
    }

    /// Circle or ellipse edge: stepped along the parametric direction from
    /// the start vertex's angle to the end vertex's angle (reversed when the
    /// edge runs against the curve). Coincident vertices mean a full turn.
    fn conic(&self, c: &Entity<'a>, v1: P3, v2: P3, same_sense: bool, out: &mut Vec<Segment>) -> bool {
        let (args, r1, r2) = if let Some(a) = args_of(c, "CIRCLE") {
            let r = a.get(2).and_then(|t| t.parse::<f64>().ok());
            (a, r, r)
        } else if let Some(a) = args_of(c, "ELLIPSE") {
            (a.clone(), a.get(2).and_then(|t| t.parse().ok()), a.get(3).and_then(|t| t.parse().ok()))
        } else {
            return false;
        };
        let (Some(r1), Some(r2)) = (r1, r2) else { return false };
        if !(r1 > 0.0 && r2 > 0.0) {
            return false;
        }
        let Some(frame) = args.get(1).and_then(|t| ref_of(t)).and_then(|r| self.placement(r)) else { return false };
        let x = [frame.r[0][0], frame.r[1][0], frame.r[2][0]];
        let y = [frame.r[0][1], frame.r[1][1], frame.r[2][1]];
        let c0 = frame.t;
        let angle = |p: P3| {
            let d = sub(p, c0);
            (dot(d, y) / r2).atan2(dot(d, x) / r1)
        };
        let (start, end) = if same_sense { (v1, v2) } else { (v2, v1) };
        let a1 = angle(start);
        let mut a2 = angle(end);
        let full = dot(sub(v1, v2), sub(v1, v2)).sqrt() < 1e-9 * (1.0 + r1.max(r2));
        if full {
            a2 = a1 + std::f64::consts::TAU;
        } else {
            while a2 <= a1 + 1e-9 {
                a2 += std::f64::consts::TAU;
            }
        }
        let span = a2 - a1;
        let steps = ((span / std::f64::consts::TAU) * ARC_STEPS as f64).ceil().max(1.0) as usize;
        let at = |t: f64| add(c0, add(scaled(x, r1 * t.cos()), scaled(y, r2 * t.sin())));
        let mut prev = at(a1);
        for k in 1..=steps {
            let p = at(a1 + span * k as f64 / steps as f64);
            out.push(Segment { a: prev, b: p });
            prev = p;
        }
        true
    }

    /// B-spline edge: a polyline through the control points, anchored at the vertices.
    fn spline(&self, c: &Entity<'a>, v1: P3, v2: P3, out: &mut Vec<Segment>) -> bool {
        let args = args_of(c, "B_SPLINE_CURVE_WITH_KNOTS").or_else(|| args_of(c, "B_SPLINE_CURVE"));
        let Some(args) = args else { return false };
        let list = args.iter().find(|t| t.starts_with('('));
        let Some(list) = list else { return false };
        let pts: Vec<P3> = scan_refs(list).into_iter().filter_map(|r| self.point(r)).collect();
        if pts.len() < 2 {
            return false;
        }
        let mut prev = v1;
        for p in pts.iter().skip(1).take(pts.len().saturating_sub(2)) {
            out.push(Segment { a: prev, b: *p });
            prev = *p;
        }
        out.push(Segment { a: prev, b: v2 });
        true
    }

    /// Wireframe of one shape representation in its own frame, memoised.
    /// Walks the reference graph downward from the representation's items,
    /// stopping at anything that would lead into another representation or
    /// into product/context bookkeeping.
    fn rep_segments(&mut self, sr: u32, depth: usize) -> Vec<Segment> {
        if let Some(cached) = self.rep_cache.get(&sr) {
            return cached.clone();
        }
        // Mark before descending: a self-referential mapped item terminates.
        self.rep_cache.insert(sr, Vec::new());
        let mut out = Vec::new();
        if depth > MAX_DEPTH {
            return out;
        }
        let Some(items) = self.ent(sr).and_then(|e| {
            let name = e.kind();
            find_type(e.body, name).map(top_args)
        }) else {
            return out;
        };
        let roots: Vec<u32> = items.get(1).map(|list| scan_refs(list)).unwrap_or_default();
        let mut visited: HashSet<u32> = HashSet::new();
        let mut stack: Vec<u32> = roots;
        while let Some(id) = stack.pop() {
            if !visited.insert(id) || out.len() > MAX_SEGMENTS {
                continue;
            }
            let Some(e) = self.ent(id) else { continue };
            let kind = e.kind();
            if e.has("EDGE_CURVE") {
                self.edge(e, &mut out);
                continue;
            }
            if e.has("MAPPED_ITEM") {
                if let Some((target_sr, m)) = self.mapped_item(e) {
                    let inner = self.rep_segments(target_sr, depth + 1);
                    out.extend(inner.iter().map(|s| Segment { a: m.apply(s.a), b: m.apply(s.b) }));
                }
                continue;
            }
            if kind.contains("REPRESENTATION") || kind.contains("CONTEXT") || kind.contains("PRODUCT") || kind.contains("UNIT") {
                continue;
            }
            stack.extend(e.refs.iter().copied());
        }
        self.rep_cache.insert(sr, out.clone());
        out
    }

    /// MAPPED_ITEM(name, #REPRESENTATION_MAP, #target_placement):
    /// REPRESENTATION_MAP(#origin_placement, #mapped_representation).
    /// Points of the mapped representation move from the origin frame to the
    /// target frame.
    fn mapped_item(&self, e: &Entity<'a>) -> Option<(u32, Mat)> {
        let args = args_of(e, "MAPPED_ITEM")?;
        let map = self.ent(ref_of(args.get(1)?)?)?;
        let target = self.placement(ref_of(args.get(2)?)?)?;
        let margs = args_of(map, "REPRESENTATION_MAP")?;
        let origin = self.placement(ref_of(margs.get(0)?)?)?;
        let sr = ref_of(margs.get(1)?)?;
        Some((sr, target.mul(&origin.inverse())))
    }

    /// All representations that carry a product's geometry: the ones its
    /// SHAPE_DEFINITION_REPRESENTATION names, plus anything linked to those
    /// by a transform-free SHAPE_REPRESENTATION_RELATIONSHIP (how most
    /// exporters attach the B-rep to a product's placement-only rep).
    fn reps_of(&self, direct: &[u32]) -> Vec<u32> {
        let mut seen: Vec<u32> = Vec::new();
        let mut stack: Vec<u32> = direct.to_vec();
        while let Some(sr) = stack.pop() {
            if seen.contains(&sr) {
                continue;
            }
            seen.push(sr);
            if let Some(links) = self.linked.get(&sr) {
                stack.extend(links.iter().copied());
            }
        }
        seen
    }
}

/// Extracts the wireframe of every product occurrence, in world coordinates.
pub fn parse(text: &str) -> Vec<Segment> {
    let ents = parse_entities(text);
    let mut m = Model { ents, rep_cache: HashMap::new(), linked: HashMap::new(), total: 0 };

    // product definition -> its shape representations
    let mut shapes_of: HashMap<u32, Vec<u32>> = HashMap::new();
    // NAUO id -> (parent PD, child PD)
    let mut nauo: HashMap<u32, (u32, u32)> = HashMap::new();
    // product-definition-shape id -> what it defines (PD or NAUO)
    let mut pds_def: HashMap<u32, u32> = HashMap::new();
    let mut cdsr: Vec<(u32, u32)> = Vec::new(); // (relationship, pds)

    for (&id, e) in &m.ents {
        if e.has("PRODUCT_DEFINITION_SHAPE") {
            if let Some(a) = args_of(e, "PRODUCT_DEFINITION_SHAPE") {
                if let Some(d) = a.get(2).and_then(|t| ref_of(t)) {
                    pds_def.insert(id, d);
                }
            }
        } else if e.has("NEXT_ASSEMBLY_USAGE_OCCURRENCE") {
            if let Some(a) = args_of(e, "NEXT_ASSEMBLY_USAGE_OCCURRENCE") {
                if let (Some(p), Some(c)) = (a.get(3).and_then(|t| ref_of(t)), a.get(4).and_then(|t| ref_of(t))) {
                    nauo.insert(id, (p, c));
                }
            }
        } else if e.has("CONTEXT_DEPENDENT_SHAPE_REPRESENTATION") {
            if let Some(a) = args_of(e, "CONTEXT_DEPENDENT_SHAPE_REPRESENTATION") {
                if let (Some(rr), Some(pds)) = (a.get(0).and_then(|t| ref_of(t)), a.get(1).and_then(|t| ref_of(t))) {
                    cdsr.push((rr, pds));
                }
            }
        } else if e.has("SHAPE_REPRESENTATION_RELATIONSHIP") && !e.has("REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION") {
            let a = args_of(e, "REPRESENTATION_RELATIONSHIP").or_else(|| args_of(e, "SHAPE_REPRESENTATION_RELATIONSHIP"));
            if let Some(a) = a {
                if let (Some(r1), Some(r2)) = (a.get(2).and_then(|t| ref_of(t)), a.get(3).and_then(|t| ref_of(t))) {
                    m.linked.entry(r1).or_default().push(r2);
                    m.linked.entry(r2).or_default().push(r1);
                }
            }
        }
    }
    for (_, e) in &m.ents {
        if e.has("SHAPE_DEFINITION_REPRESENTATION") {
            if let Some(a) = args_of(e, "SHAPE_DEFINITION_REPRESENTATION") {
                if let (Some(pds), Some(sr)) = (a.get(0).and_then(|t| ref_of(t)), a.get(1).and_then(|t| ref_of(t))) {
                    if let Some(&pd) = pds_def.get(&pds) {
                        shapes_of.entry(pd).or_default().push(sr);
                    }
                }
            }
        }
    }

    // Assembly edges: parent PD -> (child PD, transform child->parent).
    let mut children: HashMap<u32, Vec<(u32, Mat)>> = HashMap::new();
    let mut placed: HashSet<u32> = HashSet::new();
    for (rr_id, pds) in cdsr {
        let Some(&n) = pds_def.get(&pds) else { continue };
        let Some(&(parent, child)) = nauo.get(&n) else { continue };
        let mut t = Mat::IDENTITY;
        if let Some(rr) = m.ent(rr_id) {
            if let (Some(ra), Some(ta)) = (
                args_of(rr, "REPRESENTATION_RELATIONSHIP"),
                args_of(rr, "REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION"),
            ) {
                let rep1 = ra.get(2).and_then(|s| ref_of(s));
                let idt = ta.get(0).and_then(|s| ref_of(s)).and_then(|i| m.ent(i));
                if let Some(idt) = idt {
                    if let Some(ia) = args_of(idt, "ITEM_DEFINED_TRANSFORMATION") {
                        let p1 = ia.get(2).and_then(|s| ref_of(s)).and_then(|r| m.placement(r));
                        let p2 = ia.get(3).and_then(|s| ref_of(s)).and_then(|r| m.placement(r));
                        if let (Some(p1), Some(p2)) = (p1, p2) {
                            // Which side is the child? Match rep_1 against the
                            // child's representations; exporters disagree on
                            // the order, and getting it wrong mirrors the part.
                            let child_reps = m.reps_of(shapes_of.get(&child).map(|v| v.as_slice()).unwrap_or(&[]));
                            let child_first = rep1.map(|r| child_reps.contains(&r)).unwrap_or(true);
                            let (child_side, parent_side) = if child_first { (p1, p2) } else { (p2, p1) };
                            t = parent_side.mul(&child_side.inverse());
                        }
                    }
                }
            }
        }
        children.entry(parent).or_default().push((child, t));
        placed.insert(n);
    }
    // Occurrences with no placement record sit at the parent's origin.
    for (&n, &(parent, child)) in &nauo {
        if !placed.contains(&n) {
            children.entry(parent).or_default().push((child, Mat::IDENTITY));
        }
    }

    let is_child: HashSet<u32> = nauo.values().map(|&(_, c)| c).collect();
    let mut roots: Vec<u32> = shapes_of.keys().copied().filter(|pd| !is_child.contains(pd)).collect();
    if roots.is_empty() {
        roots = shapes_of.keys().copied().collect();
    }
    roots.sort_unstable();

    let mut out = Vec::new();
    let mut instances = 0usize;
    for root in roots {
        walk(&mut m, root, &Mat::IDENTITY, &shapes_of, &children, &mut out, &mut instances, 0);
    }

    // A file with geometry but no product structure at all (rare, hand-made):
    // draw every representation once.
    if out.is_empty() {
        let srs: Vec<u32> = m
            .ents
            .iter()
            .filter(|(_, e)| {
                let k = e.kind();
                k.contains("SHAPE_REPRESENTATION") && !k.contains("RELATIONSHIP")
            })
            .map(|(&id, _)| id)
            .collect();
        for sr in srs {
            let segs = m.rep_segments(sr, 0);
            out.extend(segs);
            if out.len() > MAX_SEGMENTS {
                break;
            }
        }
    }
    out.truncate(MAX_SEGMENTS);
    out.retain(|s| s.a.iter().chain(s.b.iter()).all(|v| v.is_finite()));
    m.total = out.len();
    out
}

#[allow(clippy::too_many_arguments)]
fn walk(
    m: &mut Model<'_>,
    pd: u32,
    world: &Mat,
    shapes_of: &HashMap<u32, Vec<u32>>,
    children: &HashMap<u32, Vec<(u32, Mat)>>,
    out: &mut Vec<Segment>,
    instances: &mut usize,
    depth: usize,
) {
    if depth > MAX_DEPTH || *instances > MAX_INSTANCES || out.len() > MAX_SEGMENTS {
        return;
    }
    *instances += 1;
    let direct = shapes_of.get(&pd).cloned().unwrap_or_default();
    for sr in m.reps_of(&direct) {
        let segs = m.rep_segments(sr, 0);
        out.extend(segs.iter().map(|s| Segment { a: world.apply(s.a), b: world.apply(s.b) }));
    }
    if let Some(kids) = children.get(&pd) {
        for (child, t) in kids.clone() {
            if child == pd {
                continue;
            }
            let w = world.mul(&t);
            walk(m, child, &w, shapes_of, children, out, instances, depth + 1);
        }
    }
}

/* ----------------------------- projection ----------------------------- */

/// Projects segments to 2D with the same isometric view Sketchor's in-app
/// previews use: Z up, seen from the (+X, −Y, +Z) octant. Returns unscaled
/// coordinates with Y up; the caller fits them to its box.
pub fn project_iso(segments: &[Segment]) -> Vec<Line2> {
    let z = norm([1.0, -1.0, 1.0]).unwrap();
    let x = norm(cross([0.0, 0.0, 1.0], z)).unwrap();
    let y = cross(z, x);
    segments
        .iter()
        .map(|s| Line2 { x1: dot(s.a, x), y1: dot(s.a, y), x2: dot(s.b, x), y2: dot(s.b, y) })
        .collect()
}

/// Thins a wireframe to at most `max` segments, keeping a uniform spread, so
/// a million-edge assembly still draws in the time Explorer allows.
pub fn thin(segments: &[Segment], max: usize) -> Vec<Segment> {
    if segments.len() <= max || max == 0 {
        return segments.to_vec();
    }
    let stride = (segments.len() + max - 1) / max;
    segments.iter().step_by(stride).copied().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A unit cube as B-rep topology: 8 vertices, 12 LINE edges. Only the
    /// parts of a STEP file this crate reads are present.
    fn cube(base: u32, shift: P3) -> (String, u32) {
        let mut s = String::new();
        let mut id = base;
        let mut next = || {
            id += 1;
            id
        };
        let corners = [
            [0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [1.0, 1.0, 0.0], [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0], [1.0, 0.0, 1.0], [1.0, 1.0, 1.0], [0.0, 1.0, 1.0],
        ];
        let mut vids = Vec::new();
        for c in corners {
            let p = next();
            let v = next();
            s += &format!("#{p}=CARTESIAN_POINT('',({},{},{}));\n", c[0] + shift[0], c[1] + shift[1], c[2] + shift[2]);
            s += &format!("#{v}=VERTEX_POINT('',#{p});\n");
            vids.push(v);
        }
        let line = next();
        s += &format!("#{line}=LINE('',#{},#{});\n", vids[0], vids[1]);
        let edges = [(0, 1), (1, 2), (2, 3), (3, 0), (4, 5), (5, 6), (6, 7), (7, 4), (0, 4), (1, 5), (2, 6), (3, 7)];
        let mut eids = Vec::new();
        for (a, b) in edges {
            let e = next();
            s += &format!("#{e}=EDGE_CURVE('',#{},#{},#{line},.T.);\n", vids[a], vids[b]);
            eids.push(format!("#{e}"));
        }
        let shell = next();
        s += &format!("#{shell}=CLOSED_SHELL('',({}));\n", eids.join(","));
        let brep = next();
        s += &format!("#{brep}=MANIFOLD_SOLID_BREP('',#{shell});\n");
        let sr = next();
        s += &format!("#{sr}=ADVANCED_BREP_SHAPE_REPRESENTATION('',(#{brep}),#9999);\n");
        (s, sr)
    }

    fn wrap(data: &str) -> String {
        format!("ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\n{data}ENDSEC;\nEND-ISO-10303-21;\n")
    }

    fn bbox(segs: &[Segment]) -> (P3, P3) {
        let mut lo = [f64::INFINITY; 3];
        let mut hi = [f64::NEG_INFINITY; 3];
        for s in segs {
            for p in [s.a, s.b] {
                for k in 0..3 {
                    lo[k] = lo[k].min(p[k]);
                    hi[k] = hi[k].max(p[k]);
                }
            }
        }
        (lo, hi)
    }

    #[test]
    fn single_part_draws_its_twelve_edges() {
        let (cube, sr) = cube(100, [0.0; 3]);
        let data = format!("{cube}#1=PRODUCT_DEFINITION('','',#2,#3);\n#4=PRODUCT_DEFINITION_SHAPE('','',#1);\n#5=SHAPE_DEFINITION_REPRESENTATION(#4,#{sr});\n");
        let segs = parse(&wrap(&data));
        assert_eq!(segs.len(), 12);
        assert_eq!(bbox(&segs), ([0.0; 3], [1.0; 3]));
    }

    #[test]
    fn assembly_places_each_occurrence_by_its_transform() {
        // One cube product, used twice in an assembly: once at the origin,
        // once translated by (10, 0, 0) and rotated 90° about Z.
        let (cube, cube_sr) = cube(100, [0.0; 3]);
        let mut d = cube;
        d += &format!(
            "#1=PRODUCT_DEFINITION('asm','',#2,#3);\n#4=PRODUCT_DEFINITION_SHAPE('','',#1);\n\
             #6=PRODUCT_DEFINITION('cube','',#2,#3);\n#7=PRODUCT_DEFINITION_SHAPE('','',#6);\n\
             #8=SHAPE_REPRESENTATION('cube',(#20),#9999);\n#9=SHAPE_DEFINITION_REPRESENTATION(#7,#8);\n\
             #10=SHAPE_REPRESENTATION_RELATIONSHIP('','',#8,#{cube_sr});\n\
             #11=SHAPE_REPRESENTATION('asm',(#20,#21),#9999);\n#12=SHAPE_DEFINITION_REPRESENTATION(#4,#11);\n\
             #20=AXIS2_PLACEMENT_3D('',#22,#23,#24);\n#22=CARTESIAN_POINT('',(0.,0.,0.));\n#23=DIRECTION('',(0.,0.,1.));\n#24=DIRECTION('',(1.,0.,0.));\n\
             #21=AXIS2_PLACEMENT_3D('',#25,#23,#26);\n#25=CARTESIAN_POINT('',(10.,0.,0.));\n#26=DIRECTION('',(0.,1.,0.));\n\
             #30=NEXT_ASSEMBLY_USAGE_OCCURRENCE('a','','',#1,#6,$);\n#31=PRODUCT_DEFINITION_SHAPE('','',#30);\n\
             #32=ITEM_DEFINED_TRANSFORMATION('','',#20,#20);\n\
             #33=(REPRESENTATION_RELATIONSHIP('','',#8,#11) REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION(#32) SHAPE_REPRESENTATION_RELATIONSHIP());\n\
             #34=CONTEXT_DEPENDENT_SHAPE_REPRESENTATION(#33,#31);\n\
             #40=NEXT_ASSEMBLY_USAGE_OCCURRENCE('b','','',#1,#6,$);\n#41=PRODUCT_DEFINITION_SHAPE('','',#40);\n\
             #42=ITEM_DEFINED_TRANSFORMATION('','',#20,#21);\n\
             #43=(REPRESENTATION_RELATIONSHIP('','',#8,#11) REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION(#42) SHAPE_REPRESENTATION_RELATIONSHIP());\n\
             #44=CONTEXT_DEPENDENT_SHAPE_REPRESENTATION(#43,#41);\n"
        );
        let segs = parse(&wrap(&d));
        assert_eq!(segs.len(), 24, "two occurrences of twelve edges");
        let (lo, hi) = bbox(&segs);
        // Rotating the unit cube 90° about Z maps x∈[0,1] to y∈[0,1] and
        // y∈[0,1] to x∈[-1,0]; translated by 10 that is x∈[9,10].
        assert!((lo[0] - 0.0).abs() < 1e-9 && (hi[0] - 10.0).abs() < 1e-9, "{lo:?} {hi:?}");
        assert!((hi[1] - 1.0).abs() < 1e-9);
        assert_eq!(hi[2], 1.0);
    }

    #[test]
    fn reversed_relationship_order_still_places_the_child_correctly() {
        // Same as above, but rep_1 is the parent and the transformation's
        // items are listed parent-first — the other convention in the wild.
        let (cube, cube_sr) = cube(100, [0.0; 3]);
        let mut d = cube;
        d += &format!(
            "#1=PRODUCT_DEFINITION('asm','',#2,#3);\n#4=PRODUCT_DEFINITION_SHAPE('','',#1);\n\
             #6=PRODUCT_DEFINITION('cube','',#2,#3);\n#7=PRODUCT_DEFINITION_SHAPE('','',#6);\n\
             #9=SHAPE_DEFINITION_REPRESENTATION(#7,#{cube_sr});\n\
             #11=SHAPE_REPRESENTATION('asm',(#20,#21),#9999);\n#12=SHAPE_DEFINITION_REPRESENTATION(#4,#11);\n\
             #20=AXIS2_PLACEMENT_3D('',#22,#23,#24);\n#22=CARTESIAN_POINT('',(0.,0.,0.));\n#23=DIRECTION('',(0.,0.,1.));\n#24=DIRECTION('',(1.,0.,0.));\n\
             #21=AXIS2_PLACEMENT_3D('',#25,#23,#24);\n#25=CARTESIAN_POINT('',(0.,0.,5.));\n\
             #40=NEXT_ASSEMBLY_USAGE_OCCURRENCE('b','','',#1,#6,$);\n#41=PRODUCT_DEFINITION_SHAPE('','',#40);\n\
             #42=ITEM_DEFINED_TRANSFORMATION('','',#21,#20);\n\
             #43=(REPRESENTATION_RELATIONSHIP('','',#11,#{cube_sr}) REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION(#42) SHAPE_REPRESENTATION_RELATIONSHIP());\n\
             #44=CONTEXT_DEPENDENT_SHAPE_REPRESENTATION(#43,#41);\n"
        );
        let segs = parse(&wrap(&d));
        assert_eq!(segs.len(), 12);
        let (lo, hi) = bbox(&segs);
        assert!((lo[2] - 5.0).abs() < 1e-9 && (hi[2] - 6.0).abs() < 1e-9, "{lo:?} {hi:?}");
    }

    #[test]
    fn circle_edge_is_stepped_between_its_vertices() {
        // Quarter circle of radius 2 in the XY plane, from (2,0,0) to (0,2,0).
        let d = "#1=CARTESIAN_POINT('',(0.,0.,0.));\n#2=DIRECTION('',(0.,0.,1.));\n#3=DIRECTION('',(1.,0.,0.));\n\
                 #4=AXIS2_PLACEMENT_3D('',#1,#2,#3);\n#5=CIRCLE('',#4,2.);\n\
                 #6=CARTESIAN_POINT('',(2.,0.,0.));\n#7=VERTEX_POINT('',#6);\n#8=CARTESIAN_POINT('',(0.,2.,0.));\n#9=VERTEX_POINT('',#8);\n\
                 #10=EDGE_CURVE('',#7,#9,#5,.T.);\n#11=CLOSED_SHELL('',(#10));\n#12=ADVANCED_BREP_SHAPE_REPRESENTATION('',(#11),#99);\n\
                 #20=PRODUCT_DEFINITION('','',#2,#3);\n#21=PRODUCT_DEFINITION_SHAPE('','',#20);\n#22=SHAPE_DEFINITION_REPRESENTATION(#21,#12);\n";
        let segs = parse(&wrap(d));
        assert_eq!(segs.len(), ARC_STEPS / 4);
        for s in &segs {
            for p in [s.a, s.b] {
                assert!((dot(p, p).sqrt() - 2.0).abs() < 1e-9, "point off the circle: {p:?}");
                assert!(p[0] >= -1e-9 && p[1] >= -1e-9, "left the first quadrant: {p:?}");
            }
        }
        assert_eq!(segs.first().unwrap().a, [2.0, 0.0, 0.0]);
        assert!((segs.last().unwrap().b[1] - 2.0).abs() < 1e-9);
    }

    #[test]
    fn full_circle_when_both_vertices_coincide() {
        let d = "#1=CARTESIAN_POINT('',(0.,0.,0.));\n#2=DIRECTION('',(0.,0.,1.));\n#3=DIRECTION('',(1.,0.,0.));\n\
                 #4=AXIS2_PLACEMENT_3D('',#1,#2,#3);\n#5=CIRCLE('',#4,1.);\n\
                 #6=CARTESIAN_POINT('',(1.,0.,0.));\n#7=VERTEX_POINT('',#6);\n\
                 #10=EDGE_CURVE('',#7,#7,#5,.T.);\n#12=ADVANCED_BREP_SHAPE_REPRESENTATION('',(#10),#99);\n\
                 #20=PRODUCT_DEFINITION('','',#2,#3);\n#21=PRODUCT_DEFINITION_SHAPE('','',#20);\n#22=SHAPE_DEFINITION_REPRESENTATION(#21,#12);\n";
        let segs = parse(&wrap(d));
        assert_eq!(segs.len(), ARC_STEPS);
        let (lo, hi) = bbox(&segs);
        assert!((lo[0] + 1.0).abs() < 1e-9 && (lo[1] + 1.0).abs() < 1e-9 && (hi[0] - 1.0).abs() < 1e-9);
    }

    #[test]
    fn spline_edge_runs_through_its_control_points() {
        let d = "#1=CARTESIAN_POINT('',(0.,0.,0.));\n#2=CARTESIAN_POINT('',(1.,2.,0.));\n#3=CARTESIAN_POINT('',(2.,2.,0.));\n#4=CARTESIAN_POINT('',(3.,0.,0.));\n\
                 #5=B_SPLINE_CURVE_WITH_KNOTS('',3,(#1,#2,#3,#4),.UNSPECIFIED.,.F.,.F.,(4,4),(0.,1.),.UNSPECIFIED.);\n\
                 #6=VERTEX_POINT('',#1);\n#7=VERTEX_POINT('',#4);\n#8=EDGE_CURVE('',#6,#7,#5,.T.);\n\
                 #9=ADVANCED_BREP_SHAPE_REPRESENTATION('',(#8),#99);\n\
                 #20=PRODUCT_DEFINITION('','',#2,#3);\n#21=PRODUCT_DEFINITION_SHAPE('','',#20);\n#22=SHAPE_DEFINITION_REPRESENTATION(#21,#9);\n";
        let segs = parse(&wrap(d));
        assert_eq!(segs.len(), 3);
        assert_eq!(segs[0].a, [0.0, 0.0, 0.0]);
        assert_eq!(segs[1].a, [1.0, 2.0, 0.0]);
        assert_eq!(segs[2].b, [3.0, 0.0, 0.0]);
    }

    #[test]
    fn strings_with_semicolons_and_hashes_do_not_derail_parsing() {
        let (cube, sr) = cube(100, [0.0; 3]);
        let data = format!(
            "#1=PRODUCT_DEFINITION('part ; #7 ''quoted''','',#2,#3);\n#4=PRODUCT_DEFINITION_SHAPE('','',#1);\n#5=SHAPE_DEFINITION_REPRESENTATION(#4,#{sr});\n{cube}"
        );
        assert_eq!(parse(&wrap(&data)).len(), 12);
    }

    #[test]
    fn malformed_input_yields_nothing_and_never_panics() {
        for text in ["", "DATA;", "ISO-10303-21;\nDATA;\n#1=EDGE_CURVE('',#2,#3,#4,.T.);\n", "#=(((", "DATA;\n#1=CARTESIAN_POINT('',(nan,1,2));\n#2=VERTEX_POINT('',#1);#3=EDGE_CURVE('',#2,#2,#9,.T.);#4=SHAPE_REPRESENTATION('',(#3),#5);"] {
            let _ = parse(text);
        }
        // Truncated mid-entity.
        let (cube, sr) = cube(100, [0.0; 3]);
        let data = format!("{cube}#1=PRODUCT_DEFINITION('','',#2,#3);\n#4=PRODUCT_DEFINITION_SHAPE('','',#1);\n#5=SHAPE_DEFINITION_REPRESENTATION(#4,#{sr});\n");
        let full = wrap(&data);
        for cut in (0..full.len()).step_by(97) {
            let _ = parse(&full[..cut]);
        }
    }

    #[test]
    fn self_referencing_mapped_item_terminates() {
        let d = "#1=CARTESIAN_POINT('',(0.,0.,0.));\n#2=DIRECTION('',(0.,0.,1.));\n#3=DIRECTION('',(1.,0.,0.));\n#4=AXIS2_PLACEMENT_3D('',#1,#2,#3);\n\
                 #5=REPRESENTATION_MAP(#4,#7);\n#6=MAPPED_ITEM('',#5,#4);\n#7=SHAPE_REPRESENTATION('',(#6),#99);\n\
                 #20=PRODUCT_DEFINITION('','',#2,#3);\n#21=PRODUCT_DEFINITION_SHAPE('','',#20);\n#22=SHAPE_DEFINITION_REPRESENTATION(#21,#7);\n";
        assert!(parse(&wrap(d)).is_empty());
    }

    #[test]
    fn iso_projection_keeps_z_up_and_thin_keeps_a_spread() {
        let segs = vec![Segment { a: [0.0, 0.0, 0.0], b: [0.0, 0.0, 1.0] }, Segment { a: [0.0, 0.0, 0.0], b: [1.0, 0.0, 0.0] }];
        let p = project_iso(&segs);
        assert!(p[0].y2 > p[0].y1, "+Z goes up on screen");
        assert!((p[0].x2 - p[0].x1).abs() < 1e-12, "+Z has no horizontal component");
        assert!(p[1].x2 > p[1].x1, "+X goes right");
        let many: Vec<Segment> = (0..100).map(|i| Segment { a: [i as f64, 0.0, 0.0], b: [i as f64, 1.0, 0.0] }).collect();
        let t = thin(&many, 10);
        assert!(t.len() <= 10 && t.len() >= 9);
        assert_eq!(t[0].a[0], 0.0);
        assert!(t.last().unwrap().a[0] >= 90.0);
    }
}
