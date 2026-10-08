/**
 * Baseline TIFF reader for the preview a DOS-binary EPS carries (and the
 * Photoshop-EPS raster stand-in): 1/4/8-bit grey or palette, 8-bit RGB(A) and
 * CMYK, uncompressed or PackBits/LZW, chunky or planar. Returns RGBA, or null
 * for anything outside that (never throws).
 */

export interface RgbaImage {
  width: number;
  height: number;
  rgba: Uint8Array;
}

const MAX_PIXELS = 64_000_000;

/** TIFF-flavoured LZW (MSB-first codes, "early change"). */
function lzwDecode(src: Uint8Array, expected: number): Uint8Array {
  const out = new Uint8Array(expected);
  let o = 0;
  const prefix = new Int32Array(4096);
  const suffix = new Uint8Array(4096);
  const lens = new Uint16Array(4096);
  for (let k = 0; k < 256; k++) {
    suffix[k] = k;
    lens[k] = 1;
    prefix[k] = -1;
  }
  let next = 258;
  let bits = 9;
  let buf = 0;
  let nb = 0;
  let i = 0;
  let prev = -1;
  const tmp = new Uint8Array(4097);
  const emit = (code: number): void => {
    const n = lens[code];
    let c = code;
    for (let k = n - 1; k >= 0; k--) {
      tmp[k] = suffix[c];
      c = prefix[c];
    }
    for (let k = 0; k < n && o < expected; k++) out[o++] = tmp[k];
  };
  const firstOf = (code: number): number => {
    let c = code;
    while (prefix[c] !== -1) c = prefix[c];
    return suffix[c];
  };
  while (o < expected) {
    while (nb < bits && i < src.length) {
      buf = ((buf << 8) | src[i++]) >>> 0;
      nb += 8;
    }
    if (nb < bits) break;
    const code = (buf >>> (nb - bits)) & ((1 << bits) - 1);
    nb -= bits;
    buf = nb ? buf & ((1 << nb) - 1) : 0;
    if (code === 257) break;
    if (code === 256) {
      next = 258;
      bits = 9;
      prev = -1;
      continue;
    }
    if (prev === -1) {
      if (code >= 256) break;
      out[o++] = code;
      prev = code;
      continue;
    }
    if (code < next) {
      emit(code);
      if (next < 4096) {
        suffix[next] = firstOf(code);
        prefix[next] = prev;
        lens[next] = lens[prev] + 1;
        next++;
      }
    } else if (code === next && next < 4096) {
      suffix[next] = firstOf(prev);
      prefix[next] = prev;
      lens[next] = lens[prev] + 1;
      next++;
      emit(code);
    } else break;
    if (next + 1 >= 1 << bits && bits < 12) bits++;
    prev = code;
  }
  return out;
}

function packBitsDecode(src: Uint8Array, expected: number): Uint8Array {
  const out = new Uint8Array(expected);
  let o = 0;
  let i = 0;
  while (i < src.length && o < expected) {
    const n = (src[i++] << 24) >> 24;
    if (n >= 0) {
      for (let k = 0; k <= n && i < src.length && o < expected; k++) out[o++] = src[i++];
    } else if (n !== -128) {
      const v = src[i++];
      for (let k = 0; k < 1 - n && o < expected; k++) out[o++] = v;
    }
  }
  return out;
}

export function decodeTiff(bytes: Uint8Array): RgbaImage | null {
  try {
    if (bytes.length < 16) return null;
    const le = bytes[0] === 0x49 && bytes[1] === 0x49;
    if (!le && !(bytes[0] === 0x4d && bytes[1] === 0x4d)) return null;
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const u16 = (o: number) => dv.getUint16(o, le);
    const u32 = (o: number) => dv.getUint32(o, le);
    if (u16(2) !== 42) return null;
    const ifd = u32(4);
    if (ifd + 2 > bytes.length) return null;
    const n = u16(ifd);
    const tags = new Map<number, number[]>();
    for (let i = 0; i < n; i++) {
      const e = ifd + 2 + i * 12;
      if (e + 12 > bytes.length) break;
      const tag = u16(e);
      const type = u16(e + 2);
      const count = u32(e + 4);
      const size = type === 3 ? 2 : type === 4 ? 4 : type === 1 ? 1 : 0;
      if (!size || count > 1_000_000) continue;
      const at = size * count <= 4 ? e + 8 : u32(e + 8);
      const vals: number[] = [];
      for (let k = 0; k < count; k++) {
        const p = at + k * size;
        if (p + size > bytes.length) break;
        vals.push(type === 3 ? u16(p) : type === 4 ? u32(p) : bytes[p]);
      }
      tags.set(tag, vals);
    }
    const g = (t: number, d: number) => tags.get(t)?.[0] ?? d;
    const width = g(256, 0);
    const height = g(257, 0);
    if (width <= 0 || height <= 0 || width * height > MAX_PIXELS) return null;
    const bps = g(258, 1);
    const compression = g(259, 1);
    const photo = g(262, 1);
    const spp = g(277, 1);
    const planar = g(284, 1) === 2;
    const predictor = g(317, 1);
    const rps = Math.min(g(278, height), height) || height;
    if (![1, 4, 8].includes(bps) || ![1, 5, 32773].includes(compression)) return null;
    if (bps !== 8 && spp !== 1) return null;
    const oneChan = spp === 1 || (spp === 2 && (photo === 3 || photo === 0 || photo === 1));
    const offsets = tags.get(273) ?? [];
    const counts = tags.get(279) ?? [];
    const strips = Math.ceil(height / rps);
    const planes = planar ? spp : 1;
    const rowBytes = planar ? Math.ceil((width * bps) / 8) : Math.ceil((width * spp * bps) / 8);
    const data = new Uint8Array(rowBytes * height * planes);
    let si = 0;
    for (let pl = 0; pl < planes; pl++) {
      for (let s = 0; s < strips; s++, si++) {
        const rows = Math.min(rps, height - s * rps);
        const want = rows * rowBytes;
        const off = offsets[si];
        if (off === undefined || off >= bytes.length) return null;
        const len = counts[si] ?? bytes.length - off;
        const src = bytes.subarray(off, Math.min(bytes.length, off + len));
        let strip: Uint8Array;
        if (compression === 1) strip = src;
        else if (compression === 32773) strip = packBitsDecode(src, want);
        else strip = lzwDecode(src, want);
        if (predictor === 2 && bps === 8) {
          const sp = planar ? 1 : spp;
          const cp = new Uint8Array(want);
          cp.set(strip.subarray(0, want));
          for (let r = 0; r < rows; r++) for (let x = sp; x < rowBytes; x++) cp[r * rowBytes + x] = (cp[r * rowBytes + x] + cp[r * rowBytes + x - sp]) & 255;
          strip = cp;
        }
        data.set(strip.subarray(0, want), (pl * height + s * rps) * rowBytes);
      }
    }
    const rgba = new Uint8Array(width * height * 4);
    const cmap = tags.get(320);
    const px = (x: number, y: number, ch: number): number => (planar ? data[(ch * height + y) * rowBytes + x] : data[y * rowBytes + x * spp + ch]) ?? 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const o = (y * width + x) * 4;
        let r = 0;
        let gg = 0;
        let b = 0;
        let a = 255;
        if (oneChan) {
          let v: number;
          if (bps === 8) {
            v = px(x, y, 0);
            if (spp === 2) a = px(x, y, 1);
          } else {
            const bit = x * bps;
            const byte = data[y * rowBytes + (bit >> 3)] ?? 0;
            v = (byte >> (8 - bps - (bit & 7))) & ((1 << bps) - 1);
          }
          if (photo === 3 && cmap) {
            const sz = 1 << bps;
            r = (cmap[v] ?? 0) >> 8;
            gg = (cmap[sz + v] ?? 0) >> 8;
            b = (cmap[2 * sz + v] ?? 0) >> 8;
          } else {
            let l = Math.round((v * 255) / ((1 << bps) - 1));
            if (photo === 0) l = 255 - l;
            r = gg = b = l;
          }
        } else if (photo === 2 && spp >= 3) {
          r = px(x, y, 0);
          gg = px(x, y, 1);
          b = px(x, y, 2);
          if (spp >= 4) a = px(x, y, 3);
        } else if (photo === 5 && spp >= 4) {
          const k = 1 - px(x, y, 3) / 255;
          r = Math.round((255 - px(x, y, 0)) * k);
          gg = Math.round((255 - px(x, y, 1)) * k);
          b = Math.round((255 - px(x, y, 2)) * k);
        } else return null;
        rgba[o] = r;
        rgba[o + 1] = gg;
        rgba[o + 2] = b;
        rgba[o + 3] = a;
      }
    }
    return { width, height, rgba };
  } catch {
    return null;
  }
}

/** Box-filter downscale so the longest side is at most `maxSide` (returns the input when already small). */
export function downscale(img: RgbaImage, maxSide: number): RgbaImage {
  const s = Math.max(img.width, img.height) / maxSide;
  if (s <= 1) return img;
  const w = Math.max(1, Math.round(img.width / s));
  const h = Math.max(1, Math.round(img.height / s));
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor((y * img.height) / h);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * img.height) / h));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor((x * img.width) / w);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * img.width) / w));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let c = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const i = (yy * img.width + xx) * 4;
          r += img.rgba[i];
          g += img.rgba[i + 1];
          b += img.rgba[i + 2];
          a += img.rgba[i + 3];
          c++;
        }
      }
      const o = (y * w + x) * 4;
      out[o] = r / c;
      out[o + 1] = g / c;
      out[o + 2] = b / c;
      out[o + 3] = a / c;
    }
  }
  return { width: w, height: h, rgba: out };
}
