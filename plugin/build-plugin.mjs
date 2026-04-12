#!/usr/bin/env node
// Build a Claude Code Plugin package from the repo.
//
// Produces TWO artifacts:
//
// A. The plugin itself at build/plugin/stellar-agent-wallet/
//      .claude-plugin/
//        plugin.json              (rendered from plugin.json.tmpl)
//      package.json               (rendered — declares openclaw.extensions)
//      openclaw.plugin.json       (rendered — OpenClaw plugin manifest)
//      index.js                   (rendered — no-op PluginEntry stub)
//      skills/
//        stellar-agent-wallet/    ← router SKILL.md
//          SKILL.md
//        check-balance/           ← sub-skills (SKILL.md + run.ts + helpers)
//        discover/
//        pay-per-call/
//        send-payment/
//        bridge/
//      scripts/                   (generate-keypair + src/ library)
//      references/                (on-demand docs)
//
// B. The repo-root marketplace manifest at .claude-plugin/marketplace.json
//    (NOTE: this lives at the REPO ROOT, not inside build/.) It turns the
//    git repo into an installable Claude Code plugin marketplace via the
//    git-subdir source type, pointing at the plugin artifact above.
//
// After building, commit both the marketplace.json and build/plugin/* and
// push to GitHub. Users install with:
//
//   /plugin marketplace add mpprouter/stellar-agent-wallet-skill
//   /plugin install stellar-agent-wallet@mpprouter
//
// Usage: node plugin/build-plugin.mjs

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
  installDeps,
  log,
} from "./build-lib.mjs";

const versionInfo = loadVersionInfo();
const outDir = join(BUILD_ROOT, "plugin", versionInfo.name);
const substitutions = substitutionsFrom(versionInfo);

log("plugin", `Building ${versionInfo.name}@${versionInfo.version}`);
log("plugin", `Output: ${outDir}`);

// 1. Clean + create plugin output dir
cleanDir(outDir);

// 2. Render .claude-plugin/plugin.json
writeRendered(
  join(outDir, ".claude-plugin", "plugin.json"),
  renderTemplate(
    join(REPO_ROOT, "plugin", "plugin.json.tmpl"),
    substitutions,
  ),
);

// 2b. Render the plugin-root package.json.
//     Required so loading the plugin's .ts/.js files respects ES module
//     semantics, and because clawhub's publish form requires a
//     package.json at the plugin root.
writeRendered(
  join(outDir, "package.json"),
  renderTemplate(
    join(REPO_ROOT, "plugin", "package.json.tmpl"),
    substitutions,
  ),
);

// 2c. Render openclaw.plugin.json at the plugin root.
//     Required by clawhub / openclaw publishing — it's openclaw's native
//     plugin manifest (distinct from .claude-plugin/plugin.json). Only
//     `id` and `configSchema` are strictly required; we also include
//     name/description/version for display.
writeRendered(
  join(outDir, "openclaw.plugin.json"),
  renderTemplate(
    join(REPO_ROOT, "plugin", "openclaw.plugin.json.tmpl"),
    substitutions,
  ),
);

// 2d. Render the plugin entry stub at the plugin root.
//     Declared by openclaw.extensions in package.json. OpenClaw loads
//     this file at plugin discovery time. For our skill-only plugin
//     this is a no-op module with a PluginEntry-shaped default export.
writeRendered(
  join(outDir, "index.js"),
  renderTemplate(
    join(REPO_ROOT, "plugin", "index.js.tmpl"),
    substitutions,
  ),
);

// 3. Copy sub-skills (everything under skills/) to plugin skills/
copyTree(join(REPO_ROOT, "skills"), join(outDir, "skills"));

// 3b. Copy the router SKILL.md into skills/<plugin-name>/SKILL.md
//     Plugin convention: skills/<name>/SKILL.md is the router.
copyTree(
  join(REPO_ROOT, "SKILL.md"),
  join(outDir, "skills", versionInfo.name, "SKILL.md"),
);

// 4. Copy scripts (generate-keypair.ts + src/ library)
copyTree(join(REPO_ROOT, "scripts"), join(outDir, "scripts"));

// 5. Copy references
copyTree(join(REPO_ROOT, "references"), join(outDir, "references"));

// 6. Stamp __VERSION__ in the router SKILL.md inside the plugin
stampVersionInFile(
  join(outDir, "skills", versionInfo.name, "SKILL.md"),
  versionInfo.version,
);

// 7. Render the REPO-ROOT marketplace manifest.
//    This is what turns the git repo itself into an installable marketplace.
//    Lives at <repo>/.claude-plugin/marketplace.json — NOT inside build/.
const rootMarketplacePath = join(
  REPO_ROOT,
  ".claude-plugin",
  "marketplace.json",
);
writeRendered(
  rootMarketplacePath,
  renderTemplate(
    join(REPO_ROOT, "plugin", "marketplace.json.tmpl"),
    substitutions,
  ),
);
log("plugin", `Wrote repo-root marketplace manifest: ${rootMarketplacePath}`);

// 8. Install production dependencies so the plugin ships with node_modules.
//    Without this, agents must run `npm install` after plugin installation,
//    which fails when only pnpm-lock.yaml exists (npm ignores it).
installDeps(outDir, "plugin");

log("plugin", "Done.");
