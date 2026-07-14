//! Renders a sample `.sketchor` document through the real GDI rasteriser
//! and writes a PNG, so the thumbnail/preview output can be inspected
//! without registering the shell extension. Usage:
//!
//!   cargo run --example render_sample -- [input.sketchor] [out.png] [size]

use sketchor_shell::{model, render};

const SAMPLE: &str = r#"{
  "version": 1,
  "entities": [
    { "id": "e1", "type": "line",   "a": {"x": 0,   "y": 0},  "b": {"x": 120, "y": 0} },
    { "id": "e2", "type": "line",   "a": {"x": 120, "y": 0},  "b": {"x": 120, "y": 80} },
    { "id": "e3", "type": "line",   "a": {"x": 120, "y": 80}, "b": {"x": 0,   "y": 80} },
    { "id": "e4", "type": "line",   "a": {"x": 0,   "y": 80}, "b": {"x": 0,   "y": 0} },
    { "id": "e5", "type": "circle", "center": {"x": 60, "y": 40}, "radius": 28 },
    { "id": "e6", "type": "circle", "center": {"x": 24, "y": 56}, "radius": 8 },
    { "id": "e7", "type": "circle", "center": {"x": 96, "y": 56}, "radius": 8 }
  ]
}"#;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let out = args.get(2).cloned().unwrap_or_else(|| "sample.png".into());
    let size: u32 = args.get(3).and_then(|s| s.parse().ok()).unwrap_or(256);

    let text = match args.get(1).filter(|s| !s.is_empty()) {
        Some(path) => std::fs::read_to_string(path).expect("read input .sketchor"),
        None => SAMPLE.to_string(),
    };

    let shapes = model::parse(&text);
    println!("parsed {} shapes", shapes.len());

    let rgba = render::render_rgba(&shapes, size).expect("render");
    image::save_buffer(&out, &rgba, size, size, image::ColorType::Rgba8).expect("save png");
    println!("wrote {out} ({size}x{size})");
}
