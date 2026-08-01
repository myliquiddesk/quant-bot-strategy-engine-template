#!/usr/bin/env node
/**
 * sync-types.mjs — Re-sync types/engine-sdk.d.ts from the platform source.
 *
 * Reads packages/shared/src/schemas/engine.ts from the platform repo and
 * replaces the "Engine context", "Manifest", and "Module exports contract"
 * sections in types/engine-sdk.d.ts.  Market + signal types (Candle, Signal,
 * etc.) are stable and kept as-is.
 *
 * Usage:
 *   node scripts/sync-types.mjs                          # auto-detect sibling ../agentic-trading
 *   node scripts/sync-types.mjs --from /abs/path/to/repo # explicit path
 *
 * npm script:  npm run sync-types
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Locate platform repo ───────────────────────────────────────────────────

const fromArg  = process.argv.indexOf("--from");
const platform = fromArg >= 0
  ? resolve(process.argv[fromArg + 1])
  : resolve(__dirname, "../../agentic-trading");

const engineSrcPath = resolve(platform, "packages/shared/src/schemas/engine.ts");

if (!existsSync(engineSrcPath)) {
  console.error(`✗  Platform source not found: ${engineSrcPath}`);
  console.error(`   Specify the path with: node scripts/sync-types.mjs --from /path/to/agentic-trading`);
  process.exit(1);
}

// ─── Extract concrete TypeScript declarations from engine.ts ────────────────
// Skips imports and Zod schema constants (e.g. `export const XSchema = z.object`).
// Captures: export interface, export type (non-zod), export enum.

function extractConcrete(source) {
  const lines   = source.split("\n");
  const out     = [];
  let depth     = 0;
  let capturing = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("import ")) continue;

    if (!capturing) {
      if (!/^export\s+(interface|enum)\s+/.test(trimmed) &&
          !/^export\s+type\s+\w+\s*=\s*(?!.*z\.infer)/.test(trimmed)) {
        continue;
      }
      capturing = true;
      depth     = 0;
    }

    for (const ch of line) {
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
    }
    out.push(line);

    if (depth <= 0) {
      const last = out[out.length - 1].trim();
      if (last.endsWith(";") || last === "}" || last.endsWith(",")) {
        capturing = false;
        out.push("");
      }
    }
  }
  return out.join("\n").trim();
}

const engineSrc  = readFileSync(engineSrcPath, "utf-8");
const newEngineTypes = extractConcrete(engineSrc);

if (!newEngineTypes) {
  console.error("✗  No concrete types extracted from engine.ts — check the source file.");
  process.exit(1);
}

// ─── Update types/engine-sdk.d.ts ───────────────────────────────────────────

const outPath   = resolve(__dirname, "../types/engine-sdk.d.ts");
const existing  = readFileSync(outPath, "utf-8");

// Replace from "// ─── Engine context" section to the end of the module block
const SECTION_START = "  // ─── Engine context";
const MODULE_END    = "\n}";

const splitIdx = existing.indexOf(SECTION_START);
if (splitIdx === -1) {
  console.error(`✗  Could not find section marker "${SECTION_START}" in types/engine-sdk.d.ts`);
  console.error(`   Has the file been manually restructured? Run the script on a clean copy.`);
  process.exit(1);
}

// Find where the module block closes (last "}" in the file)
const closeIdx = existing.lastIndexOf(MODULE_END);
const before   = existing.slice(0, splitIdx).trimEnd();

// Indent the extracted types by 2 spaces (they're inside declare module)
const indented = newEngineTypes
  .split("\n")
  .map((l) => (l === "" ? "" : "  " + l))
  .join("\n");

const updated = `${before}\n\n${indented}\n}`;

writeFileSync(outPath, updated, "utf-8");

console.log(`✓  types/engine-sdk.d.ts updated from: ${engineSrcPath}`);
console.log(`   Run 'npm run check' to verify no type errors were introduced.`);
