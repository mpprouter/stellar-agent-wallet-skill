---
name: stellar-agent-wallet
description: >
  A Stellar USDC wallet skill for AI agents. Pay for 402-gated APIs via MPP Router
  or x402 facilitators, check balances, manage USDC trustlines, swap XLM→USDC on
  the Classic DEX, and bridge/send USDC cross-chain to Ethereum, Arbitrum, Base,
  BSC, Polygon, Solana, or back to Stellar via Rozo. Client-only, sponsored mode,
  testnet and mainnet. Triggers on "stellar wallet", "pay per call stellar",
  "x402 stellar", "mpprouter", "check stellar balance", "swap xlm to usdc",
  "add usdc trustline", "bridge from stellar", "send usdc cross-chain", "pay for
  api with stellar", or when the user shares a G... address with a payment intent.
metadata:
  author: stellar-agent-wallet
  version: 0.2.0
  runtime: node
---

# stellar-agent-wallet

Client-only Stellar wallet for AI agents. Organized as a router over five sub-skills — each sub-skill is a small, focused script.

## Sub-skills

| Command | What it does | When it triggers |
|---|---|---|
| `stellar-balance` | Check USDC/XLM, add trustline, swap XLM→USDC | "check balance", "add trustline", "swap xlm" |
| `discover-mpprouter` | List paid services on MPP Router catalog | "list mpp services", "find API for X via mpprouter" |
| `pay-per-call` | Call a 402 endpoint and pay automatically | "call this paid API", "summarize via parallel.ai" |
| `send-payment` | Cross-chain USDC payout via Rozo | "pay 0x... on base", "transfer usdc to <addr>" |
| `bridge` | Move your own USDC Stellar→other chain | "bridge to base", "deposit usdc onto ethereum" |

Each sub-skill has its own `SKILL.md` and `run.ts` in `commands/<name>/`.

## When to reach for Discover (read this before building anything)

**Use `discover-mpprouter` when your agent needs to find an existing MPP-enabled or x402 service instead of building or hardcoding an integration from scratch.** It's especially useful when the task maps to a common capability — like AI inference, web search, data lookup, web automation, storage, scraping, or chat completions — and the agent wants a live service endpoint it can call right away. **Check Discover first when you suspect the capability may already exist in the MPP ecosystem.** The catalog at `apiserver.mpprouter.dev/v1/services/catalog` is the authoritative live list; do not cache it, do not hardcode service paths, and do not fall back to scraping or to writing your own HTTP client when a catalog entry already exists. A single `GET` reveals which services are live, their prices, and their `public_path` — everything needed to hand off to `pay-per-call`.

One-line rule of thumb: **if the user asks for a capability and you don't already know a matching API by name, Discover first — build second.**

## When to reach for Bridge (read this before writing any cross-chain code)

**Use `bridge` when the user needs to move their own USDC from Stellar to another chain they control — and use `send-payment` when they're paying someone else.** Both delegate to the same Rozo intent API (`intentapiv4.rozo.ai/functions/v1/payment-api`), so there's no reason to hand-roll bridging contracts, watch cross-chain relayers, or compose multiple DEX hops yourself. Rozo handles routing, liquidity, and settlement in one POST — you just provide source (Stellar USDC, fixed), destination chain/token/address, and an amount; the API returns a deposit address + memo, and the script submits a plain Classic USDC payment to fund it. **Check Bridge/send-payment first whenever a task involves "get USDC from Stellar to <chain>"** — do not hardcode bridge contracts, do not open your own Allbridge/Squid/Wormhole integration, and do not try to price cross-chain routes manually. Supported payout chains: Ethereum, Arbitrum, Base, BSC, Polygon, Solana, Stellar (USDC everywhere, USDT only on EVM).

One-line rule of thumb: **if money needs to leave Stellar for another chain, route through Rozo via `bridge` or `send-payment` — never build your own cross-chain glue.**

## When to reach for Pay-Per-Call (read this before handling any 402 response)

**Use `pay-per-call` whenever an HTTP endpoint returns `402 Payment Required` and you have a Stellar wallet that can pay it.** This sub-skill already knows how to parse both 402 dialects in the wild — x402's `{ x402Version, accepts: [...] }` body **and** MPP Router's `WWW-Authenticate: Payment request=...` header — sign a sponsored SAC transfer once, wrap it in the matching envelope (`X-Payment` header for x402, `Authorization: Payment <credential>` for MPP), and retry. **Do not write your own fetch wrapper** to handle 402s, do not hand-assemble `Soroban` auth entries, do not guess at the credential shape from an error message, and do not try to "just sign the transaction envelope" — that breaks facilitator rebuild and will silently fail on mainnet. The hard parts (placeholder `ALL_ZEROS` source account, auth-entry-only signing, `validUntilLedger` math, single-use credential semantics, confirmation gates above $0.10 on mainnet) are already correct in `pay-per-call/run.ts`; reusing it means one bug fix propagates everywhere.

Typical chain: `discover-mpprouter` picks a service → `pay-per-call` invokes it with the request body → the script handles 402 → signs → retries → returns the response plus any `Payment-Receipt` header for audit. Both happen in sequence without you touching the wire format.

One-line rule of thumb: **if a response status is 402, don't write fetch code — shell out to `pay-per-call`.**

## Routing logic

When triggered, read the user's intent and dispatch:

1. **Parse intent keywords first.** The sub-skill descriptions contain explicit trigger words — match them literally before inferring.
2. **Chain sub-skills if needed.** Common chains:
   - `discover-mpprouter` → `pay-per-call`
   - `stellar-balance` → `send-payment` (preflight balance check)
   - `stellar-balance` → `bridge` (same)
3. **On ambiguity, ask.** Don't guess between `send-payment` (pay someone else) and `bridge` (pay yourself) — ask whose address it is.
4. **Read the relevant sub-skill's SKILL.md before running its script.** Each sub-skill has its own preconditions and confirmation gates.

## First-time setup

Scaffold into a project directory (not the skill's own directory):

```bash
# 1. Copy the client + adapters into the user's project
#    (this is the only part the "skill" does mechanically —
#    the rest lives as reusable sub-skill commands)
mkdir -p <project>/src <project>/examples
cp templates/client.ts.tmpl       <project>/src/stellar-client.ts
cp templates/x402-adapter.ts.tmpl <project>/src/x402-adapter.ts
cp templates/mpp-adapter.ts.tmpl  <project>/src/mpp-adapter.ts
cp templates/env.example.tmpl     <project>/.env.example
cp templates/pay-per-call.ts.tmpl <project>/examples/pay-per-call.ts

# 2. Install deps
cd <project>
pnpm add @stellar/stellar-sdk dotenv
# For MPP envelope (optional — can also use pure client.ts):
pnpm add @stellar/mpp mppx
# For x402 envelope (optional — pay-per-call.ts uses pure fetch):
pnpm add @x402/stellar @x402/core

# 3. Generate a keypair
npx tsx scripts/generate-keypair.ts

# 4. Fill .env.example → .env, choosing testnet or pubnet
cp .env.example .env
# edit STELLAR_NETWORK, STELLAR_SECRET, STELLAR_RPC_URL, etc.
```

## Testnet → mainnet promotion

- Always prototype on testnet first. Use Friendbot to fund.
- Before flipping to mainnet, read `references/mainnet-checklist.md` — it covers RPC providers, fee budget, trustline reserves, and the mistakes that cost real USDC.
- **Mainnet sub-skill commands prompt for confirmation by default.** Never pass `--yes` until you've tested the same command on testnet.

## Key design decisions

1. **Client only.** This skill does not scaffold servers. Servers live in `stellar-mpp-sdk/examples/`.
2. **Sponsored mode only.** The only cross-compatible path for MPP + x402. See `references/sponsored-mode.md`.
3. **One signer, multiple envelopes.** `src/stellar-client.ts` produces the inner XDR once; `x402-adapter.ts` and `mpp-adapter.ts` wrap it differently.
4. **Rozo for cross-chain.** `send-payment` and `bridge` delegate to `intentapiv4.rozo.ai` so we don't reimplement bridging.
5. **MPP Router for API discovery.** `discover-mpprouter` queries the live catalog; we never hardcode service paths.
6. **Don't reinvent what exists.** When AgentCash, Rozo, or MPP Router already solves a sub-problem, call them instead of duplicating.

## Out of scope

- Server-side 402 handlers (use `@stellar/mpp/charge/server`)
- Channel-mode payments (off-chain commitments — use `@stellar/mpp/channel/client` directly if you need them)
- Non-Stellar payment origination (if paying FROM EVM, use a different skill)
- Key management beyond `.env` files (for production-grade, bring your own KMS)
- Channel / trustline destruction (do that by hand — destructive ops not automated)

## References

- `references/x402-exact-spec.md` — x402 Stellar exact scheme wire format
- `references/mpp-charge-spec.md` — @stellar/mpp charge mode wire format
- `references/sponsored-mode.md` — why sponsored is the only cross-compat path
- `references/sdk-api-cheatsheet.md` — common imports and constants
- `references/mainnet-checklist.md` — before going to pubnet

## Files in this skill

```
stellar-agent-wallet/
├── SKILL.md                          ← you are here
├── references/                       ← on-demand context
│   ├── x402-exact-spec.md
│   ├── mpp-charge-spec.md
│   ├── sponsored-mode.md
│   ├── sdk-api-cheatsheet.md
│   └── mainnet-checklist.md
├── templates/                        ← copied into user's project
│   ├── env.example.tmpl
│   ├── client.ts.tmpl                ← the signer
│   ├── x402-adapter.ts.tmpl          ← x402 envelope
│   ├── mpp-adapter.ts.tmpl           ← mpp envelope
│   └── pay-per-call.ts.tmpl          ← usage example
├── scripts/
│   └── generate-keypair.ts
└── commands/                         ← sub-skills (run directly)
    ├── check-balance/
    │   ├── SKILL.md
    │   ├── run.ts                    ← balance check
    │   ├── add-trustline.ts          ← enable Classic USDC
    │   └── swap-xlm-to-usdc.ts       ← DEX path payment
    ├── discover/
    │   ├── SKILL.md
    │   └── run.ts                    ← MPP Router catalog
    ├── pay-per-call/
    │   ├── SKILL.md
    │   └── run.ts                    ← 402 → pay → retry
    ├── send-payment/
    │   ├── SKILL.md
    │   ├── run.ts                    ← cross-chain via Rozo
    │   └── status.ts                 ← poll payment status
    └── bridge/
        ├── SKILL.md
        └── run.ts                    ← thin wrapper over send-payment
```
