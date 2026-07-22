//! GDI rasteriser shared by the thumbnail provider and the preview handler.
//!
//! Fits the drawing into a `width` x `height` region with a dark background
//! and light strokes (the same visual intent as Sketchor's in-app canvas),
//! painting either into an off-screen 32-bpp DIB (thumbnail -> `HBITMAP`)
//! or straight onto a window DC (preview pane).

use crate::model::{arc_point_at, arc_sweep, bounds, Shape};
use windows::Win32::Foundation::{COLORREF, HANDLE, HWND, RECT};
use windows::Win32::Graphics::Gdi::*;

/// Canvas background (matches the web app's `#1e1f22`).
const BG: (u8, u8, u8) = (30, 31, 34);
/// Stroke colour (matches the web app's light entity strokes).
const STROKE: (u8, u8, u8) = (199, 208, 220);

fn rgb(r: u8, g: u8, b: u8) -> u32 {
    (r as u32) | ((g as u32) << 8) | ((b as u32) << 16)
}

/// Paints background + shapes onto a device context, fitting the drawing to
/// a `width` x `height` box. `stroke_px` scales the pen with the target
/// size so large preview panes don't render hairline-thin.
pub unsafe fn paint(dc: HDC, shapes: &[Shape], width: i32, height: i32, stroke_px: i32) {
    let bg = CreateSolidBrush(COLORREF(rgb(BG.0, BG.1, BG.2)));
    let rect = RECT { left: 0, top: 0, right: width, bottom: height };
    FillRect(dc, &rect, bg);
    let _ = DeleteObject(bg);

    let Some(b) = bounds(shapes) else { return };
    let pad = (width.min(height) as f64 * 0.1).round();
    let w = (b.max_x - b.min_x).max(1e-6);
    let h = (b.max_y - b.min_y).max(1e-6);
    let avail_w = (width as f64 - pad * 2.0).max(1.0);
    let avail_h = (height as f64 - pad * 2.0).max(1.0);
    let scale = (avail_w / w).min(avail_h / h);
    let off_x = (width as f64 - w * scale) / 2.0;
    let off_y = (height as f64 - h * scale) / 2.0;
    let sx = |x: f64| (off_x + (x - b.min_x) * scale).round() as i32;
    let sy = |y: f64| (off_y + (b.max_y - y) * scale).round() as i32; // Y down

    let pen = CreatePen(PS_SOLID, stroke_px.max(1), COLORREF(rgb(STROKE.0, STROKE.1, STROKE.2)));
    let old_pen = SelectObject(dc, pen);
    let old_brush = SelectObject(dc, GetStockObject(HOLLOW_BRUSH));

    for s in shapes {
        match s {
            Shape::Line(a, c) => {
                let _ = MoveToEx(dc, sx(a.x), sy(a.y), None);
                let _ = LineTo(dc, sx(c.x), sy(c.y));
            }
            Shape::Circle(c, r) => {
                let rr = (r * scale).round() as i32;
                let (cx, cy) = (sx(c.x), sy(c.y));
                let _ = Ellipse(dc, cx - rr, cy - rr, cx + rr, cy + rr);
            }
            Shape::Arc(c, r, start, end, ccw) => {
                // Tessellated in world space, then mapped through sx()/sy() like every
                // other shape — sidesteps GDI's own (Y-flip-sensitive) arc angle rules.
                let sweep = arc_sweep(*start, *end, *ccw);
                let steps = ((sweep / (2.0 * std::f64::consts::PI)) * 64.0).ceil().clamp(2.0, 64.0) as i32;
                let mut prev = arc_point_at(*c, *r, *start);
                for i in 1..=steps {
                    let t = if *ccw {
                        start + sweep * (i as f64 / steps as f64)
                    } else {
                        start - sweep * (i as f64 / steps as f64)
                    };
                    let p = arc_point_at(*c, *r, t);
                    let _ = MoveToEx(dc, sx(prev.x), sy(prev.y), None);
                    let _ = LineTo(dc, sx(p.x), sy(p.y));
                    prev = p;
                }
            }
        }
    }

    SelectObject(dc, old_pen);
    SelectObject(dc, old_brush);
    let _ = DeleteObject(pen);
}

fn dib_header(width: i32, height: i32) -> BITMAPINFO {
    let mut bmi = BITMAPINFO::default();
    bmi.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
    bmi.bmiHeader.biWidth = width;
    bmi.bmiHeader.biHeight = -height; // negative => top-down
    bmi.bmiHeader.biPlanes = 1;
    bmi.bmiHeader.biBitCount = 32;
    bmi.bmiHeader.biCompression = BI_RGB.0;
    bmi
}

/// Rasterises the shapes into a square `size` x `size` top-down DIB and
/// returns the `HBITMAP`. Explorer takes ownership of the bitmap.
pub fn render_thumbnail(shapes: &[Shape], size: u32) -> Result<HBITMAP, ()> {
    let size = size as i32;
    // Scale the stroke gently with thumbnail size (1px @ 32, ~3px @ 256).
    let stroke = (size / 96).max(1);
    let bmi = dib_header(size, size);
    unsafe {
        let screen_dc = GetDC(HWND::default());
        let dc = CreateCompatibleDC(screen_dc);
        ReleaseDC(HWND::default(), screen_dc);
        if dc.is_invalid() {
            return Err(());
        }
        let mut bits: *mut core::ffi::c_void = std::ptr::null_mut();
        let hbmp = CreateDIBSection(dc, &bmi, DIB_RGB_COLORS, &mut bits, HANDLE::default(), 0)
            .map_err(|_| ())?;
        let old = SelectObject(dc, hbmp);
        paint(dc, shapes, size, size, stroke);
        SelectObject(dc, old);
        let _ = DeleteDC(dc);
        Ok(hbmp)
    }
}

/// Renders to an RGBA pixel buffer (row-major, top-down). Used by the
/// `render_sample` example to verify the rasteriser without a shell.
pub fn render_rgba(shapes: &[Shape], size: u32) -> Result<Vec<u8>, ()> {
    let s = size as i32;
    let stroke = (s / 96).max(1);
    let bmi = dib_header(s, s);
    unsafe {
        let screen_dc = GetDC(HWND::default());
        let dc = CreateCompatibleDC(screen_dc);
        ReleaseDC(HWND::default(), screen_dc);
        if dc.is_invalid() {
            return Err(());
        }
        let mut bits: *mut core::ffi::c_void = std::ptr::null_mut();
        let hbmp = CreateDIBSection(dc, &bmi, DIB_RGB_COLORS, &mut bits, HANDLE::default(), 0)
            .map_err(|_| ())?;
        let old = SelectObject(dc, hbmp);
        paint(dc, shapes, s, s, stroke);
        let _ = GdiFlush();

        let count = (size * size) as usize;
        let src = std::slice::from_raw_parts(bits as *const u8, count * 4);
        let mut out = vec![0u8; count * 4];
        for i in 0..count {
            // DIB is BGRA (A unused) -> RGBA opaque.
            out[i * 4] = src[i * 4 + 2];
            out[i * 4 + 1] = src[i * 4 + 1];
            out[i * 4 + 2] = src[i * 4];
            out[i * 4 + 3] = 255;
        }

        SelectObject(dc, old);
        let _ = DeleteObject(hbmp);
        let _ = DeleteDC(dc);
        Ok(out)
    }
}
