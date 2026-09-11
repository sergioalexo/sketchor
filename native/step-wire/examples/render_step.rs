//! Renders a STEP file's wireframe (as the Explorer thumbnailer would draw it)
//! to a PNG, for eyeballing the result without registering anything.
//!
//!   cargo run --release --example render_step -- input.step out.png [size]

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let input = args.get(1).expect("input.step");
    let out = args.get(2).cloned().unwrap_or_else(|| "step.png".into());
    let size: usize = args.get(3).and_then(|s| s.parse().ok()).unwrap_or(256);

    let t0 = std::time::Instant::now();
    let text = std::fs::read_to_string(input).expect("read");
    let segs = step_wire::parse(&text);
    let parsed = t0.elapsed();
    let segs = step_wire::thin(&segs, 300_000);
    let lines = step_wire::project_iso(&segs);
    println!("{} segments in {:?}", segs.len(), parsed);

    let (mut lo_x, mut lo_y, mut hi_x, mut hi_y) = (f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY);
    for l in &lines {
        lo_x = lo_x.min(l.x1).min(l.x2);
        hi_x = hi_x.max(l.x1).max(l.x2);
        lo_y = lo_y.min(l.y1).min(l.y2);
        hi_y = hi_y.max(l.y1).max(l.y2);
    }
    let pad = size as f64 * 0.1;
    let w = (hi_x - lo_x).max(1e-9);
    let h = (hi_y - lo_y).max(1e-9);
    let scale = ((size as f64 - 2.0 * pad) / w).min((size as f64 - 2.0 * pad) / h);
    let ox = (size as f64 - w * scale) / 2.0;
    let oy = (size as f64 - h * scale) / 2.0;
    let mut img = vec![0u8; size * size * 4];
    for px in img.chunks_mut(4) {
        px.copy_from_slice(&[30, 31, 34, 255]);
    }
    let mut plot = |x: i64, y: i64| {
        if x >= 0 && y >= 0 && (x as usize) < size && (y as usize) < size {
            let i = (y as usize * size + x as usize) * 4;
            img[i..i + 3].copy_from_slice(&[199, 208, 220]);
        }
    };
    for l in &lines {
        let (x1, y1) = (ox + (l.x1 - lo_x) * scale, oy + (hi_y - l.y1) * scale);
        let (x2, y2) = (ox + (l.x2 - lo_x) * scale, oy + (hi_y - l.y2) * scale);
        let n = ((x2 - x1).abs().max((y2 - y1).abs()).ceil() as usize).max(1);
        for k in 0..=n {
            let t = k as f64 / n as f64;
            plot((x1 + (x2 - x1) * t).round() as i64, (y1 + (y2 - y1) * t).round() as i64);
        }
    }
    image::save_buffer(&out, &img, size as u32, size as u32, image::ColorType::Rgba8).expect("png");
    println!("wrote {out}");
}
