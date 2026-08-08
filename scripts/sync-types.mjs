#!/usr/bin/env node
/**
 * sync-types.mjs — Re-sync types/engine-sdk.d.ts from the platform source.
 *
 * Copies the canonical generated packages/engine-sdk/index.d.ts from the
 * platform repo into this package. Build the platform shared package first.
 *
 * Usage:
 *   node scripts/sync-types.mjs                          # auto-detect sibling ../agentic-trading
 *   node scripts/sync-types.mjs --from /abs/path/to/repo # explicit path
 *
 * npm script:  npm run sync-types
 */

import { copyFileSync, existsSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Locate platform repo ───────────────────────────────────────────────────

const fromArg  = process.argv.indexOf("--from");
const platform = fromArg >= 0
  ? resolve(process.argv[fromArg + 1])
  : resolve(__dirname, "../../agentic-trading");

const engineSrcPath = resolve(platform, "packages/engine-sdk/index.d.ts");
const remoteSrc = "https://raw.githubusercontent.com/miracleonyenma/agentic-trading/main/packages/shared/engine.d.ts";
const outPath = resolve(__dirname, "../types/engine-sdk.d.ts");

if (existsSync(engineSrcPath)) {
  copyFileSync(engineSrcPath, outPath);
  console.log(`✓  types/engine-sdk.d.ts synced from: ${engineSrcPath}`);
} else {
  const response = await fetch(remoteSrc);
  if (!response.ok) throw new Error(`SDK download failed: ${response.status} ${response.statusText}`);
  writeFileSync(outPath, await response.text(), "utf8");
  console.log(`✓  types/engine-sdk.d.ts synced from: ${remoteSrc}`);
}
console.log(`   Run 'npm run check' to verify no type errors were introduced.`);
