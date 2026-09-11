//! Asks the shell's *thumbnail cache service* — the exact object Explorer's
//! views go through (CLSID_LocalThumbnailCache / IThumbnailCache) — for a
//! file's thumbnail, forcing extraction. Closer to what Explorer does than
//! IShellItemImageFactory, and it reports the cache flags it decided on.
//!
//!   cargo run --release --example verify_thumbcache -- file [size]

use windows::core::HSTRING;
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_APARTMENTTHREADED};
use windows::Win32::UI::Shell::{
    IShellItem, ISharedBitmap, IThumbnailCache, LocalThumbnailCache, SHCreateItemFromParsingName, WTS_CACHEFLAGS, WTS_FLAGS,
};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let path = args.get(1).expect("usage: verify_thumbcache <file> [size]");
    let size: u32 = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(256);
    // Third arg: raw WTS_FLAGS value (0 = WTS_EXTRACT like Explorer, 4 = WTS_FORCEEXTRACTION).
    let wts = WTS_FLAGS(args.get(3).and_then(|s| s.parse().ok()).unwrap_or(0));
    let abs = std::fs::canonicalize(path).expect("exists");
    let abs = abs.to_string_lossy().trim_start_matches(r"\\?\").to_string();
    unsafe {
        CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok().expect("CoInitializeEx");
        let item: IShellItem = SHCreateItemFromParsingName(&HSTRING::from(&abs), None).expect("item");
        let cache: IThumbnailCache = CoCreateInstance(&LocalThumbnailCache, None, CLSCTX_ALL).expect("cache");
        let mut bmp: Option<ISharedBitmap> = None;
        let mut flags = WTS_CACHEFLAGS(0);
        match cache.GetThumbnail(&item, size, wts, Some(&mut bmp), Some(&mut flags), None) {
            Ok(()) => {
                let sz = bmp.as_ref().and_then(|b| b.GetSize().ok()).unwrap_or_default();
                println!("OK: {}x{} cacheflags={:#x}", sz.cx, sz.cy, flags.0);
            }
            Err(e) => println!("FAILED: {e:?}"),
        }
    }
}
