/**
 * Minimal PNG writer (RGBA, 8 bit) with *stored* deflate blocks — no
 * dependency and no browser API, so EPS preview images can be turned into a
 * `data:image/png` URI in core and in Node tests alike. Larger than a
 * compressed PNG; callers downscale first (previews are small anyway).
 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array, start: number, end: number): number {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < bytes.length; i++) {
    a = (a + bytes[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/** Encodes `rgba` (width*height*4 bytes) as a PNG file. */
export function encodePng(width: number, height: number, rgba: Uint8Array | Uint8ClampedArray): Uint8Array {
  const stride = width * 4;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  // zlib wrapper around stored blocks (max 65535 bytes each).
  const blocks = Math.max(1, Math.ceil(raw.length / 65535));
  const z = new Uint8Array(2 + raw.length + blocks * 5 + 4);
  let o = 0;
  z[o++] = 0x78;
  z[o++] = 0x01;
  for (let i = 0; i < blocks; i++) {
    const start = i * 65535;
    const len = Math.min(65535, raw.length - start);
    z[o++] = i === blocks - 1 ? 1 : 0;
    z[o++] = len & 0xff;
    z[o++] = len >>> 8;
    z[o++] = ~len & 0xff;
    z[o++] = (~len >>> 8) & 0xff;
    z.set(raw.subarray(start, start + len), o);
    o += len;
  }
  const ad = adler32(raw);
  z[o++] = ad >>> 24;
  z[o++] = (ad >>> 16) & 0xff;
  z[o++] = (ad >>> 8) & 0xff;
  z[o++] = ad & 0xff;

  const out = new Uint8Array(8 + 25 + (12 + z.length) + 12);
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const dv = new DataView(out.buffer);
  let p = 8;
  const chunk = (type: string, data: Uint8Array) => {
    dv.setUint32(p, data.length);
    for (let i = 0; i < 4; i++) out[p + 4 + i] = type.charCodeAt(i);
    out.set(data, p + 8);
    dv.setUint32(p + 8 + data.length, crc32(out, p + 4, p + 8 + data.length));
    p += 12 + data.length;
  };
  const ihdr = new Uint8Array(13);
  const hv = new DataView(ihdr.buffer);
  hv.setUint32(0, width);
  hv.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  chunk("IHDR", ihdr);
  chunk("IDAT", z);
  chunk("IEND", new Uint8Array(0));
  return out;
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Base64 of `bytes` (no `btoa`/`Buffer` so it runs anywhere). */
export function bytesToBase64(bytes: Uint8Array): string {
  const parts: string[] = [];
  const CH = 3 * 8192;
  for (let s = 0; s < bytes.length; s += CH) {
    let out = "";
    const e = Math.min(bytes.length, s + CH);
    for (let i = s; i < e; i += 3) {
      const a = bytes[i];
      const b = i + 1 < e ? bytes[i + 1] : 0;
      const c = i + 2 < e ? bytes[i + 2] : 0;
      out += B64[a >> 2] + B64[((a & 3) << 4) | (b >> 4)] + (i + 1 < e ? B64[((b & 15) << 2) | (c >> 6)] : "=") + (i + 2 < e ? B64[c & 63] : "=");
    }
    parts.push(out);
  }
  return parts.join("");
}

/** A `data:image/png;base64,…` URI for an RGBA bitmap. */
export function rgbaToPngDataUrl(width: number, height: number, rgba: Uint8Array | Uint8ClampedArray): string {
  return "data:image/png;base64," + bytesToBase64(encodePng(width, height, rgba));
}
