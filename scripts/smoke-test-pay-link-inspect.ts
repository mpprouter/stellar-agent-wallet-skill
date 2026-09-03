// Smoke test for the pay-link URL whitelist and the three inspector
// normalisers. Fixture-driven: no network, no wallet, no signing.
// Excluded from builds via the smoke-test-* prefix filter in plugin/build-lib.mjs.

import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveLink, UnsupportedLinkError } from "./src/pay-link/url.js";
import { loadFixture, normaliseFor } from "./src/pay-link/inspectors.js";
import type { UnifiedInspection } from "./src/pay-link/types.js";

const FIX = join(dirname(fileURLToPath(import.meta.url)), "smoke-test-fixtures", "pay-link");

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) { console.error("FAIL:", msg); failures++; }
  else console.log("  ok:", msg);
}

function refuses(url: string, why: string) {
  try {
    resolveLink(url);
    console.error("FAIL:", `${why} — should have been refused`);
    failures++;
  } catch (e) {
    assert(e instanceof UnsupportedLinkError, why);
  }
}

console.log("URL whitelist — accepted shapes");
assert(resolveLink("https://payments.coinbase.com/payment-links/pl_abc123").provider === "coinbase", "coinbase legacy payment-link");
assert(resolveLink("https://payments.coinbase.com/payment-sessions/paymentSession_xyz").provider === "coinbase", "coinbase v3 payment-session");
assert(resolveLink("https://crypto.stripe.com/pay/cs_test_abc").provider === "stripe-crypto", "stripe crypto payin");
const rozo = resolveLink("https://invoice.rozo.ai/checkout?id=pay_abc123");
assert(rozo.provider === "rozo-intent" && rozo.reference === "pay_abc123", "rozo intent checkout + id extracted");
assert(resolveLink("https://pay.mugglepay.com/checkout?id=pay_abc123").provider === "rozo-intent", "mugglepay brand prefix is the same Rozo intent");

console.log("URL whitelist — refusals (no generic fetcher)");
refuses("https://evil.example.com/pay/123", "arbitrary host refused");
refuses("http://payments.coinbase.com/payment-links/pl_abc", "plain http refused");
refuses("https://payments.coinbase.com/other/pl_abc", "right host, wrong path refused");
refuses("https://invoice.rozo.ai/checkout", "rozo checkout without ?id refused");
refuses("https://user:pw@crypto.stripe.com/pay/cs_abc", "embedded credentials refused");
refuses("not-a-url", "non-URL refused");
refuses("https://payments.coinbase.com.evil.tld/payment-links/pl_abc", "lookalike suffix host refused");
refuses("https://payments.coinbase.com:444/payment-links/pl_abc", "non-default port on a whitelisted host refused");

console.log("Unified shape — every provider produces the same keys");
const KEYS = [
  "provider", "url", "reference", "merchant", "amount", "currency", "rails",
  "expires_at", "quote_expires_at", "fulfillment_status", "fees", "risks",
  "inspected_at", "raw",
];
function load(provider: any, file: string, url: string, ref: string): UnifiedInspection {
  return normaliseFor(provider, loadFixture(join(FIX, file)), url, ref);
}
const cb = load("coinbase", "coinbase-payable.json", "https://payments.coinbase.com/payment-links/pl_abc", "pl_abc");
const st = load("stripe-crypto", "stripe-payable.json", "https://crypto.stripe.com/pay/cs_abc", "cs_abc");
const rz = load("rozo-intent", "rozo-unpaid.json", "https://invoice.rozo.ai/checkout?id=pay_abc123", "pay_abc123");

for (const [name, ins] of [["coinbase", cb], ["stripe", st], ["rozo", rz]] as const) {
  const keys = Object.keys(ins).sort();
  assert(KEYS.slice().sort().join(",") === keys.join(","), `${name} has exactly the unified key set`);
  assert(
    ["platform", "rail", "bridge", "network", "total"].every((k) => k in (ins.fees as any)),
    `${name} carries the five-line fee breakdown`,
  );
}

console.log("Status mapping");
assert(cb.fulfillment_status === "payable", "coinbase CREATED + payable → payable");
assert(load("coinbase", "coinbase-used.json", "u", "u").fulfillment_status === "used", "coinbase used link → used");
assert(load("coinbase", "coinbase-captured.json", "u", "u").fulfillment_status === "paid", "coinbase CAPTURE_SUCCEEDED → paid (only capture counts)");
assert(st.fulfillment_status === "payable", "stripe requires_payment + payable → payable");
assert(load("stripe-crypto", "stripe-expired.json", "u", "u").fulfillment_status === "expired", "stripe expired → expired");
assert(rz.fulfillment_status === "payable", "rozo payment_unpaid → payable");
assert(load("rozo-intent", "rozo-completed.json", "u", "u").fulfillment_status === "paid", "rozo payment_completed → paid");

console.log("Field mapping");
assert(cb.amount === "20.00" && cb.currency === "USD", "coinbase fiat amount + currency");
assert(cb.merchant.verified === false, "coinbase asserts no merchant verification → verified false");
assert(st.merchant.verified === true, "stripe merchantVerified honoured");
assert(rz.amount === "5.00" && rz.currency === "USD", "rozo destination amount + display currency");
assert(rz.rails[0].deposit_address?.startsWith("GDK3AV") === true && rz.rails[0].deposit_memo === "9931", "rozo deposit address + memo land on the rail");
assert(rz.fees.total === "0.01" && rz.fees.platform === null, "rozo blended fee goes to total; unknown components stay null, not 0");

console.log("Risk surfacing");
assert(cb.risks.some((r) => r.code === "unverified_merchant"), "unverified merchant is flagged");
const bl = load("stripe-crypto", "stripe-blacklisted.json", "u", "u");
assert(bl.risks.some((r) => r.code === "blacklisted_address" && r.severity === "high"), "blacklisted deposit address flagged at inspect time");
assert(!JSON.stringify(bl.risks).includes("0x5772FBe7a7817ef7F586215CA8b23b8dD22C8897"), "blacklist risk message masks the address");

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log("\nAll pay-link inspect checks passed.");
