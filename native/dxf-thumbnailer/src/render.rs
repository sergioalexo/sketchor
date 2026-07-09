//! GDI rasteriser: fits the DXF shapes into a `size`x`size` 32-bpp bitmap
//! with a dark background and light strokes, returning an HBITMAP that
//! Explorer takes ownership of.

use crate::dxf::{bounds, Shape};
use windows::Win32::Foundation::{COLORREF, HANDLE, HWND, RECT};
use windows::Win32::Graphics::Gdi::*;

fn rgb(r: u8, g: u8, b: u8) -> u32 {
    (r as u32) | ((g as u32) << 8) | ((b as u32) << 16)
}

/// Paints background + shapes onto a device context, fitting to `size`.
unsafe fn paint(dc: HDC, shapes: &[Shape], size: i32) {
    let bg = CreateSolidBrush(COLORREF(rgb(30, 31, 34)));
    let rect = RECT {
        left: 0,
        top: 0,
        right: size,
        bottom: size,
    };
    FillRect(dc, &rect, bg);
    let _ = DeleteObject(bg);

    let Some(b) = bounds(shapes) else { return };
    let pad = (size as f64 * 0.1).round();
    let w = (b.max_x - b.min_x).max(1e-6);
    let h = (b.max_y - b.min_y).max(1e-6);
    let scale = ((size as f64 - pad * 2.0) / w).min((size as f64 - pad * 2.0) / h);
    let off_x = (size as f64 - w * scale) / 2.0;
    let off_y = (size as f64 - h * scale) / 2.0;
    let sx = |x: f64| (off_x + (x - b.min_x) * scale).round() as i32;
    let sy = |y: f64| (off_y + (b.max_y - y) * scale).round() as i32; // Y down

    let pen = CreatePen(PS_SOLID, 1, COLORREF(rgb(199, 208, 220)));
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
        }
    }

    SelectObject(dc, old_pen);
    SelectObject(dc, old_brush);
    let _ = DeleteObject(pen);
}

fn dib_header(size: i32) -> BITMAPINFO {
    let mut bmi = BITMAPINFO::default();
    bmi.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
    bmi.bmiHeader.biWidth = size;
    bmi.bmiHeader.biHeight = -size; // negative => top-down
    bmi.bmiHeader.biPlanes = 1;
    bmi.bmiHeader.biBitCount = 32;
    bmi.bmiHeader.biCompression = BI_RGB.0;
    bmi
}

pub fn render_thumbnail(shapes: &[Shape], size: u32) -> Result<HBITMAP, ()> {
    let size = size as i32;
    let bmi = dib_header(size);
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
        paint(dc, shapes, size);
        SelectObject(dc, old);
        let _ = DeleteDC(dc);
        Ok(hbmp)
    }
}

/// Renders to an RGBA pixel buffer (row-major, top-down). Used by the
/// `render_sample` example to verify the rasteriser produces a correct
/// image without going through Explorer.
pub fn render_rgba(shapes: &[Shape], size: u32) -> Result<Vec<u8>, ()> {
    let s = size as i32;
    let bmi = dib_header(s);
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
        paint(dc, shapes, s);
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
