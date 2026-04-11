/**
 * discover — query the MPP Router service catalog.
 *
 * Usage:
 *   npx tsx commands/discover/run.ts
 *   npx tsx commands/discover/run.ts --category search
 *   npx tsx commands/discover/run.ts --query "web search"
 *   npx tsx commands/discover/run.ts --query "scrape" --pick-one
 *   npx tsx commands/discover/run.ts --json
 */

import "dotenv/config";

interface ServiceRecord {
  id: string;
  name: string;
  category: string;
  description: string;
  public_path: string;
  method: string;
  price: string;
  payment_method: string;
  network: string;
  asset: string;
  status: string;
  docs_url?: string;
  methods?: Record<string, { intents: string[]; role?: string }>;
  verified_mode?: string;
}

interface Catalog {
  version: string;
  base_url: string;
  generated_at: string;
  services: ServiceRecord[];
}

function parseArgs() {
  const args = process.argv.slice(2);
  const result: {
    category?: string;
    query?: string;
    pickOne: boolean;
    json: boolean;
  } = { pickOne: false, json: false };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--category") result.category = args[++i];
    else if (a === "--query") result.query = args[++i];
    else if (a === "--pick-one") result.pickOne = true;
    else if (a === "--json") result.json = true;
  }
  return result;
}

function score(service: ServiceRecord, query: string): number {
  const q = query.toLowerCase();
  let s = 0;
  if (service.id.toLowerCase().includes(q)) s += 5;
  if (service.name.toLowerCase().includes(q)) s += 3;
  if (service.category.toLowerCase().includes(q)) s += 3;
  if (service.description.toLowerCase().includes(q)) s += 1;
  // Token overlap
  const tokens = q.split(/\s+/).filter(Boolean);
  const haystack = `${service.id} ${service.name} ${service.category} ${service.description}`.toLowerCase();
  for (const t of tokens) {
    if (haystack.includes(t)) s += 1;
  }
  return s;
}

async function main() {
  const opts = parseArgs();
  const baseUrl = process.env.MPP_ROUTER_URL ?? "https://apiserver.mpprouter.dev";

  const res = await fetch(`${baseUrl}/v1/services/catalog`);
  if (!res.ok) {
    console.error(`Catalog fetch failed: ${res.status} ${res.statusText}`);
    process.exit(1);
  }
  const catalog: Catalog = await res.json();

  let services = catalog.services.filter((s) => s.status === "active");

  if (opts.category) {
    services = services.filter(
      (s) => s.category.toLowerCase() === opts.category!.toLowerCase(),
    );
  }

  if (opts.query) {
    services = services
      .map((s) => ({ s, score: score(s, opts.query!) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((x) => x.s);
  }

  if (opts.pickOne) {
    services = services.slice(0, 1);
  }

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
