---
name: pay-link
description: Inspect a payment link from a known provider (Coinbase payment link or payment session, Stripe Crypto Payin, Rozo Intent checkout) and, if a policy layer allows it, pay it. Read-only inspection always runs first and returns one unified JSON shape regardless of provider. Triggers on "inspect this payment link", "what is this invoice", "pay this coinbase link", "pay this stripe crypto link", "pay this rozo checkout", "check before paying". Refuses any URL outside three whitelisted shapes — there is no generic URL fetcher here by design.
---

# pay-link

Two commands over three providers:

```bash
# always safe, never signs anything
./node_modules/.bin/tsx skills/pay-link/run.ts inspect <url> [--json]

# runs inspect, then the policy layer, then (optionally) execution
./node_modules/.bin/tsx skills/pay-link/run.ts pay <url> [--confirm <digest>] [--max-auto 1]
```

Exit codes: `0` allowed / inspected, `1` operational failure, `2` **refused by
policy or awaiting confirmation — nothing was signed**.

## Providers, and only these providers

| Provider | URL shape | Read by |
|---|---|---|
| Coinbase | `https://payments.coinbase.com/payment-links/pl_…` | `pay-coinbase` → `get-payment-link.js --url` |
| Coinbase v3 | `https://payments.coinbase.com/payment-sessions/paymentSession_…` | same |
| Stripe Crypto | `https://crypto.stripe.com/pay/…` | `pay-stripe-crypto` → `get-stripe-session.js --url` |
| Rozo Intent | `https://invoice.rozo.ai/checkout?id=…` (and the `pay.mugglepay.com` brand prefix) | `GET /payments/{id}` on the Rozo payment-api |

**Anything else is refused without being fetched.** This skill deliberately has
no "read any URL and work out how to pay it" path: a blind fetcher turns every
link anyone can put in front of the agent into a signing prompt. If a new
provider is needed, add an explicit pattern plus a real read-only inspector to
`scripts/src/pay-link/url.ts` and `inspectors.ts`.

The two sibling inspector scripts are not vendored. Point at them with:

```bash
export PAY_COINBASE_INSPECTOR=/abs/path/to/pay-coinbase/scripts/dist/get-payment-link.js
export PAY_STRIPE_INSPECTOR=/abs/path/to/pay-stripe-crypto/scripts/dist/get-stripe-session.js
```

Not set → a clear `inspector_unavailable` error, never a silent guess. For
testing and demos, `--fixture <file>` reads a recorded response instead —
accepted on `inspect`, and on `pay` only together with `--dryrun`. A fixture on
a live payment path would let benign local JSON satisfy every check while the
real link is what gets paid.

## The unified inspection shape

Every provider normalises to one object, so the policy layer, the digest and
the receipt never learn which upstream produced it. Field names track the
unified Payment Intent design spec (ainative
`docs/design/payment-intent-spec-2026-09-03.md`, §2 and §5).

```jsonc
{
  "provider": "rozo-intent",              // coinbase | stripe-crypto | rozo-intent
  "url": "https://invoice.rozo.ai/checkout?id=pay_abc123",
  "reference": "pay_abc123",              // provider-native id
  "merchant": { "id": "mrc_mugglelink", "display_name": "MuggleLink", "verified": true },
  "amount": "5.00",                       // decimal string, or null
  "currency": "USD",                      // PRICING unit, not a chain asset
  "rails": [                              // enumerated settlement routes, never "any token"
    { "chain": "1500", "token": "USDC",
      "deposit_address": "G…",            // one-time, quote-bound
      "deposit_memo": "9931" }
  ],
  "expires_at": "…",                      // link validity
  "quote_expires_at": "…",                // quote/deposit-address validity (shorter)
  "fulfillment_status": "payable",        // payable|paid|used|expired|cancelled|unknown
  "fees": { "platform": null, "rail": null, "bridge": null, "network": null, "total": "0.01" },
  "risks": [ { "code": "unverified_merchant", "message": "…", "severity": "warn" } ],
  "inspected_at": "…",                    // freshness is measured from here
  "raw": { }                              // untouched provider payload
}
```

Three rules the shape enforces:

- **`currency` is a pricing unit; `rails` are settlement assets.** Never collapsed.
- **A deposit address only ever appears inside a rail, and dies with
  `quote_expires_at`.** Nothing above it may cache one, and it is never printed
  into anything durable.
- **A field we could not read is `null`, never `0` and never a guess.** A missing
  fee is not a free fee; an unrecognised status is `unknown`, which is unpayable.

## The policy layer

`pay` evaluates the inspection and returns one of three decisions:

- **auto** — every check green and the amount is at or below `--max-auto`
  (default `$5`, hard-capped at `$5`, same reasoning as `pay-per-call`).
- **confirm** — allowed, but a human must echo a digest back (below).
- **refuse** — nothing is signed. Exit code 2.

It **fails closed**: anything we cannot prove is a refusal, not a warning. All
refusals are collected and printed together, so a link with three problems does
not get nudged through one fix at a time.

### Every refusal path

| Code | Refused when |
|---|---|
| `unsupported_link` | URL is not one of the four whitelisted shapes, is not https, uses a non-default port, or carries embedded credentials |
| `fixture_not_allowed` | `--fixture` was used on the `pay` path without `--dryrun` |
| `reservation_open` | a previous run opened a reservation for this exact `(url, digest)` and never settled it — reconcile before retrying |
| `not_payable` | upstream says paid / used / expired / cancelled / unknown — a `paid` link would double-pay |
| `expired` | `quote_expires_at` (else `expires_at`) is in the past |
| `stale_inspection` | inspection older than 300s, or has no usable timestamp |
| `no_rail` | link offers no settlement rail |
| `rail_not_accepted` | chosen rail's chain is outside `--chain` |
| `missing_deposit_address` | the rail has no address yet |
| `malformed_address` | address fails the chain's shape check (truncation, wrong chain) |
| `blacklisted_address` | address is on the compromised-wallet blacklist |
| `amount_unknown` | no definite amount, so exact-amount and limit checks cannot run |
| `unsupported_currency` | priced in something other than USD / USDC / USDT — every ceiling here is USD-denominated, and there is no trusted rate to convert with, so it is refused rather than guessed |
| `amount_mismatch` | differs from `--expect-amount` |
| `currency_mismatch` | differs from `--expect-currency` |
| `payee_mismatch` | deposit address differs from `--expect-pay-to` (compared **chain-aware**: case-insensitive for EVM hex, exact for Stellar / Solana / Tron, where case is part of the address) |
| `merchant_not_allowed` | `--merchant-allow` is set and this merchant is not on it |
| `per_call_limit` | above the per-payment ceiling (default $25) |
| `daily_limit` | would push rolling 24h spend over the ceiling (default $50) |
| `monthly_limit` | would push rolling 30d spend over the ceiling (default $200) |

An **unverified merchant** that is not allow-listed does not refuse — it forces
a confirmation. So does any `high`-severity risk, and any amount above
`--max-auto`.

### Blacklist check

Deposit addresses are matched against `scripts/src/pay-link/blacklist.ts`, which
mirrors the compromised-wallet table in the operator's `CLAUDE.md`. The check
runs **twice**: once at inspect time (as a `high` risk) and again in the policy
layer (as a hard refusal), so a caller who only ever runs `inspect` still sees
it. Only public addresses live in that file — no key material, ever. Messages
mask addresses to first-6 + last-4.

## Confirmation digest

Above the auto ceiling, `pay` prints a 16-hex digest over exactly the facts that
decide where money goes — url, amount, currency, and the chosen rail's chain,
token, deposit address and memo — and refuses until it is echoed back with
`--confirm`. Chain and token are in the digest because an EVM deposit address
is often the same string on several chains: binding only the address would let
a confirmed Base/USDC payment be re-pointed at Ethereum/USDT unnoticed. Cosmetic upstream churn does
not invalidate a confirmation; a moved address does.

- `NOT_CONFIRMED` — no `--confirm` supplied. The digest to use is printed.
- `CONFIRMATION_STALE` — digest does not match and nothing money-moving changed.
- `DEPOSIT_CHANGED` — the address or amount moved since that digest was issued.
  The old one-time address may already be expired; re-inspect, never reuse.

## Receipts and idempotency

Every execution emits a machine-readable receipt:

```jsonc
{ "provider": "…", "reference": "…", "tx_hash": null, "amount": "5.00",
  "currency": "USD", "status": "dryrun", "digest": "2f80…", "at": "…" }
```

Retries are idempotent on `(url, digest)`, recorded in a local ledger
(`.pay-link-ledger.json`, mode 600, public facts only).

The ledger is written **before** anything could move money, not after: a
`pending` reservation row goes in first, and is settled to its real outcome
afterwards. So the three retry cases are distinguishable —

- prior run **settled** (`submitted` / `confirmed`) → the stored receipt is
  replayed, nothing is paid again;
- prior run left a **`pending`** reservation → `reservation_open` refusal.
  Either another run is in flight or one died between paying and recording;
  money may already have moved, so this must be reconciled by hand, never
  retried blindly;
- no entry → proceed.

An unsettled reservation also consumes the spend ceilings, for the same reason.
Dry runs do not.

**This is a local file, not a distributed lock.** It closes the crash window
and the obvious double-run, but before the real provider leg is enabled that
leg must also be idempotent on its own order id — two machines sharing a wallet
would not see each other's ledger.

## Execution status

**This release inspects, validates and dry-runs. It does not move funds.** When
policy passes, the receipt comes back with `status: "dryrun"` and a note saying
so, rather than reporting a success that moved nothing. Wiring the real leg
means calling each provider's own already-audited pay script — this skill will
never reimplement signing.

## Testing

```bash
npm run test:pay-link          # both suites, fixture-driven, no network
```

`scripts/smoke-test-pay-link-inspect.ts` covers the URL whitelist and all three
normalisers; `scripts/smoke-test-pay-link-policy.ts` covers every refusal code
(the suite asserts the coverage set is complete, so a new refusal without a test
fails the build), the digest states and the ledger.
