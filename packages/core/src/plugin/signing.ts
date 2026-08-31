/**
 * Plugin bundle signing — the trust layer's cryptographic core. A publisher
 * signs the bundle (manifest + code + optional UI) with an Ed25519 key; the host
 * verifies that signature against the signer's public key **before it runs a
 * single line** of the plugin. Tampering with either the manifest or the code
 * after signing breaks the signature, so a plugin can't quietly grant itself a
 * permission or swap its code.
 *
 * Verification uses WebCrypto Ed25519 (available in the Tauri WebView and modern
 * browsers) and **fails closed** — if the platform can't verify, the plugin is
 * refused, never trusted. Framework-free: reaches only `globalThis.crypto`.
 *
 * Trust in the *key itself* is a separate decision the user makes on install
 * (see the host's install flow): a valid signature proves integrity and that the
 * holder of that private key produced the bundle; it does not, by itself, say
 * the key is trustworthy.
 */

export interface PluginBundle {
  /** Raw `manifest.json` text (parsed separately; signed as-is). */
  manifest: string;
  /** The plugin's entry JS source. */
  code: string;
  /** Optional UI panel HTML. */
  ui?: string;
}

export interface SignedBundle extends PluginBundle {
  /** Base64 Ed25519 signature over {@link bundleMessage}. */
  signature: string;
  /** Base64 raw (32-byte) Ed25519 public key of the signer. */
  publicKey: string;
}

const SEP_CODE = "\n--sketchor:code--\n";
const SEP_UI = "\n--sketchor:ui--\n";

/** The exact bytes a signature covers. Stable and unambiguous across manifest/code/ui. */
export function bundleMessage(bundle: PluginBundle): Uint8Array<ArrayBuffer> {
  const text = bundle.manifest + SEP_CODE + bundle.code + (bundle.ui !== undefined ? SEP_UI + bundle.ui : "");
  // Copy into an ArrayBuffer-backed view so it's a valid WebCrypto BufferSource.
  return new Uint8Array(new TextEncoder().encode(text));
}

function subtle(): SubtleCrypto | null {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  return c?.subtle ?? null;
}

function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/**
 * Verifies a signed bundle. Resolves `true` only when the Ed25519 signature over
 * {@link bundleMessage} checks out against the embedded public key. Any
 * error — malformed key/signature, unsupported platform — resolves `false`
 * (fail closed), never throws.
 */
export async function verifyBundleSignature(bundle: SignedBundle): Promise<boolean> {
  const s = subtle();
  if (!s) return false;
  try {
    const key = await s.importKey("raw", base64ToBytes(bundle.publicKey), { name: "Ed25519" }, false, ["verify"]);
    return await s.verify({ name: "Ed25519" }, key, base64ToBytes(bundle.signature), bundleMessage(bundle));
  } catch {
    return false;
  }
}

/** A short, human-comparable fingerprint of a public key (SHA-256, hex, grouped). */
export async function keyFingerprint(publicKeyB64: string): Promise<string> {
  const s = subtle();
  if (!s) return "unavailable";
  try {
    const digest = new Uint8Array(await s.digest("SHA-256", base64ToBytes(publicKeyB64)));
    const hex = [...digest.slice(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("");
    return hex.replace(/(.{4})(?=.)/g, "$1 ");
  } catch {
    return "unavailable";
  }
}
