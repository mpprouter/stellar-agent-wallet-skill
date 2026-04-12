// Shared helpers for build-skill.mjs and build-plugin.mjs.
// Dependency-free: uses only node:fs, node:path, node:url.
//
// Adapted from rozo-intents-skills/plugin/build-lib.mjs. The shape is
// identical so the build-* scripts look familiar, but this version
// adds an `rmTree` helper and keeps the .ts source files in place
// (we do not ship a compiled dist directory).

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  cpSync,
  existsSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Repo root is one level up from plugin/
export const REPO_ROOT = resolve(__dirname, "..");
export const BUILD_ROOT = join(REPO_ROOT, "build");

export function loadVersionInfo() {
  const raw = readFileSync(join(REPO_ROOT, "version.json"), "utf8");
  return JSON.parse(raw);
}

export function cleanDir(dir) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
}

/** Copy a tree (file or dir) into dest, skipping common junk and dev-only files. */
export function copyTree(src, dest) {
  cpSync(src, dest, {
    recursive: true,
    filter: (srcPath) => {
      const base = srcPath.split("/").pop();
      if (base === ".DS_Store") return false;
      if (base === "node_modules") return false;
      if (base && base.endsWith(".d.ts")) return false;
      // Dev-only files: smoke tests, probe scripts. These require real
      // network access to Friendbot + Soroban testnet and have no business
      // shipping inside a user-installed plugin.
      if (base && base.startsWith("smoke-test-")) return false;
      if (base && base.startsWith("probe-")) return false;
      return true;
    },
  });
}

/** Read a template file and substitute __KEY__ placeholders. */
export function renderTemplate(templatePath, substitutions) {
  let content = readFileSync(templatePath, "utf8");
  for (const [key, value] of Object.entries(substitutions)) {
    const token = `__${key}__`;
    content = content.split(token).join(value);
  }
  return content;
}

/** Write a rendered template to a destination file, creating parent dirs. */
export function writeRendered(destPath, content) {
  mkdirSync(dirname(destPath), { recursive: true });
  writeFileSync(destPath, content);
}

/** Replace __VERSION__ in an existing file in place. */
export function stampVersionInFile(filePath, version) {
  if (!existsSync(filePath)) return;
  const original = readFileSync(filePath, "utf8");
  const stamped = original.split("__VERSION__").join(version);
  writeFileSync(filePath, stamped);
}

/** Standard substitutions derived from version.json. */
export function substitutionsFrom(versionInfo) {
  return {
    NAME: versionInfo.name,
    VERSION: versionInfo.version,
    DESCRIPTION: versionInfo.description,
    AUTHOR: versionInfo.author,
    HOMEPAGE: versionInfo.homepage,
    LICENSE: versionInfo.license,
    KEYWORDS: JSON.stringify(versionInfo.keywords),
    REPOSITORY: versionInfo.repository ?? "",
    PLUGIN_SUBDIR: versionInfo.pluginSubdir ?? "",
    MARKETPLACE_NAME: versionInfo.marketplaceName ?? versionInfo.name,
  };
}

export function log(label, msg) {
  console.log(`[${label}] ${msg}`);
}

/** Run npm install --production in a build output directory.
 *  Generates package-lock.json for deterministic installs and populates
 *  node_modules so the artifact is ready to run immediately. */
export function installDeps(dir, label = "build") {
  log(label, `Installing production dependencies in ${dir}`);
  execSync("npm install --omit=dev", {
    cwd: dir,
    stdio: "inherit",
  });
}
