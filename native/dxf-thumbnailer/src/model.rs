//! Thumbnails for 3D model files (`.step`/`.stp`, `.iges`/`.igs`).
//!
//! Two tiers, because drawing a STEP file *properly* needs a geometry
//! kernel and OpenCascade is not something to load into every Explorer
//! process:
//!
//! 1. **Sidecar PNG.** Every time Sketchor renders a model preview (opening a
//!    file, or just browsing past it), it also writes the isometric PNG to
//!    `%LOCALAPPDATA%\Sketchor\thumbs\<sha256-of-file>.png` (the
//!    `write_thumbnail_cache` Tauri command). Hashing the file here costs a
//!    few tens of milliseconds and gives Explorer the exact same picture as
//!    the app — for any model the user has looked at once.
//! 2. **Wireframe.** Otherwise, for STEP, the B-rep edges are read straight
//!    out of the text (native/step-wire: no kernel, assembly transforms
//!    resolved) and stroked like a DXF. A recognisable silhouette in
//!    milliseconds, which upgrades to tier 1 the moment the file is opened.
//!
//! IGES has no text-level fallback, so it gets tier 1 or nothing (Explorer
//! then shows the file's icon).

use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

use dxf_parse::{Pt, Shape};

/// Segments handed to GDI at most: plenty for a 256px thumbnail, and keeps a
/// million-edge assembly inside Explorer's patience.
const MAX_DRAWN_SEGMENTS: usize = 300_000;

pub fn is_model(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    ["step", "stp", "iges", "igs"].iter().any(|ext| lower.ends_with(&format!(".{ext}")))
}

fn is_step(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    lower.ends_with(".step") || lower.ends_with(".stp")
}

/// Where Sketchor drops sidecar previews. Must agree with
/// `thumbnail_cache_dir` in apps/web/src-tauri/src/main.rs.
pub fn cache_dir() -> Option<PathBuf> {
    let base = std::env::var_os("LOCALAPPDATA")?;
    Some(Path::new(&base).join("Sketchor").join("thumbs"))
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

/// A decoded sidecar preview: RGBA8, square.
pub struct Preview {
    pub rgba: Vec<u8>,
    pub size: u32,
}

/// Tier 1: the app-rendered preview for these exact bytes, if there is one.
pub fn sidecar(bytes: &[u8]) -> Option<Preview> {
    let path = cache_dir()?.join(format!("{}.png", sha256_hex(bytes)));
    let file = std::fs::File::open(path).ok()?;
    let decoder = png::Decoder::new(std::io::BufReader::new(file));
    let mut reader = decoder.read_info().ok()?;
    let mut buf = vec![0u8; reader.output_buffer_size()];
    let info = reader.next_frame(&mut buf).ok()?;
    if info.width != info.height || info.width == 0 || info.bit_depth != png::BitDepth::Eight {
        return None;
    }
    let n = (info.width * info.height) as usize;
    let rgba = match info.color_type {
        png::ColorType::Rgba => buf[..n * 4].to_vec(),
        png::ColorType::Rgb => {
            let mut out = Vec::with_capacity(n * 4);
            for px in buf[..n * 3].chunks(3) {
                out.extend_from_slice(px);
                out.push(255);
            }
            out
        }
        _ => return None,
    };
    Some(Preview { rgba, size: info.width })
}

/// Tier 2: the STEP wireframe, projected isometrically, as 2D shapes for
/// the shared DXF rasteriser. Empty for IGES or a file with no edges.
pub fn wireframe(path: &str, text: &str) -> Vec<Shape> {
    if !is_step(path) {
        return Vec::new();
    }
    let segments = step_wire::parse(text);
    let segments = step_wire::thin(&segments, MAX_DRAWN_SEGMENTS);
    step_wire::project_iso(&segments)
        .into_iter()
        .map(|l| Shape::Line(Pt { x: l.x1, y: l.y1 }, Pt { x: l.x2, y: l.y2 }))
        .collect()
}
