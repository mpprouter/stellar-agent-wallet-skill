// Smoke test for the pay-link policy layer, confirmation digest and ledger.
// Every refusal code in RefusalCode must have a test here — the last block
// asserts that, so adding a refusal without a test fails the suite.
// Excluded from builds via the smoke-test-* prefix filter.

import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { loadFixture, normaliseFor } from "./src/pay-link/inspectors.js";
import { evaluate, DEFAULT_POLICY, type PolicyConfig, type RefusalCode } from "./src/pay-link/policy.js";
import { checkConfirmation, computeDigest, digestInputFrom } from "./src/pay-link/digest.js";
import { findEntry, loadLedger, record, saveLedger, spendWindows } from "./src/pay-link/ledger.js";
import type { UnifiedInspection } from "./src/pay-link/types.js";

const FIX = join(dirname(fileURLToPath(import.meta.url)), "smoke-test-fixtures", "pay-link");
const covered = new Set<RefusalCode>();

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) { console.error("FAIL:", msg); failures++; }
  else console.log("  ok:", msg);
}

function base(file: string, provider: any = "rozo-intent"): UnifiedInspection {
  return normaliseFor(provider, loadFixture(join(FIX, file)), "https://invoice.rozo.ai/checkout?id=pay_abc123", "pay_abc123");
}

function cfg(over: Partial<PolicyConfig> = {}): PolicyConfig {
  return {
    ...DEFAULT_POLICY,
    spentTodayUsd: 0,
    spentThisMonthUsd: 0,
    merchantWhitelist: [],
    ...over,
  };
}

/** Assert a refusal code fires, and mark it covered. */
function refusesWith(ins: UnifiedInspection, c: PolicyConfig, code: RefusalCode, msg: string) {
  const d = evaluate(ins, c);
  const hit = d.action === "refuse" && d.refusals.some((r) => r.code === code);
  assert(hit, msg);
  if (hit) covered.add(code);
  else if (d.action === "refuse") console.error("    got:", d.refusals.map((r) => r.code).join(","));
}

console.log("Happy path");
const ok = base("rozo-unpaid.json");
const okDecision = evaluate(ok, cfg());
assert(okDecision.action === "auto", "verified merchant, $5.00, fresh, valid address → auto (at the $5 ceiling)");

console.log("Refusal — upstream state");
refusesWith(base("rozo-completed.json"), cfg(), "not_payable", "already-paid link refused (no double pay)");

console.log("Refusal — freshness");
refusesWith({ ...ok, expires_at: "2020-01-01T00:00:00Z", quote_expires_at: "2020-01-01T00:00:00Z" }, cfg(), "expired", "expired quote refused; one-time address never reused");
refusesWith({ ...ok, inspected_at: new Date(Date.now() - 3600_000).toISOString() }, cfg(), "stale_inspection", "hour-old inspection refused");
refusesWith({ ...ok, inspected_at: "not-a-date" }, cfg(), "stale_inspection", "undateable inspection refused (fail closed)");

console.log("Refusal — rails and addresses");
refusesWith({ ...ok, rails: [] }, cfg(), "no_rail", "no settlement rail refused");
refusesWith({ ...ok, rails: [{ chain: "1500", token: "USDC" }] }, cfg(), "missing_deposit_address", "rail without a deposit address refused");
refusesWith(ok, cfg({ acceptChains: ["base"] }), "rail_not_accepted", "chain outside the accepted set refused");
refusesWith({ ...ok, rails: [{ chain: "1500", token: "USDC", deposit_address: "GDK3AV" }] }, cfg(), "malformed_address", "truncated Stellar address refused");
refusesWith({ ...ok, rails: [{ chain: "base", token: "USDC", deposit_address: "0x5772FBe7a7817ef7F586215CA8b23b8dD22C8897" }] }, cfg(), "blacklisted_address", "compromised address refused (checked before any signing)");
refusesWith(ok, cfg({ expectPayTo: "GDK3AVW3YE6UL3J4WLNKBMP65KSY32YPUKIOC6PXW65XJ3LEG3YIDXXA" }), "payee_mismatch", "deposit address != expected payee refused");

console.log("Refusal — amount and currency");
refusesWith({ ...ok, amount: null }, cfg(), "amount_unknown", "unreadable amount refused");
refusesWith(ok, cfg({ expectAmount: "4.99" }), "amount_mismatch", "amount != --expect-amount refused");
refusesWith(ok, cfg({ expectCurrency: "EUR" }), "currency_mismatch", "currency != --expect-currency refused");
refusesWith(ok, cfg({ maxPerCallUsd: 1 }), "per_call_limit", "over per-payment ceiling refused");
refusesWith(ok, cfg({ spentTodayUsd: 48 }), "daily_limit", "over rolling daily ceiling refused");
refusesWith(ok, cfg({ spentThisMonthUsd: 198 }), "monthly_limit", "over rolling monthly ceiling refused");

console.log("Refusal — merchant allow-list");
refusesWith(ok, cfg({ merchantWhitelist: ["SomeoneElse"] }), "merchant_not_allowed", "merchant off the allow-list refused");
assert(evaluate(ok, cfg({ merchantWhitelist: ["MuggleLink"] })).action === "auto", "allow-listed merchant passes (case-insensitive)");

console.log("Confirmation gate");
const big = { ...ok, amount: "20.00" } as UnifiedInspection;
const bigDecision = evaluate(big, cfg());
assert(bigDecision.action === "confirm", "$20 > $5 auto ceiling → confirmation required, not refusal");
const unverified = { ...ok, merchant: { ...ok.merchant, verified: false } } as UnifiedInspection;
assert(evaluate(unverified, cfg()).action === "confirm", "unverified merchant off the allow-list → confirmation required");

const dgst = computeDigest(digestInputFrom(big));
assert(checkConfirmation(undefined, big).ok === false, "no --confirm → NOT_CONFIRMED");
assert((checkConfirmation(undefined, big) as any).code === "NOT_CONFIRMED", "NOT_CONFIRMED code");
assert(checkConfirmation(dgst, big).ok === true, "matching digest accepted");
assert((checkConfirmation("deadbeef", big) as any).code === "CONFIRMATION_STALE", "wrong digest, nothing moved → CONFIRMATION_STALE");
const prev = digestInputFrom({ ...big, rails: [{ chain: "1500", token: "USDC", deposit_address: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }] } as UnifiedInspection);
assert((checkConfirmation("deadbeef", big, 0, prev) as any).code === "DEPOSIT_CHANGED", "deposit target moved since confirmation → DEPOSIT_CHANGED");
assert(computeDigest(digestInputFrom(big)) !== computeDigest(digestInputFrom({ ...big, amount: "20.01" } as UnifiedInspection)), "digest changes when the amount changes");

console.log("Ledger — idempotency and rolling windows");
const dir = mkdtempSync(join(tmpdir(), "paylink-"));
const path = join(dir, "ledger.json");
let f = loadLedger(path);
assert(f.entries.length === 0, "absent ledger starts empty");
f = record(f, { url: ok.url, digest: dgst, amount: 5, currency: "USD", status: "submitted", tx_hash: "abc", at: new Date().toISOString() });
saveLedger(f, path);
const reloaded = loadLedger(path);
assert(findEntry(reloaded, ok.url, dgst)?.tx_hash === "abc", "(url, digest) replay finds the prior receipt");
assert(findEntry(reloaded, ok.url, "otherdigest") === null, "different digest is a different payment");
assert(spendWindows(reloaded).today === 5, "submitted entry counts toward the daily window");
const dryOnly = record({ version: 1, entries: [] }, { url: ok.url, digest: dgst, amount: 5, currency: "USD", status: "dryrun", tx_hash: null, at: new Date().toISOString() });
assert(spendWindows(dryOnly).today === 0, "dry runs never consume the spend ceiling");
const old = record({ version: 1, entries: [] }, { url: ok.url, digest: dgst, amount: 5, currency: "USD", status: "submitted", tx_hash: "x", at: new Date(Date.now() - 40 * 24 * 3600_000).toISOString() });
assert(spendWindows(old).month === 0, "spend older than 30 days leaves the monthly window");

console.log("Coverage — every refusal code is exercised");
const ALL: RefusalCode[] = [
  "not_payable", "expired", "stale_inspection", "no_rail", "rail_not_accepted",
  "missing_deposit_address", "malformed_address", "blacklisted_address",
  "amount_unknown", "amount_mismatch", "currency_mismatch", "payee_mismatch",
  "merchant_not_allowed", "per_call_limit", "daily_limit", "monthly_limit",
];
for (const c of ALL) assert(covered.has(c), `refusal path covered: ${c}`);

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log("\nAll pay-link policy checks passed.");
