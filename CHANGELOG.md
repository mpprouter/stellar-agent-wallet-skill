# Changelog — Stellar Agentic Wallet

A Stellar USDC wallet skill for AI agents: pay 402-gated APIs (x402 or MPP
Router), check balances, manage USDC trustlines, swap XLM→USDC, and bridge
USDC cross-chain. Client-only; the agent's key never leaves the machine.

Repository: https://github.com/mpprouter/stellar-agent-wallet-skill ·
Published: https://clawhub.ai/shawnmuggle/stellar-agentic-wallet

---

## Unreleased — `send-raw` sub-skill

- **New — `send-raw`: pay a deposit address exactly as specified.** Every
  existing spending command *originates* a payment: `send-payment` and
  `bridge` POST a new Rozo intent and fund whatever deposit address Rozo
  hands back. There was no way to pay an address and memo that some **other**
  system had already issued — a Rozo checkout order, an exchange deposit
  slip, an invoice. `send-raw --to <G...> --amount <n> --asset USDC --memo
  <m>` builds, signs and submits that single Classic payment and nothing
  else.

  Without it, callers had to hand-roll `stellar tx new payment --build-only`
  → `tx decode` → patch the memo into the JSON by hand → `tx encode` → sign →
  send, because the Stellar CLI's `tx new payment` has no `--memo` flag. A
  dropped memo means the funds land and are never credited, so that pipeline
  was the worst possible place to improvise.

  Preflight refuses, before anything is signed, a destination that does not
  exist, does not trust the asset, is unauthorized by the issuer, or lacks
  trustline headroom; an amount over 7 decimals or beyond the spendable
  balance; a memo that breaks its type's limits; a `C...` contract address;
  and a self-payment. Amounts pass through verbatim so an exact-match
  deposit of `1.0500` is not silently reformatted. Mainnet always prompts.

  Affordability math runs in stroops (`bigint`), net of `selling_liabilities`
  so XLM committed to open DEX offers is not counted as spendable, and with
  the network fee charged against XLM above the minimum reserve. Float math
  at the boundary would either refuse an affordable payment or submit an
  unaffordable one — and a transaction that fails on-chain still burns its
  fee.

  Two hardening guards on inputs that come from outside: `--asset` must be
  exactly one `CODE:ISSUER` pair (a three-part spec would otherwise silently
  use the first issuer and pay the wrong token), and MEMO_TEXT may not
  contain control characters (ANSI escapes in a memo could rewrite the
  confirmation display after the destination had been printed, defeating the
  human verification step).

- **Docs — corrected the deposit-funding routing rule.** The router's
  "funding rozo-intents payments" step told agents to use `send-payment` for
  an already-issued deposit address. That is wrong: `send-payment`'s `--to`
  is the recipient of a **new** intent, so following it opened a second
  intent, paid a different address, burned an extra fee and left the
  original order unfunded. It now points at `send-raw`.

- **Tests — `npm run test:send-raw`.** Runs the full build → sign → submit
  path on testnet against Friendbot-funded accounts, then re-reads the
  transaction from Horizon and asserts the memo, amount, destination and
  asset that actually landed on-chain. Also covers the validation guards,
  including a multi-byte memo that is under 28 characters but over the
  28-**byte** MEMO_TEXT limit.

---

## Unreleased — 2026-07-31 hardening round

Security, correctness and transparency work driven by real mainnet usage
during SCF #44 Tranche 1 verification.

- **Security — plaintext key warning at runtime** (#10). Loading a signing
  key from a plaintext file now prints an explicit warning naming the file
  and recommending Stellar CLI key management instead. Silent plaintext key
  loading was the single most dangerous default in the skill.
- **Security — `--max-auto` hard cap and loud auto-signing** (#9). The
  auto-pay ceiling is now bounded by the tool itself, and every
  auto-approved signature announces the amount and destination. An agent
  cannot be configured into quietly spending unbounded amounts.
- **Correctness — x402 v2 credential placement** (#13). The credential is
  now sent in the header v2 servers actually read (`Payment-Signature`),
  so the skill interoperates with x402 v2 facilitators, not just the MPP
  dialect.
- **Correctness — signature auth-entry window** (#14). The signed
  authorization window is kept inside any verifier's ceiling, removing a
  class of "valid signature, rejected by verifier" failures.
- **Transparency — human-readable payment receipts** (#8). `pay-per-call`
  decodes the `Payment-Receipt` header into a readable summary (amount,
  destination, timestamp) and emits a machine-readable receipt line with
  the **Stellar transaction hash and explorer URL** — so every agent
  payment is independently auditable on-chain.
- **Docs — both 402 dialects showcased, with a real mainnet capture**
  (#11, #12). The placeholder receipt in the docs was replaced with an
  actual mainnet payment capture; the sponsored-fees error path no longer
  swallows failures.
- **CI — suite runs on every PR and fails when `build/` goes stale** (#15).
  The published plugin artifact can no longer drift from source.

## v1.7.0 — 2026-04-15

- **No `child_process` in shipped artifacts.** Removed process spawning
  from everything that ships, shrinking the trust surface for a skill that
  holds a signing key.

## v1.6.0 — 2026-04-15

- **402 challenge validated against catalog expectations.** Before signing,
  the skill checks the live challenge (amount, asset, recipient) against
  what the catalog advertised, so a tampered or drifted challenge is caught
  before money moves.

## v1.5.0 — 2026-04-15

- Opt-in auto-pay ceiling for `pay-per-call` (later hard-capped, see
  Unreleased).

## v1.4.0 — 2026-04-15

- Plugin ships without `node_modules`; build artifacts slimmed.

## v1.3.0 / v1.3.1 — 2026-04-14

- **`onboard` skill**: first-run flow that funds, adds the USDC trustline,
  and gets an agent from zero to payment-ready.
- 405 auto-recovery for method-mismatched routes.

## v1.2.x — 2026-04-12 → 04-13

- GET-body error fixed; env-file secret fallback.
- Auto-install dependencies during build; Stellar-first source preference.

## v1.1.x — 2026-04-12

- **Security: every mainnet payment requires confirmation** (v1.1.8).
- **Wire-format correctness**: hand-rolled MPP codec replaced with the
  `mppx` dependency so the credential wire shape stays byte-identical to
  the reference implementation; `WWW-Authenticate` parsing fixed for quoted
  `request` values; x402 `Payment-Required` support added.
- `discover` surfaces `verified_mode` as a payment-mode label, so an agent
  can see whether a route has been verified before paying for it.
- Resolved the OpenClaw skill-audit flags.

## v1.0 — 2026-04

- Initial release: Stellar USDC balance checks, trustline management,
  XLM→USDC swap on the Classic DEX, `pay-per-call` for 402-gated APIs, and
  cross-chain USDC send/bridge via Rozo.

---

### Verification

The payment path in this changelog is exercised on Stellar **mainnet**, not
only in tests. During SCF #44 Tranche 1 verification (2026-07-29 and
2026-08-01) this skill made every paid call in the submission's per-service
transaction table — each one settling in USDC on pubnet with a publicly
verifiable transaction hash.
