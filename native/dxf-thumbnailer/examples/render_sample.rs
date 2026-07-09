//! Renders a sample DXF through the real GDI rasteriser and writes a PNG,
//! so the thumbnail output can be inspected without registering the shell
//! extension. Usage:
//!
//!   cargo run --example render_sample -- [input.dxf] [out.png] [size]

use dxf_thumbnailer::{dxf, render};

const SAMPLE: &str = "0\nSECTION\n2\nENTITIES\n\
0\nLWPOLYLINE\n90\n4\n70\n1\n10\n0\n20\n0\n10\n120\n20\n0\n10\n120\n20\n80\n10\n0\n20\n80\n\
0\nCIRCLE\n10\n60\n20\n40\n40\n28\n\
0\nCIRCLE\n10\n24\n20\n56\n40\n8\n\
0\nCIRCLE\n10\n96\n20\n56\n40\n8\n\
0\nARC\n10\n60\n20\n40\n40\n30\n50\n200\n51\n340\n\
0\nENDSEC\n0\nEOF\n";

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let out = args.get(2).cloned().unwrap_or_else(|| "sample.png".into());
    let size: u32 = args.get(3).and_then(|s| s.parse().ok()).unwrap_or(256);

    let text = match args.get(1).filter(|s| !s.is_empty()) {
        Some(path) => std::fs::read_to_string(path).expect("read input dxf"),
        None => SAMPLE.to_string(),
    };

    let shapes = dxf::parse(&text);
    println!("parsed {} shapes", shapes.len());

    let rgba = render::render_rgba(&shapes, size).expect("render");
    image::save_buffer(&out, &rgba, size, size, image::ColorType::Rgba8).expect("save png");
    println!("wrote {out} ({size}x{size})");
}
