#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, resolve } from "node:path";
import matter from "gray-matter";

const INPUT_KEYS = new Set([
  "signal", "openPositions", "recentMemory", "previousAgentOutput", "balance",
  "openOrders", "riskLimits", "instanceConfig", "engineContext", "exchangeData",
]);
const PIPELINE_ROLES = new Set(["market_analysis", "risk_management", "executor"]);
const CONTEXT_ID = /^[a-zA-Z0-9_-]{1,64}$/;
const CONTEXT_EXTENSIONS = new Set([".md", ".txt", ".json", ".yaml", ".yml", ".csv"]);
const MAX_CONTEXT_IDS = 8;

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const agentsDir = resolve(argument("--agents", "AGENTS-template"));
const contextArg = argument("--context", null);
const contextDir = contextArg ? resolve(contextArg) : null;
const jsonOutput = process.argv.includes("--json");

function contextExists(id) {
  if (!contextDir) return true;
  if (!existsSync(contextDir)) return false;
  return readdirSync(contextDir).some((file) => {
    const extension = extname(file).toLowerCase();
    return CONTEXT_EXTENSIONS.has(extension) && file.slice(0, -extension.length) === id;
  });
}

function validateAgent(file) {
  const path = resolve(agentsDir, file);
  const issues = [];
  let parsed;
  try {
    parsed = matter(readFileSync(path, "utf8"));
  } catch (error) {
    return { file, valid: false, issues: [`Could not parse agent: ${error instanceof Error ? error.message : String(error)}`] };
  }
  const frontmatter = parsed.data;
  if (!frontmatter.name) issues.push("Missing required frontmatter field 'name'.");
  else if (typeof frontmatter.name !== "string" || !CONTEXT_ID.test(frontmatter.name)) {
    issues.push("'name' must contain only letters, numbers, hyphens, and underscores (maximum 64 characters).");
  }
  if (!frontmatter.role || typeof frontmatter.role !== "string") issues.push("Missing required string frontmatter field 'role'.");
  if (!parsed.content.trim()) issues.push("System prompt body is empty.");

  if (frontmatter.temperature !== undefined) {
    const temperature = Number(frontmatter.temperature);
    if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) issues.push("'temperature' must be a number between 0 and 2.");
  }
  for (const field of ["active", "optional", "system"]) {
    if (frontmatter[field] !== undefined && typeof frontmatter[field] !== "boolean") issues.push(`'${field}' must be true or false.`);
  }
  if (frontmatter.model !== undefined && frontmatter.model !== null && typeof frontmatter.model !== "string") {
    issues.push("'model' must be a string or null.");
  }

  if (frontmatter.input !== undefined && !Array.isArray(frontmatter.input)) {
    issues.push("'input' must be a YAML list of platform input keys.");
  } else {
    for (const key of frontmatter.input ?? []) {
      if (typeof key !== "string" || !INPUT_KEYS.has(key)) issues.push(`Unknown agent input key: ${JSON.stringify(key)}.`);
    }
  }

  if (frontmatter.output !== undefined && !Array.isArray(frontmatter.output)) {
    issues.push("'output' must be a YAML list of JSON output keys.");
  } else if (PIPELINE_ROLES.has(frontmatter.role) && frontmatter.output?.length) {
    for (const key of ["reasoning", "recommendation", "confidence"]) {
      if (!frontmatter.output.includes(key)) issues.push(`'output' is missing required key '${key}'.`);
    }
  }

  if (frontmatter.context !== undefined && !Array.isArray(frontmatter.context)) {
    issues.push("'context' must be a YAML list of shared context IDs.");
  } else {
    const ids = frontmatter.context ?? [];
    if (ids.length > MAX_CONTEXT_IDS) issues.push(`'context' may contain at most ${MAX_CONTEXT_IDS} IDs.`);
    for (const id of ids) {
      if (typeof id !== "string" || !CONTEXT_ID.test(id)) issues.push(`Invalid shared context ID: ${JSON.stringify(id)}.`);
      else if (!contextExists(id)) issues.push(`Shared context '${id}' was not found in ${contextDir}.`);
    }
  }

  return { file, valid: issues.length === 0, issues };
}

if (!existsSync(agentsDir) || !statSync(agentsDir).isDirectory()) {
  console.error(`Agent directory not found: ${agentsDir}`);
  process.exit(1);
}

const reports = readdirSync(agentsDir)
  .filter((file) => file.endsWith(".md"))
  .sort()
  .map(validateAgent);
const valid = reports.length > 0 && reports.every((report) => report.valid);
const result = { valid, agentsDir, contextDir, reports };

if (jsonOutput) {
  console.log(JSON.stringify(result, null, 2));
} else {
  for (const report of reports) {
    console.log(`${report.valid ? "PASS" : "FAIL"} ${report.file}`);
    for (const issue of report.issues) console.log(`  - ${issue}`);
  }
  console.log(`${reports.filter((report) => report.valid).length}/${reports.length} agents valid`);
}

process.exit(valid ? 0 : 1);