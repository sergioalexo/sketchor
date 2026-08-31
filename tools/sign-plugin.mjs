#!/usr/bin/env node
// Sketchor plugin signing tool.
//
// A publisher signs their plugin bundle with an Ed25519 key; Sketchor verifies
// the signature (WebCrypto Ed25519) before running a single line of the plugin.
// See packages/core/src/plugin/signing.ts — the separators below MUST match
// `bundleMessage` there.
//
//   node tools/sign-plugin.mjs keygen [keyfile.json]
//   node tools/sign-plugin.mjs sign <manifest.json> <plugin.js> [ui.html] --key keyfile.json > bundle.json
//
// keygen writes a private key (JWK) to keyfile.json (default plugin-key.json)
// and prints the public key. Keep the private key secret; never commit it.

import crypto from "node:crypto";
import fs from "node:fs";

const SEP_CODE = "\n--sketchor:code--\n";
const SEP_UI = "\n--sketchor:ui--\n";

const b64 = (buf) => Buffer.from(buf).toString("base64");
const rawPubFromJwk = (jwk) => Buffer.from(jwk.x, "base64url");

function keygen(file = "plugin-key.json") {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const privJwk = privateKey.export({ format: "jwk" });
  fs.writeFileSync(file, JSON.stringify(privJwk, null, 2));
  const pub = b64(rawPubFromJwk(publicKey.export({ format: "jwk" })));
  process.stderr.write(`Wrote private key to ${file} (keep it secret).\n`);
  process.stderr.write(`Public key (base64): ${pub}\n`);
}

function sign(args) {
  const keyIdx = args.indexOf("--key");
  if (keyIdx === -1) throw new Error("--key <keyfile.json> is required");
  const keyFile = args[keyIdx + 1];
  const positional = args.slice(0, keyIdx);
  const [manifestPath, codePath, uiPath] = positional;
  if (!manifestPath || !codePath) throw new Error("usage: sign <manifest.json> <plugin.js> [ui.html] --key keyfile.json");

  const manifest = fs.readFileSync(manifestPath, "utf8");
  const code = fs.readFileSync(codePath, "utf8");
  const ui = uiPath ? fs.readFileSync(uiPath, "utf8") : undefined;

  const jwk = JSON.parse(fs.readFileSync(keyFile, "utf8"));
  const privateKey = crypto.createPrivateKey({ key: jwk, format: "jwk" });
  const publicKey = b64(rawPubFromJwk(jwk));

  const message = manifest + SEP_CODE + code + (ui !== undefined ? SEP_UI + ui : "");
  const signature = b64(crypto.sign(null, Buffer.from(message, "utf8"), privateKey));

  const bundle = { manifest, code, ...(ui !== undefined ? { ui } : {}), signature, publicKey };
  process.stdout.write(JSON.stringify(bundle, null, 2) + "\n");
}

const [cmd, ...rest] = process.argv.slice(2);
try {
  if (cmd === "keygen") keygen(rest[0]);
  else if (cmd === "sign") sign(rest);
  else throw new Error(`unknown command "${cmd ?? ""}" — use "keygen" or "sign"`);
} catch (err) {
  process.stderr.write(`error: ${err.message}\n`);
  process.exit(1);
}
