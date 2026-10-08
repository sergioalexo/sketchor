//! Dumps the DOS-EPS TIFF preview the Explorer provider would show:
//! `cargo run --release --example eps_preview -- file.eps out.png`
use dxf_thumbnailer::eps;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 3 {
        eprintln!("usage: eps_preview <file.eps|.ai> <out.png>");
        std::process::exit(2);
    }
    match eps::preview(&args[1]) {
        Some(p) => {
            image::save_buffer(&args[2], &p.rgba, p.size, p.size, image::ColorType::Rgba8).expect("write png");
            println!("preview {}x{} -> {}", p.size, p.size, args[2]);
        }
        None => {
            println!("no preview");
            std::process::exit(1);
        }
    }
}
