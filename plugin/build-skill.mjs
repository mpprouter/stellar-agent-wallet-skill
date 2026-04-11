#!/usr/bin/env node
// Build a Claude Skill package from the repo.
//
// Output: build/skill/stellar-agent-wallet/
//   SKILL.md          router, version stamped
//   skills/           sub-skills (each: SKILL.md + run.ts + optional helpers)
//   scripts/          generate-keypair.ts + src/ library
//   references/       on-demand context docs
//   package.json      declares "type": "module" so the .ts files behave
//                     correctly when loaded via tsx
//
// Usage: node plugin/build-skill.mjs

import { join } from "node:path";
import {
  REPO_ROOT,
  BUILD_ROOT,
  loadVersionInfo,
  cleanDir,
  copyTree,
  renderTemplate,
  writeRendered,
  stampVersionInFile,
  substitutionsFrom,
  log,
} from "./build-lib.mjs";

const versionInfo = loadVersionInfo();
const outDir = join(BUILD_ROOT, "skill", versionInfo.name);
const substitutions = substitutionsFrom(versionInfo);

log("skill", `Building ${versionInfo.name}@${versionInfo.version}`);
log("skill", `Output: ${outDir}`);

// 1. Clean + create output dir
cleanDir(outDir);

// 2. Copy router SKILL.md to the top of the skill package
copyTree(join(REPO_ROOT, "SKILL.md"), join(outDir, "SKILL.md"));

// 3. Copy all sub-skill folders (each contains SKILL.md + run.ts + helpers)
copyTree(join(REPO_ROOT, "skills"), join(outDir, "skills"));

// 4. Copy scripts (generate-keypair.ts + src/ library)
copyTree(join(REPO_ROOT, "scripts"), join(outDir, "scripts"));

// 5. Copy references
copyTree(join(REPO_ROOT, "references"), join(outDir, "references"));

// 6. Render package.json at the skill root so that .ts imports resolving
//    to .js via tsx behave as ES modules.
writeRendered(
  join(outDir, "package.json"),
  renderTemplate(
    join(REPO_ROOT, "plugin", "package.json.tmpl"),
    substitutions,
  ),
);

// 7. Stamp version in the router SKILL.md (if it contains __VERSION__;
//    currently it reads version from frontmatter so this is a no-op,
//    but we keep the hook for future use).
stampVersionInFile(join(outDir, "SKILL.md"), versionInfo.version);

log("skill", "Done.");
