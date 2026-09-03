//! C ABI over `dxf-parse`, linked into the Swift Quick Look thumbnail
//! extension. The Swift side owns the drawing (Core Graphics); this side owns
//! parsing DXF text and projecting it into the raster box, so the geometry and
//! fit-to-box math stay identical to the Windows thumbnailer.
//!
//! Ownership: `dxf_project` returns a heap `DxfProjection` whose two arrays are
//! separately heap-allocated. The caller must hand the exact pointer back to
//! `dxf_projection_free` once; passing null is a no-op.

use std::ptr::slice_from_raw_parts_mut;
use std::slice;

/// A line in raster space (origin top-left, Y down), already fitted to the box.
#[repr(C)]
pub struct DxfLine {
    pub x1: f64,
    pub y1: f64,
    pub x2: f64,
    pub y2: f64,
}

/// A circle in raster space, radius already scaled.
#[repr(C)]
pub struct DxfCircle {
    pub cx: f64,
    pub cy: f64,
    pub r: f64,
}

/// Flat view of a projected drawing. `lines`/`circles` are null only when the
/// corresponding count is zero.
#[repr(C)]
pub struct DxfProjection {
    pub lines: *mut DxfLine,
    pub n_lines: usize,
    pub circles: *mut DxfCircle,
    pub n_circles: usize,
}

/// Parse UTF-8 DXF text and project it into a `size`x`size` box with `pad` px
/// of margin. Returns null on a null pointer or non-UTF-8 input; otherwise an
/// owned `DxfProjection` (possibly with zero shapes) to be freed with
/// `dxf_projection_free`.
///
/// # Safety
/// `text` must point to `len` readable bytes (or be null).
#[no_mangle]
pub unsafe extern "C" fn dxf_project(
    text: *const u8,
    len: usize,
    size: f64,
    pad: f64,
) -> *mut DxfProjection {
    if text.is_null() {
        return std::ptr::null_mut();
    }
    let bytes = slice::from_raw_parts(text, len);
    let Ok(s) = std::str::from_utf8(bytes) else {
        return std::ptr::null_mut();
    };

    let shapes = dxf_parse::parse(s);
    let proj = dxf_parse::project(&shapes, size, pad);

    let lines: Box<[DxfLine]> = proj
        .lines
        .iter()
        .map(|l| DxfLine {
            x1: l.x1,
            y1: l.y1,
            x2: l.x2,
            y2: l.y2,
        })
        .collect();
    let circles: Box<[DxfCircle]> = proj
        .circles
        .iter()
        .map(|c| DxfCircle {
            cx: c.cx,
            cy: c.cy,
            r: c.r,
        })
        .collect();

    let n_lines = lines.len();
    let n_circles = circles.len();
    // `Box<[T]>::into_raw` yields a fat pointer; casting to the element pointer
    // keeps the data address, and we track the lengths ourselves to rebuild it.
    let lines_ptr = Box::into_raw(lines) as *mut DxfLine;
    let circles_ptr = Box::into_raw(circles) as *mut DxfCircle;

    Box::into_raw(Box::new(DxfProjection {
        lines: lines_ptr,
        n_lines,
        circles: circles_ptr,
        n_circles,
    }))
}

/// Free a projection returned by `dxf_project`. Null is a no-op; never call
/// twice on the same pointer.
///
/// # Safety
/// `p` must be null or a pointer previously returned by `dxf_project` and not
/// yet freed.
#[no_mangle]
pub unsafe extern "C" fn dxf_projection_free(p: *mut DxfProjection) {
    if p.is_null() {
        return;
    }
    let header = Box::from_raw(p);
    if !header.lines.is_null() {
        drop(Box::from_raw(slice_from_raw_parts_mut(
            header.lines,
            header.n_lines,
        )));
    }
    if !header.circles.is_null() {
        drop(Box::from_raw(slice_from_raw_parts_mut(
            header.circles,
            header.n_circles,
        )));
    }
}
