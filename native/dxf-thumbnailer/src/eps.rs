//! Thumbnails for `.eps` / `.ai` files (plan F-03, tier 2): the TIFF preview
//! a DOS-binary EPS (`C5 D0 D3 C6`) carries. Illustrator and Photoshop both
//! write one, so the Explorer picture is exactly what the author saw — no
//! PostScript is interpreted here. A file without the DOS header (or without a
//! TIFF in it) gets no thumbnail and Explorer shows the file's icon.
//!
//! Only the 30-byte header and the preview's bytes are read, never the
//! PostScript or raster body, so a 260 MB Photoshop EPS costs a few
//! milliseconds. The TIFF reader is the baseline subset the writers use
//! (mirrors `packages/core/src/eps/tiff.ts`): 1/4/8-bit grey or palette,
//! 8-bit RGB(A)/CMYK, uncompressed or PackBits, chunky.

use std::io::{Read, Seek, SeekFrom};

/// A decoded preview: RGBA8, square (`size` x `size`, centred on white), the
/// shape `render::bitmap_from_rgba` takes.
pub struct Preview {
    pub rgba: Vec<u8>,
    pub size: u32,
}

/// Largest TIFF read from a file: the biggest previews seen are ~5 MB.
const MAX_TIFF_BYTES: u64 = 48 * 1024 * 1024;
/// Largest image decoded (pixels).
const MAX_PIXELS: u64 = 40_000_000;

pub fn is_eps(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    lower.ends_with(".eps") || lower.ends_with(".ai")
}

/// The preview of the EPS at `path`, if it has a readable DOS-header TIFF.
pub fn preview(path: &str) -> Option<Preview> {
    let mut f = std::fs::File::open(path).ok()?;
    let mut head = [0u8; 30];
    f.read_exact(&mut head).ok()?;
    let (off, len) = tiff_range(&head)?;
    if len == 0 || len > MAX_TIFF_BYTES {
        return None;
    }
    f.seek(SeekFrom::Start(off)).ok()?;
    let mut buf = Vec::new();
    f.take(len).read_to_end(&mut buf).ok()?;
    preview_from_tiff(&buf)
}

/// `(offset, length)` of the TIFF preview in a DOS EPS header.
pub fn tiff_range(head: &[u8]) -> Option<(u64, u64)> {
    if head.len() < 28 || head[..4] != [0xC5, 0xD0, 0xD3, 0xC6] {
        return None;
    }
    let u32le = |o: usize| u32::from_le_bytes([head[o], head[o + 1], head[o + 2], head[o + 3]]) as u64;
    Some((u32le(20), u32le(24)))
}

/// Decodes a TIFF into a square white-padded RGBA preview.
pub fn preview_from_tiff(tiff: &[u8]) -> Option<Preview> {
    let (w, h, rgba) = decode_tiff(tiff)?;
    let size = w.max(h);
    let mut out = vec![255u8; (size as usize) * (size as usize) * 4];
    let (ox, oy) = ((size - w) / 2, (size - h) / 2);
    for y in 0..h as usize {
        let dst = ((y + oy as usize) * size as usize + ox as usize) * 4;
        let src = y * w as usize * 4;
        out[dst..dst + w as usize * 4].copy_from_slice(&rgba[src..src + w as usize * 4]);
    }
    Some(Preview { rgba: out, size })
}

struct Reader<'a> {
    b: &'a [u8],
    le: bool,
}

impl Reader<'_> {
    fn u16(&self, o: usize) -> Option<u32> {
        let s = self.b.get(o..o + 2)?;
        Some(if self.le { u16::from_le_bytes([s[0], s[1]]) } else { u16::from_be_bytes([s[0], s[1]]) } as u32)
    }
    fn u32(&self, o: usize) -> Option<u32> {
        let s = self.b.get(o..o + 4)?;
        Some(if self.le { u32::from_le_bytes([s[0], s[1], s[2], s[3]]) } else { u32::from_be_bytes([s[0], s[1], s[2], s[3]]) })
    }
    /// All values of tag `tag` in the first IFD (SHORT / LONG / BYTE).
    fn tag(&self, ifd: usize, n: u32, tag: u32) -> Option<Vec<u32>> {
        for i in 0..n as usize {
            let e = ifd + 2 + i * 12;
            if self.u16(e)? != tag {
                continue;
            }
            let typ = self.u16(e + 2)?;
            let count = self.u32(e + 4)? as usize;
            let size = match typ {
                1 => 1,
                3 => 2,
                4 => 4,
                _ => return None,
            };
            if count > 1_000_000 {
                return None;
            }
            let at = if size * count <= 4 { e + 8 } else { self.u32(e + 8)? as usize };
            let mut v = Vec::with_capacity(count);
            for k in 0..count {
                let p = at + k * size;
                v.push(match typ {
                    1 => *self.b.get(p)? as u32,
                    3 => self.u16(p)?,
                    _ => self.u32(p)?,
                });
            }
            return Some(v);
        }
        None
    }
}

fn packbits(src: &[u8], want: usize) -> Vec<u8> {
    let mut out = Vec::with_capacity(want);
    let mut i = 0;
    while i < src.len() && out.len() < want {
        let n = src[i] as i8;
        i += 1;
        if n >= 0 {
            let c = n as usize + 1;
            let end = (i + c).min(src.len());
            out.extend_from_slice(&src[i..end]);
            i = end;
        } else if n != -128 {
            if let Some(&v) = src.get(i) {
                out.extend(std::iter::repeat(v).take((1 - n as i16) as usize));
            }
            i += 1;
        }
    }
    out.truncate(want);
    out
}

/// `(width, height, rgba)` for a baseline TIFF, or None when unsupported.
pub fn decode_tiff(b: &[u8]) -> Option<(u32, u32, Vec<u8>)> {
    if b.len() < 16 {
        return None;
    }
    let le = match &b[..2] {
        b"II" => true,
        b"MM" => false,
        _ => return None,
    };
    let r = Reader { b, le };
    if r.u16(2)? != 42 {
        return None;
    }
    let ifd = r.u32(4)? as usize;
    let n = r.u16(ifd)?;
    let g = |t: u32, d: u32| r.tag(ifd, n, t).and_then(|v| v.first().copied()).unwrap_or(d);
    let (width, height) = (g(256, 0), g(257, 0));
    if width == 0 || height == 0 || (width as u64) * (height as u64) > MAX_PIXELS {
        return None;
    }
    let (bps, compression, photo, spp) = (g(258, 1), g(259, 1), g(262, 1), g(277, 1));
    let planar = g(284, 1) == 2;
    let predictor = g(317, 1);
    let rps = g(278, height).min(height).max(1);
    if planar || !matches!(bps, 1 | 4 | 8) || !matches!(compression, 1 | 32773) || (bps != 8 && spp != 1) || predictor != 1 {
        return None;
    }
    let offsets = r.tag(ifd, n, 273)?;
    let counts = r.tag(ifd, n, 279).unwrap_or_default();
    let row_bytes = ((width as u64 * spp as u64 * bps as u64 + 7) / 8) as usize;
    let mut data = vec![0u8; row_bytes * height as usize];
    let strips = ((height + rps - 1) / rps) as usize;
    for s in 0..strips {
        let rows = rps.min(height - s as u32 * rps) as usize;
        let want = rows * row_bytes;
        let off = *offsets.get(s)? as usize;
        let len = counts.get(s).copied().map(|c| c as usize).unwrap_or(b.len().saturating_sub(off));
        let src = b.get(off..(off + len).min(b.len()))?;
        let dst = s * rps as usize * row_bytes;
        if compression == 1 {
            let k = want.min(src.len());
            data[dst..dst + k].copy_from_slice(&src[..k]);
        } else {
            let p = packbits(src, want);
            data[dst..dst + p.len()].copy_from_slice(&p);
        }
    }
    let cmap = r.tag(ifd, n, 320);
    let mut rgba = vec![255u8; width as usize * height as usize * 4];
    let one_chan = spp == 1 || (spp == 2 && matches!(photo, 0 | 1 | 3));
    for y in 0..height as usize {
        for x in 0..width as usize {
            let o = (y * width as usize + x) * 4;
            let row = &data[y * row_bytes..(y + 1) * row_bytes];
            let (rr, gg, bb, aa): (u8, u8, u8, u8);
            if one_chan {
                let v = if bps == 8 {
                    row[x * spp as usize] as u32
                } else {
                    let bit = x * bps as usize;
                    ((row[bit >> 3] as u32) >> (8 - bps as usize - (bit & 7))) & ((1 << bps) - 1)
                };
                aa = if bps == 8 && spp == 2 { row[x * 2 + 1] } else { 255 };
                if photo == 3 {
                    let cm = cmap.as_ref()?;
                    let sz = 1usize << bps;
                    rr = (*cm.get(v as usize)? >> 8) as u8;
                    gg = (*cm.get(sz + v as usize)? >> 8) as u8;
                    bb = (*cm.get(2 * sz + v as usize)? >> 8) as u8;
                } else {
                    let mut l = ((v * 255) / ((1 << bps) - 1)) as u8;
                    if photo == 0 {
                        l = 255 - l;
                    }
                    rr = l;
                    gg = l;
                    bb = l;
                }
            } else if photo == 2 && spp >= 3 {
                let p = &row[x * spp as usize..];
                rr = p[0];
                gg = p[1];
                bb = p[2];
                aa = if spp >= 4 { p[3] } else { 255 };
            } else if photo == 5 && spp >= 4 {
                let p = &row[x * spp as usize..];
                let k = 255 - p[3] as u32;
                rr = ((255 - p[0] as u32) * k / 255) as u8;
                gg = ((255 - p[1] as u32) * k / 255) as u8;
                bb = ((255 - p[2] as u32) * k / 255) as u8;
                aa = 255;
            } else {
                return None;
            }
            // composite on white so a transparent preview doesn't render black
            let a = aa as u32;
            rgba[o] = ((rr as u32 * a + 255 * (255 - a)) / 255) as u8;
            rgba[o + 1] = ((gg as u32 * a + 255 * (255 - a)) / 255) as u8;
            rgba[o + 2] = ((bb as u32 * a + 255 * (255 - a)) / 255) as u8;
            rgba[o + 3] = 255;
        }
    }
    Some((width, height, rgba))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 2x1 RGB little-endian TIFF: red, blue.
    fn tiny() -> Vec<u8> {
        let px = [255u8, 0, 0, 0, 0, 255];
        let entries: [(u16, u16, u32, u32); 9] = [
            (256, 3, 1, 2), (257, 3, 1, 1), (258, 3, 3, 0), (259, 3, 1, 1), (262, 3, 1, 2),
            (273, 4, 1, 8), (277, 3, 1, 3), (278, 3, 1, 1), (279, 4, 1, 6),
        ];
        let ifd = 8 + px.len();
        let bps_at = ifd + 2 + entries.len() * 12 + 4;
        let mut t = vec![0u8; bps_at + 6];
        t[..4].copy_from_slice(&[0x49, 0x49, 42, 0]);
        t[4..8].copy_from_slice(&(ifd as u32).to_le_bytes());
        t[8..8 + px.len()].copy_from_slice(&px);
        t[ifd..ifd + 2].copy_from_slice(&(entries.len() as u16).to_le_bytes());
        for (i, (tag, typ, count, val)) in entries.iter().enumerate() {
            let o = ifd + 2 + i * 12;
            t[o..o + 2].copy_from_slice(&tag.to_le_bytes());
            t[o + 2..o + 4].copy_from_slice(&typ.to_le_bytes());
            t[o + 4..o + 8].copy_from_slice(&count.to_le_bytes());
            if *tag == 258 {
                t[o + 8..o + 12].copy_from_slice(&(bps_at as u32).to_le_bytes());
            } else if *typ == 3 {
                t[o + 8..o + 10].copy_from_slice(&(*val as u16).to_le_bytes());
            } else {
                t[o + 8..o + 12].copy_from_slice(&val.to_le_bytes());
            }
        }
        for k in 0..3 {
            t[bps_at + k * 2..bps_at + k * 2 + 2].copy_from_slice(&8u16.to_le_bytes());
        }
        t
    }

    #[test]
    fn decodes_baseline_rgb() {
        let (w, h, rgba) = decode_tiff(&tiny()).unwrap();
        assert_eq!((w, h), (2, 1));
        assert_eq!(&rgba[..4], &[255, 0, 0, 255]);
        assert_eq!(&rgba[4..8], &[0, 0, 255, 255]);
    }

    #[test]
    fn pads_to_a_square_on_white() {
        let p = preview_from_tiff(&tiny()).unwrap();
        assert_eq!(p.size, 2);
        // 2x1 centred in 2x2: the picture sits in the lower row (oy = 0 for h=1: (2-1)/2 = 0)
        assert_eq!(p.rgba.len(), 16);
    }

    #[test]
    fn rejects_garbage_and_truncation() {
        assert!(decode_tiff(&[]).is_none());
        assert!(decode_tiff(b"not a tiff at all, just text").is_none());
        let t = tiny();
        for cut in 0..t.len() {
            let _ = decode_tiff(&t[..cut]); // must not panic
        }
    }

    #[test]
    fn dos_header_range() {
        let mut h = [0u8; 30];
        h[..4].copy_from_slice(&[0xC5, 0xD0, 0xD3, 0xC6]);
        h[20..24].copy_from_slice(&1000u32.to_le_bytes());
        h[24..28].copy_from_slice(&50u32.to_le_bytes());
        assert_eq!(tiff_range(&h), Some((1000, 50)));
        h[0] = 0;
        assert_eq!(tiff_range(&h), None);
    }

    #[test]
    fn extension_check() {
        assert!(is_eps("C:\\x\\Art.EPS") && is_eps("a.ai") && !is_eps("a.dxf"));
    }
}
