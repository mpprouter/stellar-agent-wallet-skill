/**
 * pay-link policy layer — the part that says no.
 *
 * Everything here is a pure function over an inspection plus a policy config,
 * so every refusal path is unit-testable without a network, a wallet or a
 * signing key. `evaluate()` returns a decision; it never signs, never fetches
 * and never mutates anything.
 *
 * Design rule: **fail closed.** Anything we cannot prove is a refusal, not a
 * warning. An unknown upstream status, an amount we could not read, a rail
 * with no address, an inspection we cannot date — all refuse. The one thing
 * that may downgrade a refusal to a prompt is an explicit human confirmation.
 *
 * The checklist mirrors §5 of the unified Payment Intent spec
 * (merchant / amount / asset / address / freshness / policy / idempotency)
 * so a Rozo Intent validated here and one validated by the Intent contract
 * are checked against the same seven things.
 */

import type { UnifiedInspection } from "./types.js";
import { lookupBlacklist, maskAddress } from "./blacklist.js";
import { addressLooksValid, sameAddress } from "./address.js";

/** Stable machine codes for every way this layer can refuse. */
export type RefusalCode =
  | "not_payable"
  | "expired"
  | "stale_inspection"
  | "no_rail"
  | "rail_not_accepted"
  | "missing_deposit_address"
  | "malformed_address"
  | "blacklisted_address"
  | "amount_unknown"
  | "unsupported_currency"
  | "amount_mismatch"
  | "currency_mismatch"
  | "payee_mismatch"
  | "merchant_not_allowed"
  | "per_call_limit"
  | "daily_limit"
  | "monthly_limit";

export interface Refusal {
  code: RefusalCode;
  message: string;
}

export interface PolicyConfig {
  /** Hard per-payment ceiling in `amount` units. Exceeding it refuses outright. */
  maxPerCallUsd: number;
  /** Rolling 24h ceiling. Compared against `spentTodayUsd`. */
  maxDailyUsd: number;
  /** Rolling 30d ceiling. Compared against `spentThisMonthUsd`. */
  maxMonthlyUsd: number;
  /**
   * Unattended ceiling. At or below this, and with every other check green,
   * the payment may execute without a confirmation digest. Above it, a human
   * confirms. Never above `maxPerCallUsd`.
   */
  maxAutoUsd: number;
  /** Already spent in the rolling windows, supplied by the ledger. */
  spentTodayUsd: number;
  spentThisMonthUsd: number;
  /**
   * Merchant allow-list, matched case-insensitively against
   * `merchant.display_name` or `merchant.id`. Empty list = allow-list
   * disabled, in which case an unverified merchant still needs confirmation.
   */
  merchantWhitelist: string[];
  /** Exact expected amount. When set, any difference refuses. */
  expectAmount?: string;
  /** Expected pricing unit, e.g. "USD". */
  expectCurrency?: string;
  /** Expected deposit address. When set, a different address refuses. */
  expectPayTo?: string;
  /** Accepted chain names; empty = accept whatever the link offers. */
  acceptChains?: string[];
  /**
   * How old an inspection may be before it must be redone, in seconds.
   * Quote-bound deposit addresses go stale fast; re-inspect rather than reuse.
   */
  maxInspectionAgeSeconds: number;
  /** Clock injection point for tests. */
  now?: Date;
}

export const DEFAULT_POLICY: Omit<
  PolicyConfig,
  "spentTodayUsd" | "spentThisMonthUsd" | "merchantWhitelist"
> = {
  maxPerCallUsd: 25,
  maxDailyUsd: 50,
  maxMonthlyUsd: 200,
  // Matches the pay-per-call hard cap: unattended signing stays in
  // per-call-API territory, never in real-money territory.
  maxAutoUsd: 5,
  maxInspectionAgeSeconds: 300,
};

/**
 * Pricing units the USD-denominated ceilings may be applied to directly.
 * "USDC"/"USDT" are dollar-pegged stablecoins quoted 1:1 by every provider we
 * read; anything else needs a rate we do not have.
 */
const ALLOWED_CURRENCIES = new Set(["USD", "USDC", "USDT"]);

/** Hard cap on `--max-auto`, same value and same reasoning as pay-per-call. */
export const MAX_AUTO_CEILING_USD = 5;

export type Decision =
  | { action: "refuse"; refusals: Refusal[] }
  | { action: "confirm"; reasons: string[]; amountUsd: number }
  | { action: "auto"; amountUsd: number };

function parseAmount(v: string | null): number | null {
  if (v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Exact decimal-string comparison, tolerant of trailing zeros ("5" vs "5.00"). */
function sameAmount(a: string, b: string): boolean {
  const x = Number(a);
  const y = Number(b);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return a.trim() === b.trim();
  return Math.abs(x - y) < 1e-9;
}

/**
 * Evaluate one inspection against policy.
 *
 * Collects ALL refusals rather than short-circuiting on the first: an
 * operator fixing one problem at a time against a link that has three is how
 * a bad payment gets nudged through.
 */
export function evaluate(
  ins: UnifiedInspection,
  cfg: PolicyConfig,
  railIndex = 0,
): Decision {
  const now = cfg.now ?? new Date();
  const refusals: Refusal[] = [];
  const confirmReasons: string[] = [];

  /* 1. upstream state ---------------------------------------------------- */
  if (ins.fulfillment_status !== "payable") {
    refusals.push({
      code: "not_payable",
      message:
        ins.fulfillment_status === "paid"
          ? "Upstream reports this link as already paid. Paying again would double-pay."
          : `Upstream reports this link as ${ins.fulfillment_status}, which is not payable.`,
    });
  }

  /* 2. freshness --------------------------------------------------------- */
  const expiryIso = ins.quote_expires_at ?? ins.expires_at;
  if (expiryIso) {
    const exp = Date.parse(expiryIso);
    if (!Number.isNaN(exp) && exp <= now.getTime()) {
      refusals.push({
        code: "expired",
        message: `Quote/link expired at ${expiryIso}. Its one-time deposit address must never be reused — request a fresh quote.`,
      });
    }
  }
  const inspectedAt = Date.parse(ins.inspected_at);
  if (Number.isNaN(inspectedAt)) {
    refusals.push({
      code: "stale_inspection",
      message: "Inspection has no usable timestamp, so its freshness cannot be proved.",
    });
  } else {
    const ageSec = (now.getTime() - inspectedAt) / 1000;
    if (ageSec > cfg.maxInspectionAgeSeconds) {
      refusals.push({
        code: "stale_inspection",
        message: `Inspection is ${Math.round(ageSec)}s old (limit ${cfg.maxInspectionAgeSeconds}s). Re-inspect before paying; deposit addresses are quote-bound.`,
      });
    }
  }

  /* 3. rail + address ---------------------------------------------------- */
  const rail = ins.rails[railIndex];
  if (!rail) {
    refusals.push({
      code: "no_rail",
      message: "The link offers no settlement rail, so there is no address to validate.",
    });
  } else {
    if (cfg.acceptChains && cfg.acceptChains.length > 0) {
      const ok = cfg.acceptChains.some(
        (c) => c.toLowerCase() === rail.chain.toLowerCase(),
      );
      if (!ok) {
        refusals.push({
          code: "rail_not_accepted",
          message: `Rail ${rail.chain}/${rail.token} is not in the accepted set (${cfg.acceptChains.join(", ")}).`,
        });
      }
    }

    if (!rail.deposit_address) {
      refusals.push({
        code: "missing_deposit_address",
        message: `Rail ${rail.chain}/${rail.token} has no deposit address yet. Nothing may be signed against a placeholder.`,
      });
    } else {
      const hit = lookupBlacklist(rail.deposit_address);
      if (hit) {
        refusals.push({
          code: "blacklisted_address",
          message: `REFUSED: deposit address ${maskAddress(hit.address)} (${rail.chain}) is on the compromised-wallet blacklist — ${hit.note}. Funds sent there are swept immediately.`,
        });
      }
      if (!addressLooksValid(rail.chain, rail.deposit_address)) {
        refusals.push({
          code: "malformed_address",
          message: `Deposit address ${maskAddress(rail.deposit_address)} does not look like a valid ${rail.chain} address.`,
        });
      }
      if (cfg.expectPayTo) {
        // Chain-aware: case matters on Stellar/Solana/Tron. See address.ts.
        const same = sameAddress(rail.chain, cfg.expectPayTo, rail.deposit_address);
        if (!same) {
          refusals.push({
            code: "payee_mismatch",
            message: `Deposit address ${maskAddress(rail.deposit_address)} does not match the expected payee ${maskAddress(cfg.expectPayTo)}.`,
          });
        }
      }
    }
  }

  /* 4. amount + currency ------------------------------------------------- */
  const amountUsd = parseAmount(ins.amount);
  if (amountUsd === null) {
    refusals.push({
      code: "amount_unknown",
      message: "No definite amount was returned, so exact-amount and limit checks cannot run.",
    });
  } else {
    if (cfg.expectAmount && !sameAmount(cfg.expectAmount, ins.amount!)) {
      refusals.push({
        code: "amount_mismatch",
        message: `Link amount ${ins.amount} does not match the expected ${cfg.expectAmount}.`,
      });
    }
    if (amountUsd > cfg.maxPerCallUsd) {
      refusals.push({
        code: "per_call_limit",
        message: `Amount ${amountUsd} exceeds the per-payment ceiling of ${cfg.maxPerCallUsd}.`,
      });
    }
    if (cfg.spentTodayUsd + amountUsd > cfg.maxDailyUsd) {
      refusals.push({
        code: "daily_limit",
        message: `This payment would take today's spend to ${(cfg.spentTodayUsd + amountUsd).toFixed(2)}, over the daily ceiling of ${cfg.maxDailyUsd}.`,
      });
    }
    if (cfg.spentThisMonthUsd + amountUsd > cfg.maxMonthlyUsd) {
      refusals.push({
        code: "monthly_limit",
        message: `This payment would take the 30-day spend to ${(cfg.spentThisMonthUsd + amountUsd).toFixed(2)}, over the monthly ceiling of ${cfg.maxMonthlyUsd}.`,
      });
    }
  }

  if (cfg.expectCurrency) {
    if (!ins.currency || ins.currency.toLowerCase() !== cfg.expectCurrency.toLowerCase()) {
      refusals.push({
        code: "currency_mismatch",
        message: `Link is priced in ${ins.currency ?? "an unknown unit"}, expected ${cfg.expectCurrency}.`,
      });
    }
  }

  // Every ceiling in this config is denominated in USD. Comparing a raw
  // numeric amount against them only means anything if the pricing unit IS
  // USD — otherwise "0.1 BTC" reads as 0.1 and sails under a $5 auto ceiling.
  // We have no trusted rate source here, so anything that is not USD is
  // refused rather than converted with a guess.
  if (!ins.currency || !ALLOWED_CURRENCIES.has(ins.currency.trim().toUpperCase())) {
    refusals.push({
      code: "unsupported_currency",
      message:
        `Link is priced in ${ins.currency ?? "an unknown unit"}, but every limit in this policy is denominated in USD. ` +
        `Without a trusted conversion rate the ceilings are meaningless, so this is refused rather than guessed.`,
    });
  }

  /* 5. merchant ---------------------------------------------------------- */
  const wl = cfg.merchantWhitelist.map((m) => m.trim().toLowerCase()).filter(Boolean);
  const candidates = [ins.merchant.display_name, ins.merchant.id]
    .filter((x): x is string => !!x)
    .map((x) => x.toLowerCase());
  const whitelisted = wl.length > 0 && candidates.some((c) => wl.includes(c));

  if (wl.length > 0 && !whitelisted) {
    refusals.push({
      code: "merchant_not_allowed",
      message: `Merchant “${ins.merchant.display_name ?? ins.merchant.id ?? "unknown"}” is not on the allow-list.`,
    });
  }
  if (!ins.merchant.verified && !whitelisted) {
    confirmReasons.push(
      `Merchant is not verified by ${ins.provider} and is not on the allow-list; a human must vouch for it.`,
    );
  }

  if (refusals.length > 0) return { action: "refuse", refusals };

  /* 6. auto vs confirm --------------------------------------------------- */
  const amt = amountUsd as number;
  if (amt > cfg.maxAutoUsd) {
    confirmReasons.push(
      `Amount ${amt} is above the pre-authorised ceiling of ${cfg.maxAutoUsd}.`,
    );
  }
  for (const r of ins.risks) {
    if (r.severity === "high") confirmReasons.push(r.message);
  }

  return confirmReasons.length > 0
    ? { action: "confirm", reasons: confirmReasons, amountUsd: amt }
    : { action: "auto", amountUsd: amt };
}
