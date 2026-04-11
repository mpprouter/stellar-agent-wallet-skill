/**
 * discover — query the MPP Router service catalog.
 *
 * Usage:
 *   npx tsx skills/discover/run.ts
 *   npx tsx skills/discover/run.ts --category search
 *   npx tsx skills/discover/run.ts --query "web search"
 *   npx tsx skills/discover/run.ts --query "scrape" --pick-one
 *   npx tsx skills/discover/run.ts --json
 *
 * Takes no authentication. All config is hardcoded in the library.
 */

import {
  fetchCatalog,
  scoreService,
  type ServiceRecord,
} from "../../scripts/src/mpprouter-client.js";

interface CliOpts {
  category?: string;
  query?: string;
  pickOne: boolean;
  json: boolean;
}

function parseArgs(): CliOpts {
  const args = process.argv.slice(2);
  const result: CliOpts = { pickOne: false, json: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--category") result.category = args[++i];
    else if (a === "--query") result.query = args[++i];
    else if (a === "--pick-one") result.pickOne = true;
    else if (a === "--json") result.json = true;
  }
  return result;
}

function applyFilters(
  services: ServiceRecord[],
  opts: CliOpts,
): ServiceRecord[] {
  let out = services.filter((s) => s.status === "active");
  if (opts.category) {
    out = out.filter(
      (s) => s.category.toLowerCase() === opts.category!.toLowerCase(),
    );
  }
  if (opts.query) {
    out = out
      .map((s) => ({ s, score: scoreService(s, opts.query!) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((x) => x.s);
  }
  if (opts.pickOne) {
    out = out.slice(0, 1);
  }
  return out;
}

async function main() {
  const opts = parseArgs();
  const catalog = await fetchCatalog();
  const services = applyFilters(catalog.services, opts);

  if (opts.json) {
    if (opts.pickOne && services.length === 1) {
      console.log(JSON.stringify(services[0], null, 2));
    } else {
      console.log(
        JSON.stringify(
          { base_url: catalog.base_url, services, version: catalog.version },
          null,
          2,
        ),
      );
    }
    return;
  }

  console.log(`MPP Router catalog v${catalog.version}`);
  console.log(`Base URL: ${catalog.base_url}`);
  console.log(`Services: ${services.length}`);
  console.log("");
  for (const s of services) {
    console.log(`  ${s.id}  [${s.category}]`);
    console.log(`    ${s.name} — ${s.price}`);
    console.log(`    ${s.method} ${catalog.base_url}${s.public_path}`);
    console.log(`    ${s.description.slice(0, 100)}`);
    console.log("");
  }
  if (services.length === 0) {
    console.log("  (no matches — try without --query or --category)");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
