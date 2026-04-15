#!/usr/bin/env node
// First-run dep installer for the stellar-agent-wallet plugin.
//
// The plugin ships WITHOUT node_modules to keep the artifact small
// (~80 KB vs ~37 MB). This script populates node_modules once on first use.
//
// Idempotent: safe to run repeatedly. Bails fast if deps are already present.
//
// Usage:
//   node prepare.mjs            # auto-install if missing
//   node prepare.mjs --force    # reinstall regardless

import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const force = process.argv.includes("--force");

const sentinel = join(__dirname, "node_modules", "@stellar", "stellar-sdk", "package.json");
if (!force && existsSync(sentinel)) {
  console.log("[prepare] Dependencies already installed. Nothing to do.");
  process.exit(0);
}

console.log("[prepare] Installing production dependencies (one-time, ~30s)…");
const result = spawnSync("npm", ["install", "--omit=dev", "--no-audit", "--no-fund"], {
  cwd: __dirname,
  stdio: "inherit",
});
if (result.status !== 0) {
  console.error("[prepare] npm install failed. Fix the error above and re-run.");
  process.exit(result.status ?? 1);
}
console.log("[prepare] Done. You can now run the skill's scripts normally.");
