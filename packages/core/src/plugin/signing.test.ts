import { describe, expect, it } from "vitest";
import { bundleMessage, bytesToBase64, verifyBundleSignature, type SignedBundle } from "./signing";

/**
 * The trust gate. A plugin's code and manifest run only after this verifies the
 * publisher's signature over them, so these two cases — a genuine signature
 * passes, any tampering fails — are the crux of the whole install-time security
 * model. Signatures are minted here with the same WebCrypto Ed25519 the host
 * verifies with, so the test exercises the real path end to end.
 */

async function signBundle(
  bundle: { manifest: string; code: string; ui?: string },
): Promise<SignedBundle> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const signature = new Uint8Array(
    await crypto.subtle.sign({ name: "Ed25519" }, pair.privateKey, bundleMessage(bundle)),
  );
  const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  return { ...bundle, signature: bytesToBase64(signature), publicKey: bytesToBase64(publicKey) };
}

describe("verifyBundleSignature", () => {
  const source = { manifest: '{"id":"com.example.x","version":"1.0.0"}', code: "export default { activate() {} }" };

  it("accepts a bundle whose signature matches its contents", async () => {
    const bundle = await signBundle(source);
    expect(await verifyBundleSignature(bundle)).toBe(true);
  });

  it("rejects a bundle whose code was changed after signing", async () => {
    const bundle = await signBundle(source);
    const tampered: SignedBundle = { ...bundle, code: bundle.code + "\nglobalThis.stealData()" };
    expect(await verifyBundleSignature(tampered)).toBe(false);
  });

  it("rejects a bundle whose manifest was changed after signing", async () => {
    const bundle = await signBundle(source);
    // e.g. a plugin trying to grant itself a permission the signer never approved.
    const tampered: SignedBundle = { ...bundle, manifest: bundle.manifest.replace("1.0.0", "9.9.9") };
    expect(await verifyBundleSignature(tampered)).toBe(false);
  });

  it("fails closed on a malformed signature rather than throwing", async () => {
    const bundle = await signBundle(source);
    expect(await verifyBundleSignature({ ...bundle, signature: "not-base64!!" })).toBe(false);
  });
});
