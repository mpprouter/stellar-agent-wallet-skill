/**
 * pay-link — one unified shape for every payment link we can inspect.
 *
 * Three providers (Coinbase Commerce payment links / sessions, Stripe Crypto
 * Payin, Rozo Intent) each expose a different JSON body. `inspect` normalises
 * all three into `UnifiedInspection` so the policy layer, the confirmation
 * digest and the receipt never learn which provider they came from.
 *
 * Field names deliberately track the unified Payment Intent design spec
 * (ainative `docs/design/payment-intent-spec-2026-09-03.md`, §2 "The Intent
 * object" and §5 "Pre-payment validation contract") so the two stay
 * compatible: `merchant.verified`, the split of a pricing `amount.unit` from
 * settlement `rails`, and the hard separation of an intent-level `expires_at`
 * from a quote-level `quote_expires_at` are all taken from there.
 *
 * Rule from that spec restated here because it is load-bearing:
 * **a deposit address only ever lives inside `quote`, and dies with
 * `quote_expires_at`.** Nothing above the quote may cache one.
 */

/** Which upstream produced this link. Closed set — see url.ts for the whitelist. */
export type Provider = "coinbase" | "stripe-crypto" | "rozo-intent";

/**
 * Where the payment stands upstream, normalised across providers.
 *
 * - `payable`    — open, unpaid, quote still valid: the only state we may pay.
 * - `paid`       — already settled/captured upstream. Paying again double-pays.
 * - `used`       — link consumed (usage count exhausted) without being ours.
 * - `expired`    — past its validity window.
 * - `cancelled`  — voided upstream.
 * - `unknown`    — provider returned a state we do not recognise. Fail closed.
 */
export type FulfillmentStatus =
  | "payable"
  | "paid"
  | "used"
  | "expired"
  | "cancelled"
  | "unknown";

/** One settlement route the link will accept. */
export interface Rail {
  /** Human/chain name as the provider spells it, e.g. "base", "stellar", "ethereum". */
  chain: string;
  /** Token symbol, e.g. "USDC", "USDT". */
  token: string;
  /**
   * One-time deposit address for this rail, when the provider has already
   * issued one. Quote-bound: never cache, never reuse, never print into
   * anything durable (see spec §3.1 on printed QR codes).
   */
  deposit_address?: string;
  /** Destination memo/tag, where the chain needs one (Stellar, Tron-style tags). */
  deposit_memo?: string;
}

/** A risk note surfaced to the operator. Advisory; refusals live in policy.ts. */
export interface Risk {
  /** Stable machine code, e.g. "unverified_merchant", "expiring_soon". */
  code: string;
  /** Human sentence explaining the risk. */
  message: string;
  severity: "info" | "warn" | "high";
}

/** The unified read-only view of a payment link. Produced by `inspect`. */
export interface UnifiedInspection {
  provider: Provider;
  /** The URL as given, after whitelist validation. Echoed for digest binding. */
  url: string;
  /** Provider-native identifier (payment link id, session id, Rozo payment id). */
  reference: string;
  /**
   * `provider:reference` — the invoice's identity, independent of how its URL
   * was written. Idempotency is keyed on this, never on the raw URL, so a
   * differing fragment or tracking parameter cannot buy a second payment.
   */
  canonical_key: string;

  merchant: {
    /** Provider-native merchant id, when exposed. */
    id: string | null;
    display_name: string | null;
    /**
     * True only when the provider itself asserts the merchant is verified.
     * Unknown ⇒ false, and policy treats false as "needs a whitelist entry or
     * a human". Never inferred from the merchant's own display name.
     */
    verified: boolean;
  };

  /** Pricing amount — what the payer owes, in `currency`. Decimal string. */
  amount: string | null;
  /** Pricing unit for `amount` (e.g. "USD"). NOT a chain asset (spec §2 rule 1). */
  currency: string | null;

  /** Enumerated settlement routes. Never "any token". */
  rails: Rail[];

  /** ISO-8601 expiry of the link itself, or null when the provider gives none. */
  expires_at: string | null;
  /**
   * ISO-8601 expiry of the *quote / deposit address*, which is usually much
   * shorter than `expires_at`. Kept separate on purpose (spec §7 item 4).
   */
  quote_expires_at: string | null;

  fulfillment_status: FulfillmentStatus;

  /** Fee breakdown when the provider exposes one. Absent fields stay null,
   *  never 0 — a missing fee is not a free fee (spec §6). */
  fees: {
    platform: string | null;
    rail: string | null;
    bridge: string | null;
    network: string | null;
    total: string | null;
  };

  risks: Risk[];

  /** UTC timestamp of this inspection. Policy freshness is measured from here. */
  inspected_at: string;

  /** Untouched provider payload, for debugging and for fields we do not model. */
  raw: unknown;
}

/** Machine-readable receipt emitted after a (dry-run or real) execution. */
export interface Receipt {
  provider: Provider;
  /** Provider-native reference — same value as `UnifiedInspection.reference`. */
  reference: string;
  tx_hash: string | null;
  amount: string | null;
  currency: string | null;
  /**
   * `pending` is written BEFORE the provider leg runs, as a reservation. It
   * means "we may have moved money and do not yet know" — a retry must
   * reconcile, not re-pay.
   */
  status: "dryrun" | "pending" | "submitted" | "confirmed" | "refused" | "failed";
  /** Digest that authorised this execution; ties a retry to its confirmation. */
  digest: string;
  at: string;
}
