// Regenerates packages/core/src/theme.schema.json from themeFile.ts (TH-01).
import { build } from "esbuild";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const out = join(mkdtempSync(join(tmpdir(), "sk-theme-")), "t.mjs");
await build({ entryPoints: ["packages/core/src/themeFile.ts"], bundle: true, format: "esm", platform: "neutral", outfile: out, logLevel: "error" });
const { themeJsonSchema } = await import(pathToFileURL(out).href);
writeFileSync("packages/core/src/theme.schema.json", JSON.stringify(themeJsonSchema(), null, 2) + "\n");
console.log("wrote packages/core/src/theme.schema.json");
