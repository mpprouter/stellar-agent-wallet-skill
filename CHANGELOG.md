# Changelog — Stellar Agentic Wallet

A Stellar USDC wallet skill for AI agents: pay 402-gated APIs (x402 or MPP
Router), check balances, manage USDC trustlines, swap XLM→USDC, and bridge
USDC cross-chain. Client-only; the agent's key never leaves the machine.

Repository: https://github.com/mpprouter/stellar-agent-wallet-skill ·
Published: https://clawhub.ai/shawnmuggle/stellar-agentic-wallet

---

## v1.8.8 — 2026-08-21

Fixes the async-job poll loop, which never authenticated and so hung on every
paid call that returned a job. **Security: the poll's ownership proof is now
domain-separated — this release must be paired with the matching router
change, already live.**

- **Async polls now prove ownership.** The loop reused the payment headers from
  the original request; the router requires an Ed25519 signature over a nonce
  from `GET /jobs/<id>/challenge`. Every poll returned 401, and 401 fell through
  to a generic retry, so the CLI spun for the full 10-minute timeout and never
  surfaced the refund id — even when the payment had already been refunded
  on-chain minutes earlier.
- **The signed payload is domain-separated.** The proof signs the UTF-8 bytes of
  `mpprouter-job-ownership-v1:<jobId>:<nonce>`, never the bare 32-byte nonce.
  Every Stellar signing payload — transactions, Soroban auth entries — is a bare
  32-byte hash, so signing a service-chosen 32-byte value would let a malicious
  service harvest a valid transaction signature from the payer's wallet. The CLI
  additionally refuses outright to sign any 32-byte payload.
- **401/403 are now terminal after 3 strikes** instead of retrying forever, and
  point you at `scripts/verify-refund.mjs`. Transient network and JSON errors
  stay retryable — the payment has already settled by that point.
- **Poll interval 5s → 15s**, and a line is printed only when the status
  actually changes, instead of one line per attempt.

## v1.8.7 — 2026-08-19

Ships refund verification as a runnable script instead of a copy-paste snippet,
and corrects the documented refund latency. No change to signing or payment
behaviour.

- New `scripts/verify-refund.mjs`: polls a refund receipt until it is signed
  (`--wait`, 180s default timeout) and verifies the Ed25519 signature against
  the signers published at `/health`. Read-only; exit 0 = VALID.
- Refund latency guidance corrected from "~25s" to **within 1–2 minutes**: the
  router's refund signer runs on a once-per-minute cron, so the old figure was
  a lucky sample (measured range 22s–68s, rare slower outliers).

## v1.8.6 — 2026-08-18

Makes an automatic refund visible to the payer, and documents how to verify the
receipt without trusting us. No change to signing or payment behaviour.

- **`pay-per-call` now prints `Refund-Id` when a paid call fails.** The MPP
  Router refunds a payment the upstream did not fulfil, and reports it *only*
  in response headers (`Refund-Id`, `Refund-Status`, `Refund-Status-Url`) —
  the body is the upstream error. This client printed only the body, so the
  payer never learned the refund id and had no way to fetch the signed receipt
  at `GET /v1/refunds/{id}`. The refund is now reported on stderr on both the
  direct response and async job polls, and `--json` adds a machine-readable
  `REFUND_JSON` line.
- **A poll response carrying refund headers is treated as terminal.** An async
  job that failed after payment previously kept polling until the 10-minute
  timeout instead of stopping at the refund.
- **The receipt URL is validated and printed bare.** It arrives in a header
  from whatever endpoint was called, so it is accepted only as an `http(s)`
  URL and never printed inside a copyable shell command — a value carrying
  shell metacharacters cannot become a command the payer pastes.
- **New: `references/verifying-refunds.md`.** Payer-side walkthrough from "my
  call failed" to `VALID`: read the id, poll until the receipt is signed
  (~25s), take the signer from `/health`, verify the Ed25519 signature over
  the `rozo-receipt-json-v1` canonicalisation, and check both transactions on
  Stellar. Includes a one-line tamper that flips the result to `INVALID`.

---

## v1.8.5 — 2026-08-11

Documentation corrections from the ClawHub security review (clawscan
"Review" findings on 1.8.4). No code changes.

- **Endpoint disclosure was inaccurate (LP3).** The metadata implied only the
  listed endpoints are contacted, but pay-per-call by design fetches whatever
  402 URL the user supplies plus its poll URL. The list now says so.
- **The session-service rule contradicted itself (SDI-4).** One line said
  refuse, another said never override the user. Now one rule: refuse by
  default with the loss-of-fee warning; the single exception is the user
  explicitly proceeding after that exact warning.
- **"charge → proceed silently" overstated (SQP-2, surfaced via the discover
  listing).** Verified describes the service record, not permission to spend
  without the user seeing it; pay-per-call's mainnet confirmation gate applies.
- **`--yes` examples no longer model mainnet use (SQP-1).** Both examples now
  pin `--network testnet` and say why the mainnet prompt should run.

---

## v1.8.4 — 2026-08-11

Finds wallets left behind by earlier versions. Read-only: nothing is moved,
rewritten or deleted.

- **A `.stellar-secret` in an older install is now found.** 1.8.3 added a
  version-proof location but did nothing for wallets already sitting in a
  previous install (`.../stellar-agent-wallet/1.8.1/`), which upgrading users
  would have seen as "secret file not found" — a wallet that looks lost while
  its funds are still on-chain. Resolution now walks: the working directory,
  `~/.stellar-agent-wallet/.stellar-secret`, then sibling installs newest
  first. When one of those older wallets is used, the path is printed along
  with a suggestion to copy it somewhere version-proof — a suggestion, not an
  action: the file stays exactly where the user left it.

  Only `.stellar-secret` files this skill wrote, in this skill's own install
  directories, are ever considered. A generic `~/.env` or any other file
  belonging to the user is still never read.

- Absence still moves to the next candidate only on `ENOENT`; an unreadable
  file surfaces as itself rather than silently selecting a different wallet.

---

## v1.8.3 — 2026-08-11

Credential handling: only read what you were pointed at.

- **`.env.prod` / `.env` are no longer read from an unnamed directory.** The
  secret loader fell back to them in the secret file's directory, which by
  default is just the working directory. Those are the user's files and
  routinely hold credentials for unrelated things — API keys, database URLs —
  so reading them because the tool happened to be run there is not something
  the user ever agreed to. They are now consulted only when a path was named
  with `--secret-file`; naming a location is what authorises reading it.

- **New: `~/.stellar-agent-wallet/.stellar-secret`, checked when no path was
  given.** The default `.stellar-secret` is relative, so it lands in the
  working directory — which, following the documented commands, is the
  versioned plugin install (`.../stellar-agent-wallet/1.8.2/`). The next
  version installs to a sibling directory, so a wallet generated under the
  default became invisible after an upgrade, with the key stranded in the old
  version's folder. This location does not move with the version. A Stellar
  CLI identity (`--identity`) was never affected.

Nothing changes for `--identity` or an explicit `--secret-file`.

---

## v1.8.2 — 2026-08-11

Finishes the launcher fix 1.8.1 started. Docs only plus one package.json line;
no runtime, signing, or payment behaviour changes.

- **Documented commands now use `./node_modules/.bin/tsx`, not `npx tsx`**
  (23 files). 1.8.1 kept `npx tsx` everywhere and merely documented the local
  binary as a fallback, which left every copied command able to fail first.
  A clean 1.8.1 run still hit it and recovered only because the fallback was
  written down.

- **Removed the `"tsx": "tsx"` script added in 1.8.1.** It could never have
  worked, for two independent reasons. The published plugin artifact's
  `package.json` is generated by `plugin/build-plugin.mjs` and carries no
  `scripts` block at all, so the entry never reached an installed plugin. And
  `npm run` does not forward bare flags to the script — `npm run tsx --version`
  prints npm's version, not tsx's — so the `npm run tsx` path would still have
  mangled `--to`, `--amount` and the rest exactly as reported.

  The root trigger (why `npx tsx` becomes `npm run tsx` on some machines) is
  environment-specific and not reproducible here. Not depending on `npx` at
  all removes the failure mode rather than working around it.

---

## v1.8.1 — 2026-08-10

A launcher fix. No runtime, signing, or payment behaviour changes.

- **`npx tsx` could fail with `Missing script: "tsx"`** (#22). Every command in
  the README and the SKILL.md files is documented as
  `npx tsx skills/<name>/run.ts …`. On some npm versions `npx tsx` resolves to
  `npm run tsx` rather than the local tsx binary; the run then dies with
  `npm error Missing script: "tsx"`, and npm reinterprets the script's own
  flags along the way (`--to` is reported as `--token-description`). The error
  points nowhere near the real cause, so it reads like the skill is broken.
  A `"tsx": "tsx"` script now makes that fallback path resolve, and both the
  README and the `send-raw` section of SKILL.md document
  `./node_modules/.bin/tsx …` as the direct launcher. Hit for real while
  funding a `rozo-checkout` Stellar deposit.

  For agents: this failure happens **before** anything is signed or submitted.
  It is never a failed payment and must not trigger a retry of the send.

- **Republished the plugin artifact** (#23). `build/plugin/` — the directory
  users install via `/plugin marketplace add` — had drifted from source since
  1.8.0, so the fix above and the v1.8.0 discover-wording change were not
  actually reaching installs until it was rebuilt.

---

## v1.8.0 — 2026-08-10

Cuts everything that had accumulated since 1.7.0: the `send-raw` sub-skill, the
2026-07-31 hardening round, and a security dependency bump.

- **Security — `@stellar/stellar-sdk` 15.1.0 → 16.2.0** (#19). Clears two
  high-severity advisories reaching us through the SDK's `axios` dependency
  (authentication bypass via prototype pollution in the `validateStatus` merge
  strategy). The SDK is a runtime dependency, so the vulnerable code shipped to
  everyone who installed the skill or the plugin. `npm audit` now reports zero
  vulnerabilities.

  The version was declared in three places — `package.json` plus two plugin
  templates rendered into the published artifact. Bumping only the first would
  have left plugin users on the vulnerable SDK. All three now agree.

  Known gap: `test:sign` is not a reliable gate. It hits testnet and fails
  intermittently (~3 runs in 5) with Contract #6/#14 for the sender. Measured
  on unmodified 15.1.0 it failed at the same rate, so this is pre-existing and
  not a signing regression — but it does mean the release is not backed by a
  green end-to-end run. Fixing that gate is tracked separately.

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
