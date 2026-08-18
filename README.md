# stellar-agent-wallet

Stellar USDC wallet for AI agents. Pay 402-gated APIs (x402 or MPP Router),
check balances, add USDC trustlines, swap XLM→USDC on the DEX, and
send/bridge USDC cross-chain to EVM, Solana, or back to Stellar via Rozo.
File-based secret storage, sponsored mode, testnet and mainnet.

## Install (Claude Code plugin)

```
/plugin marketplace add mpprouter/stellar-agent-wallet-skill
/plugin install stellar-agent-wallet@mpprouter
```

## Use from any agent

There is no Claude-Code-only runtime API here. Each sub-skill is a plain
CLI, and `SKILL.md` is a *prompt* telling an agent which one to run — so
any agent that can execute a shell command (Codex, Cursor, Amp, an
in-house harness, or a human) can use this repo today. Agents that look
for an `AGENTS.md` will find one at the repo root; it is a symlink to
`SKILL.md`.

```bash
git clone https://github.com/mpprouter/stellar-agent-wallet-skill
cd stellar-agent-wallet-skill && npm install
```

Point your agent at `SKILL.md` (routing + the security banner) and at the
individual `skills/*/SKILL.md` for each command's flags. The entry points:

| Task | Command |
| --- | --- |
| Create / import a wallet | `./node_modules/.bin/tsx skills/onboard/run.ts` |
| Check balance, reserves, trustline | `./node_modules/.bin/tsx skills/check-balance/run.ts` |
| Find a paid API | `./node_modules/.bin/tsx skills/discover/run.ts --query "<text>" --pick-one --json` |
| Call a 402-gated API and pay | `./node_modules/.bin/tsx skills/pay-per-call/run.ts <url> …` |
| Send USDC | `./node_modules/.bin/tsx skills/send-payment/run.ts …` |
| Bridge USDC cross-chain | `./node_modules/.bin/tsx skills/bridge/run.ts …` |

> The local binary is used deliberately rather than `npx tsx`. On some setups
> `npx tsx` resolves to `npm run tsx`, which fails with
> `npm error Missing script: "tsx"` and — worse — reinterprets the script's own
> flags on the way (`--to` gets reported as `--token-description`). The error
> then points nowhere near the real cause. `./node_modules/.bin/tsx` runs the
> same tsx with no launcher in between.

A representative paid call, with the safety flags you should always pass
when the catalog told you what to expect:

```bash
./node_modules/.bin/tsx skills/pay-per-call/run.ts \
  https://apiserver.mpprouter.dev/v1/services/firecrawl/scrape \
  --method POST --body '{"url":"https://example.com"}' \
  --expect-pay-to <G...> --expect-amount 0.002 \
  --identity <name> --network testnet --json
```

Conventions worth knowing before you wire this into an autonomous loop:

- **`--json`** puts a machine-readable summary on **stderr** and keeps
  **stdout** as the merchant's response body verbatim, so you can pipe
  stdout straight into your agent without stripping anything.
- **`--expect-pay-to` / `--expect-amount`** make the client refuse to
  sign when the 402 challenge disagrees. Use them whenever the value is
  known ahead of time — they are the defense against a server rewriting
  its own challenge.
- **`--network testnet`** for anything you have not run before. The
  default is `pubnet` (real money).
- **Exit code 0 means the call succeeded**; a payment that could not be
  parsed, validated, or settled is non-zero with the reason on stderr.
- Every mainnet payment requires interactive confirmation unless you opt
  out with `--yes`, or with `--max-auto <usd>` which auto-signs only
  below a per-session, hard-capped ceiling ($5). Read the security banner
  in `SKILL.md` before automating that away.
- On commands that need a wallet, `--identity <name>` (a Stellar CLI
  identity) and `--secret-file <path>` are mutually exclusive.
  `discover` is public and requires neither.

Want to understand the 402 protocol itself rather than the CLI? See
`references/402-dialects-showcase.md` — a real dual-dialect 402 decoded
field by field.

Paid for a call that failed? The router refunds automatically and
`pay-per-call` now prints the `Refund-Id` and receipt URL it returns.
`references/verifying-refunds.md` walks a payer through fetching that
receipt and verifying its Ed25519 signature without trusting us.

## Security

This skill is a **wallet**. It signs Stellar transactions with a private
key stored at `.stellar-secret` (mode 600, created by
`scripts/generate-keypair.ts`) or in an existing Stellar CLI identity
selected with `--identity <name>`. Use a dedicated hot wallet — never your
main account. Wallet files are never overwritten by key generation. Default network is `pubnet` (mainnet); pass
`--network testnet` while prototyping.

See `SKILL.md` for the full security banner and `references/mainnet-checklist.md`
before pointing this at real money.

## Development

```bash
npm run build:skill     # build/skill/ — upload manually to skill marketplace
npm run build:plugin    # build/plugin/ + .claude-plugin/marketplace.json
npm run build:all
```

Source of truth: `version.json`. Bump the version there, run `build:all`,
commit, tag, push.

## License

MIT
