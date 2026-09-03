/**
 * Provider inspectors — read-only.
 *
 * Each provider already has a battle-tested read-only inspector script that
 * emits a single JSON object on stdout. We do NOT reimplement their parsing:
 * we shell out (or, in tests, read a recorded fixture) and normalise.
 *
 *   coinbase       → pay-coinbase        scripts/dist/get-payment-link.js  --url
 *   stripe-crypto  → pay-stripe-crypto   scripts/dist/get-stripe-session.js --url
 *   rozo-intent    → rozo-intents-api    GET /payments/{id}   (plain HTTPS GET)
 *
 * The normalise* functions below are pure: raw provider JSON in,
 * `UnifiedInspection` out. Every test drives those directly with fixtures, so
 * the shape contract is covered without a network call or an installed
 * sibling skill.
 *
 * Anything the provider does not tell us stays `null`. We never invent a
 * value — in particular a missing fee is `null`, not `0`, and an unrecognised
 * status is `unknown`, which policy treats as unpayable.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync } from "node:fs";
import type {
  FulfillmentStatus,
  Provider,
  Rail,
  Risk,
  UnifiedInspection,
} from "./types.js";
import { lookupBlacklist, maskAddress } from "./blacklist.js";

const execFileAsync = promisify(execFile);

/** Rozo payment-api base. Same host the rozo-client library already uses. */
const ROZO_API_BASE = "https://intentapiv4.rozo.ai/functions/v1/payment-api";

/** Env vars naming where the sibling inspector scripts live on this machine. */
export const COINBASE_INSPECTOR_ENV = "PAY_COINBASE_INSPECTOR";
export const STRIPE_INSPECTOR_ENV = "PAY_STRIPE_INSPECTOR";

function nowIso(): string {
  return new Date().toISOString();
}

function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") return v.length ? v : null;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

function isoOrNull(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/**
 * Risks every provider shares. Advisory only — refusals are policy.ts's job,
 * so that "what we warn about" and "what we refuse" can never drift apart in
 * one direction silently.
 */
function commonRisks(u: Omit<UnifiedInspection, "risks">): Risk[] {
  const risks: Risk[] = [];

  if (!u.merchant.verified) {
    risks.push({
      code: "unverified_merchant",
      message:
        `${u.provider} does not assert this merchant is verified` +
        (u.merchant.display_name ? ` (“${u.merchant.display_name}”)` : "") +
        ". Treat the displayed name as a claim, not a fact.",
      severity: "warn",
    });
  }

  if (u.fulfillment_status !== "payable") {
    risks.push({
      code: `not_payable_${u.fulfillment_status}`,
      message: `Upstream reports this link as ${u.fulfillment_status}; paying it now would not settle the intended order.`,
      severity: "high",
    });
  }

  const quoteExp = u.quote_expires_at ?? u.expires_at;
  if (quoteExp) {
    const ms = Date.parse(quoteExp) - Date.now();
    if (ms <= 0) {
      risks.push({
        code: "expired",
        message: `Quote/link expired at ${quoteExp}. One-time deposit addresses die with their quote and must never be reused.`,
        severity: "high",
      });
    } else if (ms < 120_000) {
      risks.push({
        code: "expiring_soon",
        message: `Expires in ${Math.round(ms / 1000)}s (${quoteExp}). Re-inspect before signing.`,
        severity: "warn",
      });
    }
  } else {
    risks.push({
      code: "no_expiry",
      message:
        "Provider exposes no expiry for this link. Freshness cannot be proved from the link alone.",
      severity: "info",
    });
  }

  if (u.rails.length === 0) {
    risks.push({
      code: "no_rails",
      message: "No settlement rail was offered, so there is nothing to validate an address against.",
      severity: "high",
    });
  }

  for (const rail of u.rails) {
    const hit = lookupBlacklist(rail.deposit_address);
    if (hit) {
      risks.push({
        code: "blacklisted_address",
        message:
          `Deposit address ${maskAddress(hit.address)} on ${rail.chain} is on the compromised-wallet blacklist (${hit.note}). Funds sent here are swept.`,
        severity: "high",
      });
    }
  }

  if (u.amount === null || u.currency === null) {
    risks.push({
      code: "amount_unknown",
      message: "Provider did not return a definite amount + currency; exact-amount checks cannot run.",
      severity: "high",
    });
  }

  return risks;
}

function finish(u: Omit<UnifiedInspection, "risks">): UnifiedInspection {
  return { ...u, risks: commonRisks(u) };
}

/* ------------------------------------------------------------------ */
/* Coinbase                                                            */
/* ------------------------------------------------------------------ */

/**
 * Normalise `get-payment-link.js` output.
 *
 * v3 Payment Sessions carry `derived.status`; only
 * `PAYMENT_SESSION_STATUS_CREATED` is payable, and success is only asserted
 * at `PAYMENT_SESSION_STATUS_CAPTURE_SUCCEEDED` — authorisation-accepted is
 * NOT settled. Legacy links carry `derived.used` / `derived.expired`.
 */
export function normaliseCoinbase(raw: any, url: string, reference: string): UnifiedInspection {
  const d = raw?.derived ?? {};
  const status: FulfillmentStatus = (() => {
    const s = str(d.status) ?? "";
    if (s === "PAYMENT_SESSION_STATUS_CAPTURE_SUCCEEDED") return "paid";
    if (s === "PAYMENT_SESSION_STATUS_CANCELED" || s === "PAYMENT_SESSION_STATUS_CANCELLED") return "cancelled";
    if (d.used === true) return "used";
    if (d.expired === true) return "expired";
    if (d.payable === true) return "payable";
    if (d.payable === false) return "unknown";
    if (s === "PAYMENT_SESSION_STATUS_CREATED") return "payable";
    return "unknown";
  })();

  const rails: Rail[] = Array.isArray(d.rails)
    ? d.rails.map((r: any) => ({
        chain: str(r?.network) ?? str(r?.chain) ?? "unknown",
        token: str(r?.token) ?? str(r?.asset) ?? "unknown",
        deposit_address: str(r?.address) ?? undefined,
        deposit_memo: str(r?.memo) ?? undefined,
      }))
    : [{ chain: "base", token: "USDC" }]; // Coinbase settles the escrow leg on Base USDC.

  return finish({
    provider: "coinbase",
    url,
    reference,
    merchant: {
      id: str(d.merchantId),
      display_name: str(d.merchantName),
      // Coinbase exposes no merchant-verification assertion on these links.
      verified: false,
    },
    amount: str(d.fiat?.amount) ?? str(d.tokenAmount),
    currency: str(d.fiat?.currency) ?? (str(d.tokenAmount) ? "USDC" : null),
    rails,
    expires_at: isoOrNull(d.preApprovalExpiryIso) ?? isoOrNull(d.expiresAt),
    quote_expires_at: isoOrNull(d.quoteExpiryIso),
    fulfillment_status: status,
    fees: {
      platform: str(d.fees?.platform),
      rail: str(d.fees?.rail),
      bridge: str(d.fees?.bridge),
      network: str(d.fees?.network),
      total: str(d.fees?.total),
    },
    inspected_at: nowIso(),
    raw,
  });
}

/* ------------------------------------------------------------------ */
/* Stripe Crypto                                                       */
/* ------------------------------------------------------------------ */

/** Normalise `get-stripe-session.js` output (`invoice.*`). */
export function normaliseStripe(raw: any, url: string, reference: string): UnifiedInspection {
  const inv = raw?.invoice ?? {};
  const state = (str(inv.state) ?? "").toLowerCase();
  const status: FulfillmentStatus = (() => {
    if (state.includes("succeed") || state === "paid" || state === "captured") return "paid";
    if (state.includes("cancel") || state === "void") return "cancelled";
    if (state.includes("expire")) return "expired";
    if (inv.payable === true) return "payable";
    return "unknown";
  })();

  const rails: Rail[] = Array.isArray(inv.depositAddresses)
    ? inv.depositAddresses.map((a: any) => ({
        chain: str(a?.network) ?? str(a?.chain) ?? "unknown",
        token: str(a?.token) ?? str(a?.currency) ?? "unknown",
        deposit_address: str(a?.address) ?? undefined,
        deposit_memo: str(a?.memo) ?? undefined,
      }))
    : [];

  return finish({
    provider: "stripe-crypto",
    url,
    reference,
    merchant: {
      id: str(inv.merchantId),
      display_name: str(inv.merchant),
      verified: inv.merchantVerified === true,
    },
    amount: str(inv.fiat?.amount),
    currency: str(inv.fiat?.currency),
    rails,
    expires_at: isoOrNull(inv.validBeforeIso),
    // Stripe binds the deposit addresses to the same validity window; there is
    // no separate quote clock, so the two collapse. Recorded, not invented.
    quote_expires_at: isoOrNull(inv.validBeforeIso),
    fulfillment_status: status,
    fees: {
      platform: str(inv.fees?.platform),
      rail: str(inv.fees?.rail),
      bridge: str(inv.fees?.bridge),
      network: str(inv.fees?.network),
      total: str(inv.fees?.total),
    },
    inspected_at: nowIso(),
    raw,
  });
}

/* ------------------------------------------------------------------ */
/* Rozo Intent                                                         */
/* ------------------------------------------------------------------ */

/**
 * Normalise a `PaymentResponse` from `GET /payments/{id}`.
 *
 * Mapping to the unified Payment Intent spec:
 *   display.currency        → currency          (pricing unit)
 *   destination.amount      → amount            (what the merchant receives)
 *   source.receiverAddress  → rails[0].deposit_address  (one-time, quote-bound)
 *   expiresAt               → expires_at AND quote_expires_at
 *
 * The last one is the spec's §7 item 4 gap written down honestly: today the
 * API has ONE `expiresAt` doing both jobs, so we mirror it into both fields
 * rather than pretending a longer link life exists. When the API splits them,
 * only this function changes.
 */
export function normaliseRozoIntent(raw: any, url: string, reference: string): UnifiedInspection {
  const s = raw?.status ?? "";
  const status: FulfillmentStatus = (() => {
    switch (s) {
      case "payment_unpaid":
        return "payable";
      case "payment_started":
      case "payment_payin_completed":
      case "payment_bridging":
      case "payment_payout_completed":
      case "payment_completed":
        // Money already left the payer. Sending again double-pays.
        return "paid";
      case "payment_expired":
        return "expired";
      case "payment_refunded":
      case "payment_bounced":
        return "cancelled";
      default:
        return "unknown";
    }
  })();

  const src = raw?.source ?? {};
  const dst = raw?.destination ?? {};
  const rails: Rail[] = src.receiverAddress
    ? [
        {
          chain: str(src.chainId) ?? "unknown",
          token: str(src.tokenSymbol) ?? "unknown",
          deposit_address: str(src.receiverAddress) ?? undefined,
          deposit_memo: str(src.receiverMemo) ?? undefined,
        },
      ]
    : [];

  const merchantName =
    str(raw?.merchant?.displayName) ?? str(raw?.display?.title) ?? null;

  return finish({
    provider: "rozo-intent",
    url,
    reference: str(raw?.id) ?? reference,
    merchant: {
      id: str(raw?.merchant?.id) ?? str(raw?.appId),
      display_name: merchantName,
      // Only a first-class merchant record counts. `display.title` is a
      // caller-supplied string and must never be read as verification.
      verified: raw?.merchant?.verified === true || raw?.isMerchant === true,
    },
    amount: str(dst.amount) ?? str(src.amount),
    currency: str(raw?.display?.currency) ?? str(dst.tokenSymbol),
    rails,
    expires_at: isoOrNull(raw?.expiresAt),
    quote_expires_at: isoOrNull(raw?.expiresAt),
    fulfillment_status: status,
    fees: {
      // `source.fee` is the single blended scalar the API returns today.
      // It is a total, so it goes in `total`; the four component lines are
      // genuinely unknown here and stay null rather than being faked as 0.
      platform: null,
      rail: null,
      bridge: null,
      network: null,
      total: str(src.fee),
    },
    inspected_at: nowIso(),
    raw,
  });
}

/* ------------------------------------------------------------------ */
/* Fetching                                                            */
/* ------------------------------------------------------------------ */

export class InspectorUnavailableError extends Error {
  readonly code = "inspector_unavailable";
}

/** Read a recorded fixture instead of calling out. Used by tests and --fixture. */
export function loadFixture(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

async function runInspectorScript(
  envVar: string,
  url: string,
  what: string,
): Promise<unknown> {
  const script = process.env[envVar];
  if (!script) {
    throw new InspectorUnavailableError(
      `${what} inspector not configured. Set ${envVar} to the absolute path of its read-only inspector script, or pass --fixture <file>.`,
    );
  }
  const { stdout } = await execFileAsync("node", [script, "--url", url], {
    timeout: 30_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  try {
    return JSON.parse(stdout);
  } catch {
    throw new InspectorUnavailableError(
      `${what} inspector did not emit JSON on stdout.`,
    );
  }
}

/** Fetch + normalise one link. Read-only: no signing, no state change. */
export async function inspect(
  provider: Provider,
  url: string,
  reference: string,
  opts: { fixture?: string } = {},
): Promise<UnifiedInspection> {
  if (opts.fixture) {
    const raw = loadFixture(opts.fixture);
    return normaliseFor(provider, raw, url, reference);
  }

  switch (provider) {
    case "coinbase":
      return normaliseCoinbase(
        await runInspectorScript(COINBASE_INSPECTOR_ENV, url, "Coinbase"),
        url,
        reference,
      );
    case "stripe-crypto":
      return normaliseStripe(
        await runInspectorScript(STRIPE_INSPECTOR_ENV, url, "Stripe Crypto"),
        url,
        reference,
      );
    case "rozo-intent": {
      const res = await fetch(`${ROZO_API_BASE}/payments/${encodeURIComponent(reference)}`, {
        headers: { accept: "application/json" },
      });
      if (!res.ok) {
        throw new InspectorUnavailableError(
          `Rozo payment-api returned HTTP ${res.status} for payment ${reference}.`,
        );
      }
      return normaliseRozoIntent(await res.json(), url, reference);
    }
  }
}

/** Pure dispatch used by `inspect` and by the fixture-driven tests. */
export function normaliseFor(
  provider: Provider,
  raw: unknown,
  url: string,
  reference: string,
): UnifiedInspection {
  switch (provider) {
    case "coinbase":
      return normaliseCoinbase(raw, url, reference);
    case "stripe-crypto":
      return normaliseStripe(raw, url, reference);
    case "rozo-intent":
      return normaliseRozoIntent(raw, url, reference);
  }
}
