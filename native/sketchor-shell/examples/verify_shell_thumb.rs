//! End-to-end verification that the *registered* shell thumbnail handler
//! produces a geometry thumbnail for a real `.sketchor` file — driving the
//! exact API Explorer uses (`IShellItemImageFactory::GetImage`).
//!
//! `SIIGBF_THUMBNAILONLY` forces the shell to use a thumbnail *handler* and
//! fail rather than fall back to the file's icon, so a success here proves the
//! whole pipeline (COM registration + our `IThumbnailProvider`) is live.
//! Optionally writes the shell's own bitmap to PNG for visual inspection.
//!
//!   cargo run --release --example verify_shell_thumb -- file.sketchor [out.png] [size]

use windows::core::HSTRING;
use windows::Win32::Foundation::SIZE;
use windows::Win32::Graphics::Gdi::{
    DeleteDC, DeleteObject, GetDC, GetDIBits, GetObjectW, ReleaseDC, BITMAP, BITMAPINFO,
    BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HDC, HGDIOBJ,
};
use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED};
use windows::Win32::UI::Shell::{
    IShellItemImageFactory, SHCreateItemFromParsingName, SIIGBF_THUMBNAILONLY,
};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let path = args
        .get(1)
        .cloned()
        .expect("usage: verify_shell_thumb <file.sketchor> [out.png] [size]");
    let out = args.get(2).cloned();
    let size: i32 = args.get(3).and_then(|s| s.parse().ok()).unwrap_or(256);

    // The shell needs an absolute path; strip the \\?\ verbatim prefix that
    // canonicalize adds on Windows.
    let abs = std::fs::canonicalize(&path).expect("file must exist");
    let abs = abs
        .to_string_lossy()
        .trim_start_matches(r"\\?\")
        .to_string();

    unsafe {
        CoInitializeEx(None, COINIT_APARTMENTTHREADED)
            .ok()
            .expect("CoInitializeEx");

        let factory: IShellItemImageFactory =
            SHCreateItemFromParsingName(&HSTRING::from(&abs), None)
                .expect("SHCreateItemFromParsingName");

        let hbmp = factory
            .GetImage(SIZE { cx: size, cy: size }, SIIGBF_THUMBNAILONLY)
            .expect("shell returned no thumbnail-handler bitmap (handler not live?)");

        // Read back dimensions to confirm a real bitmap came out.
        let mut bm = BITMAP::default();
        GetObjectW(
            HGDIOBJ(hbmp.0),
            std::mem::size_of::<BITMAP>() as i32,
            Some(&mut bm as *mut _ as *mut _),
        );
        println!(
            "OK: shell produced a {}x{} thumbnail for {}",
            bm.bmWidth, bm.bmHeight, abs
        );

        if let Some(out) = out {
            save_png(hbmp, bm.bmWidth, bm.bmHeight, &out);
            println!("wrote {out}");
        }

        let _ = DeleteObject(HGDIOBJ(hbmp.0));
        CoUninitialize();
    }
}

/// Copies an HBITMAP's pixels via GetDIBits and writes an opaque RGBA PNG.
unsafe fn save_png(hbmp: windows::Win32::Graphics::Gdi::HBITMAP, w: i32, h: i32, out: &str) {
    let screen = GetDC(None);
    let dc = HDC(screen.0);
    let mut bmi = BITMAPINFO::default();
    bmi.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
    bmi.bmiHeader.biWidth = w;
    bmi.bmiHeader.biHeight = -h; // top-down
    bmi.bmiHeader.biPlanes = 1;
    bmi.bmiHeader.biBitCount = 32;
    bmi.bmiHeader.biCompression = BI_RGB.0;

    let count = (w * h) as usize;
    let mut buf = vec![0u8; count * 4];
    GetDIBits(
        dc,
        hbmp,
        0,
        h as u32,
        Some(buf.as_mut_ptr() as *mut _),
        &mut bmi,
        DIB_RGB_COLORS,
    );
    ReleaseDC(None, screen);
    let _ = DeleteDC(dc);

    // GetDIBits gives BGRA; convert to opaque RGBA.
    let mut rgba = vec![0u8; count * 4];
    for i in 0..count {
        rgba[i * 4] = buf[i * 4 + 2];
        rgba[i * 4 + 1] = buf[i * 4 + 1];
        rgba[i * 4 + 2] = buf[i * 4];
        rgba[i * 4 + 3] = 255;
    }
    image::save_buffer(out, &rgba, w as u32, h as u32, image::ColorType::Rgba8)
        .expect("save png");
}
