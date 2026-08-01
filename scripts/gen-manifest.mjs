#!/usr/bin/env node
/**
 * gen-manifest.mjs
 *
 * Extracts the `manifest` named export from a compiled engine bundle and
 * writes it to manifest.json in the repo root.
 *
 * Usage:
 *   node scripts/gen-manifest.mjs               # reads engine.js
 *   node scripts/gen-manifest.mjs --entry my-engine.js
 *
 * Runs automatically as the final step of every build script in package.json.
 */

import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const entryArg  = process.argv.indexOf("--entry");
const entryFile = entryArg >= 0 ? process.argv[entryArg + 1] : "engine.js";

const enginePath = resolve(__dirname, "..", entryFile);
const outPath    = resolve(__dirname, "../manifest.json");

const { manifest } = await import(`${enginePath}?t=${Date.now()}`);

if (!manifest || typeof manifest !== "object") {
  console.error("gen-manifest: bundle does not export a `manifest` object — add `export const manifest: EngineManifest = { ... }` to your engine.");
  process.exit(1);
}

writeFileSync(outPath, JSON.stringify(manifest, null, 2) + "\n", "utf-8");
console.log(`gen-manifest: wrote manifest.json (v${manifest.version}) from ${entryFile}`);
