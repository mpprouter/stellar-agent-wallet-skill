/**
 * pay-link — inspect, then (optionally) pay, a payment link from one of three
 * known providers.
 *
 * Usage:
 *   ./node_modules/.bin/tsx skills/pay-link/run.ts inspect <url> [--fixture <file>] [--json]
 *   ./node_modules/.bin/tsx skills/pay-link/run.ts pay <url> [--dryrun] [--confirm <digest>]
 *        [--max-auto <usd>] [--expect-amount <n>] [--expect-currency USD]
 *        [--expect-pay-to <addr>] [--merchant-allow <name,name>]
 *        [--chain <name>] [--rail <index>] [--ledger <path>] [--json]
 *
 * Exit codes:
 *   0  inspection succeeded / payment allowed (or dry-run completed)
 *   1  operational failure (bad URL, inspector unavailable, provider error)
 *   2  refused by policy, or confirmation required — nothing was signed
 *
 * SAFETY: this command never signs or submits anything by itself. Execution is
 * delegated to the provider's own already-audited pay script, and only after
 * policy passes. Until those integrations are enabled, `pay` runs in dry-run
 * mode and says so — it will not silently do nothing while reporting success.
 */

import { resolveLink, supportedShapes, UnsupportedLinkError } from "../../scripts/src/pay-link/url.js";
import { inspect, InspectorUnavailableError } from "../../scripts/src/pay-link/inspectors.js";
import {
  evaluate,
  DEFAULT_POLICY,
  MAX_AUTO_CEILING_USD,
  type PolicyConfig,
} from "../../scripts/src/pay-link/policy.js";
import {
  checkConfirmation,
  computeDigest,
  digestInputFrom,
} from "../../scripts/src/pay-link/digest.js";
import {
  DEFAULT_LEDGER_PATH,
  findEntry,
  loadLedger,
  record,
  saveLedger,
  spendWindows,
} from "../../scripts/src/pay-link/ledger.js";
import { maskAddress } from "../../scripts/src/pay-link/blacklist.js";
import type { Receipt, UnifiedInspection } from "../../scripts/src/pay-link/types.js";

interface Args {
  command?: string;
  url?: string;
  json: boolean;
  dryrun: boolean;
  fixture?: string;
  confirm?: string;
  railIndex: number;
  ledger: string;
  maxAutoUsd?: number;
  expectAmount?: string;
  expectCurrency?: string;
  expectPayTo?: string;
  merchantAllow: string[];
  chains: string[];
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    json: false,
    dryrun: false,
    railIndex: 0,
    ledger: DEFAULT_LEDGER_PATH,
    merchantAllow: [],
    chains: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--json") a.json = true;
    else if (k === "--dryrun" || k === "--dry-run") a.dryrun = true;
    else if (k === "--fixture") a.fixture = argv[++i];
    else if (k === "--confirm") a.confirm = argv[++i];
    else if (k === "--rail") a.railIndex = parseInt(argv[++i], 10) || 0;
    else if (k === "--ledger") a.ledger = argv[++i];
    else if (k === "--expect-amount") a.expectAmount = argv[++i];
    else if (k === "--expect-currency") a.expectCurrency = argv[++i];
    else if (k === "--expect-pay-to") a.expectPayTo = argv[++i];
    else if (k === "--merchant-allow") a.merchantAllow = (argv[++i] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    else if (k === "--chain") a.chains.push(argv[++i]);
    else if (k === "--max-auto") {
      const v = parseFloat(argv[++i]);
      if (!Number.isFinite(v) || v < 0) {
        console.error("--max-auto must be a non-negative number");
        process.exit(1);
      }
      if (v > MAX_AUTO_CEILING_USD) {
        console.error(
          `--max-auto $${v.toFixed(2)} exceeds the hard cap of $${MAX_AUTO_CEILING_USD.toFixed(2)}. ` +
            "A wide unattended ceiling lets one bad link drain the wallet without a prompt.",
        );
        process.exit(1);
      }
      a.maxAutoUsd = v;
    } else if (!k.startsWith("-")) {
      if (!a.command) a.command = k;
      else if (!a.url) a.url = k;
    }
  }
  return a;
}

function usage(): void {
  console.error("pay-link — inspect and pay known payment links.\n");
  console.error("  inspect <url> [--fixture <file>] [--json]");
  console.error("  pay <url> [--dryrun] [--confirm <digest>] [--max-auto <usd>] ...\n");
  console.error("Supported link shapes (nothing else is fetched):");
  for (const s of supportedShapes()) console.error(`  - ${s}`);
}

function printHuman(ins: UnifiedInspection): void {
  console.log(`Provider:   ${ins.provider}`);
  console.log(`Reference:  ${ins.reference}`);
  console.log(`Merchant:   ${ins.merchant.display_name ?? "(unknown)"}${ins.merchant.verified ? " [verified]" : " [UNVERIFIED]"}`);
  console.log(`Amount:     ${ins.amount ?? "(unknown)"} ${ins.currency ?? ""}`);
  console.log(`Status:     ${ins.fulfillment_status}`);
  console.log(`Expires:    link ${ins.expires_at ?? "(none)"} | quote ${ins.quote_expires_at ?? "(none)"}`);
  console.log("Rails:");
  if (ins.rails.length === 0) console.log("  (none offered)");
  for (const [i, r] of ins.rails.entries()) {
    const addr = r.deposit_address ? maskAddress(r.deposit_address) : "(no address yet)";
    console.log(`  [${i}] ${r.chain}/${r.token} → ${addr}${r.deposit_memo ? ` memo ${r.deposit_memo}` : ""}`);
  }
  if (ins.fees.total) console.log(`Fees:       total ${ins.fees.total} (platform ${ins.fees.platform ?? "?"} / rail ${ins.fees.rail ?? "?"} / bridge ${ins.fees.bridge ?? "?"} / network ${ins.fees.network ?? "?"})`);
  if (ins.risks.length) {
    console.log("Risks:");
    for (const r of ins.risks) console.log(`  [${r.severity}] ${r.code}: ${r.message}`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.command || !args.url || !["inspect", "pay"].includes(args.command)) {
    usage();
    process.exit(1);
  }

  let link;
  try {
    link = resolveLink(args.url);
  } catch (e) {
    if (e instanceof UnsupportedLinkError) {
      const out = { ok: false, code: e.code, message: e.reason };
      console.error(args.json ? JSON.stringify(out, null, 2) : `REFUSED: ${e.reason}`);
      process.exit(2);
    }
    throw e;
  }

  let ins: UnifiedInspection;
  try {
    ins = await inspect(link.provider, link.url, link.reference, { fixture: args.fixture });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const code = e instanceof InspectorUnavailableError ? e.code : "inspect_failed";
    console.error(args.json ? JSON.stringify({ ok: false, code, message: msg }, null, 2) : `ERROR: ${msg}`);
    process.exit(1);
  }

  if (args.command === "inspect") {
    if (args.json) console.log(JSON.stringify(ins, null, 2));
    else printHuman(ins);
    process.exit(0);
  }

  /* ---- pay -------------------------------------------------------- */
  const ledgerFile = loadLedger(args.ledger);
  const windows = spendWindows(ledgerFile);
  const cfg: PolicyConfig = {
    ...DEFAULT_POLICY,
    maxAutoUsd: args.maxAutoUsd ?? DEFAULT_POLICY.maxAutoUsd,
    spentTodayUsd: windows.today,
    spentThisMonthUsd: windows.month,
    merchantWhitelist: args.merchantAllow,
    expectAmount: args.expectAmount,
    expectCurrency: args.expectCurrency,
    expectPayTo: args.expectPayTo,
    acceptChains: args.chains,
  };

  const decision = evaluate(ins, cfg, args.railIndex);
  const digest = computeDigest(digestInputFrom(ins, args.railIndex));

  if (decision.action === "refuse") {
    const out = { ok: false, action: "refused", provider: ins.provider, reference: ins.reference, refusals: decision.refusals };
    if (args.json) console.log(JSON.stringify(out, null, 2));
    else {
      printHuman(ins);
      console.error("\nREFUSED — nothing was signed:");
      for (const r of decision.refusals) console.error(`  - ${r.code}: ${r.message}`);
    }
    process.exit(2);
  }

  // Idempotency: this exact (url, digest) already executed.
  const prior = findEntry(ledgerFile, ins.url, digest);
  if (prior && (prior.status === "submitted" || prior.status === "confirmed")) {
    const receipt: Receipt = {
      provider: ins.provider,
      reference: ins.reference,
      tx_hash: prior.tx_hash,
      amount: String(prior.amount),
      currency: prior.currency,
      status: prior.status,
      digest,
      at: prior.at,
    };
    console.log(JSON.stringify({ ok: true, replayed: true, receipt }, null, 2));
    process.exit(0);
  }

  if (decision.action === "confirm") {
    const check = checkConfirmation(args.confirm, ins, args.railIndex);
    if (!check.ok) {
      const out = {
        ok: false,
        action: "confirmation_required",
        code: check.code,
        message: check.message,
        expected_digest: check.expected,
        reasons: decision.reasons,
      };
      if (args.json) console.log(JSON.stringify(out, null, 2));
      else {
        printHuman(ins);
        console.error(`\n${check.code}: ${check.message}`);
        for (const r of decision.reasons) console.error(`  - ${r}`);
      }
      process.exit(2);
    }
  }

  // Everything passed. Execution is intentionally dry-run only in this
  // release: the real leg calls the provider's own pay script, which is a
  // separate, separately-approved integration. We say so rather than
  // reporting a success that moved nothing.
  const receipt: Receipt = {
    provider: ins.provider,
    reference: ins.reference,
    tx_hash: null,
    amount: ins.amount,
    currency: ins.currency,
    status: "dryrun",
    digest,
    at: new Date().toISOString(),
  };
  saveLedger(record(ledgerFile, {
    url: ins.url,
    digest,
    amount: decision.amountUsd,
    currency: ins.currency,
    status: "dryrun",
    tx_hash: null,
    at: receipt.at,
  }), args.ledger);

  console.log(JSON.stringify({
    ok: true,
    action: decision.action,
    dryrun: true,
    note: "Policy passed. No funds were moved: execution is delegated to the provider's own pay script and is not enabled in this release.",
    receipt,
  }, null, 2));
  process.exit(0);
}

main().catch((e) => {
  console.error(`ERROR: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
