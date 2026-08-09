---
name: send-raw
description: Submit ONE Stellar Classic payment exactly as specified — destination, asset, amount, and memo all come from the caller, and nothing else is created. Use this to fund a deposit address that some other system already issued (a Rozo checkout order, an exchange deposit slip, an invoice). Triggers on "pay this deposit address", "fund this invoice", "send USDC to G... with memo", "the checkout gave me an address and memo", "submit the Stellar leg". Does NOT create a Rozo intent — for cross-chain payouts use send-payment or bridge instead.
---

# send-raw

The low-level payment primitive: build, sign, and submit a single Stellar Classic
payment with a memo. No intent creation, no routing, no bridging.

## When to trigger

- "Pay this deposit address `G...` with memo `57985500`"
- "The Rozo checkout gave me an address + memo — send the 1.05 USDC"
- "Fund this exchange deposit, memo is my account ID"
- "Send 5 XLM to `G...`"
- Any time the destination address **and** the memo were handed to you by
  another system and just need to be paid.

## Not for

- **Cross-chain payouts** — use `send-payment`. It creates a Rozo intent so the
  recipient can be on Base/Solana/etc.
- **Moving your own USDC off Stellar** — use `bridge`.
- **402-gated API calls** — use `pay-per-call`.
- **Soroban contract wallets (`C...`)** — a Classic payment cannot fund a
  contract; the recipient must invoke its `pay()` function. The script rejects
  `C...` destinations rather than sending funds that get stuck.

## Why this exists (read before reaching for send-payment)

`send-payment` and `bridge` always **originate** a payment: they POST a new
intent to Rozo and then fund whatever deposit address Rozo returns. Their `--to`
is the *final recipient of a new intent*, not an address to pay directly.

So when a checkout flow has **already** produced a deposit address and memo,
`send-payment --to <that address>` is the wrong tool — it opens a *second*
intent and pays a *different* address, burning an extra fee and leaving the
original order unfunded.

Before this sub-skill existed the only way to do it was by hand, because the
Stellar CLI's `tx new payment` has no `--memo` flag:

```bash
stellar tx new payment ... --build-only        # no memo support
stellar tx decode --output json-formatted "$XDR"
python3 -c "... patch tx.tx.memo ..."          # hand-edit the JSON
stellar tx encode tx_with_memo.json
stellar tx sign ... && stellar tx send ...
```

Seven steps with a hand-patched memo in the middle. A wrong or missing memo on a
deposit address means the money arrives and is never credited — the worst place
to improvise. `send-raw` is that pipeline as one audited command.

## How to run

```bash
# Fund a deposit address with USDC + the required text memo
npx tsx skills/send-raw/run.ts \
  --to GB4CLV...6EB4 \
  --amount 1.0500 \
  --asset USDC \
  --memo 57985500 \
  --identity mpp-mainnet-payer

# Native XLM, numeric memo (common at exchanges)
npx tsx skills/send-raw/run.ts \
  --to G... --amount 25 --asset XLM --memo 9182736455 --memo-type id

# A non-USDC issued asset
npx tsx skills/send-raw/run.ts \
  --to G... --amount 10 \
  --asset EURC:GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4ITNPP2

# Testnet dry run
npx tsx skills/send-raw/run.ts \
  --to G... --amount 1 --asset XLM --memo hello --network testnet
```

## Flags

| Flag | Required | Notes |
|---|---|---|
| `--to <G...>` | yes | Destination account. `C...` contract addresses are rejected. |
| `--amount <decimal>` | yes | Max 7 decimal places. Passed through verbatim — `1.0500` stays `1.0500`. |
| `--asset <spec>` | no | `USDC` (default, Circle issuer for the selected network), `XLM`, or `CODE:ISSUER`. |
| `--memo <value>` | no | Omit only if you are certain the destination does not need one. |
| `--memo-type <type>` | no | `text` (default, ≤28 **bytes**), `id` (unsigned integer), `hash` / `return` (64 hex chars). |
| `--json` | no | Print a JSON result after submission. |
| `--yes`, `-y` | no | Skip the prompt. Never on mainnet without independently verifying destination + memo. |

Plus the shared base flags — `--identity <name>` / `--secret-file <path>`,
`--network`, `--horizon-url`. Prefer `--identity`; it keeps the key in Stellar
CLI key management instead of a plaintext file.

## Preflight checks

The script reads both accounts before building anything, so the common Horizon
rejections surface as plain English *before* a signature exists:

| Check | Failure it prevents |
|---|---|
| Source account exists and is funded | `tx_no_source_account` |
| Source holds the asset (trustline present) | `op_no_trust` on the source side |
| Source balance ≥ amount | `op_underfunded` |
| Spendable XLM > 0 after the minimum reserve | fee cannot be paid |
| Destination account exists | `op_no_destination` |
| Destination trusts the asset (non-native) | `op_no_trust` |
| Amount ≤ 7 decimals, > 0 | malformed amount |
| Memo fits its type's limits | `tx_malformed` |
| Destination ≠ source | a pointless self-payment |

If no `--memo` was given, the review block says so loudly — a missing memo is
the single most common way a correct-looking deposit goes uncredited.

## Confirmation

The full payment — from, to, asset, amount, memo, balance — is printed and
confirmed before signing. On `pubnet` the prompt names mainnet explicitly. Only
`yes` proceeds; anything else aborts before a signature exists.

## Output

```
✅ Payment submitted
   Tx hash: <hash>
   Ledger:  63872153
   View:    https://stellar.expert/explorer/public/tx/<hash>
```

With `--json`, a machine-readable object follows containing the hash, ledger,
from, to, asset, amount, memo, memo type, and network.

## Tests

`npm run test:send-raw` runs the full build → sign → submit path on testnet
against two Friendbot-funded accounts, then re-reads the transaction from
Horizon and asserts the memo, amount, and destination that actually landed
on-chain match what was requested. Uses native XLM so it needs no trustline
or faucet beyond Friendbot.
