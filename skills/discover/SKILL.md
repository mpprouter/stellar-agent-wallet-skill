---
name: discover-mpprouter
description: Discover paid API services available via MPP Router (apiserver.mpprouter.dev) that accept Stellar USDC payments. Triggers on prompts like "summarize X using parallel.ai via MPPRouter", "search with exa via mpp", "find a service for <task>", "list mpp services", "what APIs can I pay for with stellar". Fetches the live service catalog, picks a matching service, and hands off to the pay-per-call sub-skill to actually invoke it.
---

# discover-mpprouter

High-level discovery for the MPP Router service catalog. Lets agents find and call paid APIs on Stellar mainnet without hardcoding URLs.

## What is MPP Router?

[MPP Router](https://www.mpprouter.dev) is a Stellar-native 402 proxy. It takes USDC payments on `stellar:pubnet` and forwards your request to upstream merchant APIs — Parallel.ai, Exa, Firecrawl, OpenRouter, and more. You pay once in Stellar USDC and get back whatever the upstream merchant returns. No need to hold USDC on Base/Tempo.

**Mainnet only.** The router does not run on testnet.

## When to trigger

- "Summarize https://stripe.com/docs using parallel.ai search via MPPRouter"
- "Search for X via exa through mpp"
- "Scrape this page with firecrawl — use stellar to pay"
- "List available MPP services"
- "What paid APIs can I call with stellar USDC?"
- User mentions `mpprouter` or `mpp router` by name

## Flow

1. **Discover** — `GET https://apiserver.mpprouter.dev/v1/services/catalog` returns the live service list.
2. **Match** — pick the service whose `id` or `category` best fits the user's intent. Ask the user if ambiguous.
3. **Invoke** — `POST {base_url}{public_path}` with the request body. Expect `402 Payment Required` with a Stellar challenge in `WWW-Authenticate: Payment request=...`.
4. **Pay** — hand off to `pay-per-call` with the 402 challenge; it produces a signed credential.
5. **Retry** — re-POST the same body with `Authorization: Payment <credential>`. Receive the upstream response + `Payment-Receipt` header.

## Service catalog

The catalog is live and large (~500 services). Always call
`/v1/services/catalog` fresh — never hardcode a list, never cache for
more than a minute.

### Payment-mode labels (IMPORTANT for the LLM)

The catalog exposes a `verified_mode` field per service. The discover
skill reads it and tags each record with a `payment_mode` string:

- **`charge`** (`✓ verified charge`) — end-to-end verified to work with
  this skill's Stellar charge flow. Safe to call. Currently known-good:
  `exa_search`, `firecrawl_scrape`, `parallel_search`, `alchemy_rpc`,
  `storage_upload`.
- **`session`** (`⚠ session-only`) — upstream merchant is session-mode
  only. MPP Router still advertises `stellar.intents: ["charge","channel"]`
  for these and emits `intent="charge"` challenges, so the client signs
  and pays **but the upstream rejects the payment receipt** and returns
  a 404. **This is "pay-but-404" — real USDC is spent with no response
  returned.** The router team has been notified; fix pending. Affected:
  `gemini_generate`, `openai_chat`, `openrouter_chat`, `tempo_rpc`.
  Do NOT route charges to these until `verified_mode` flips to `charge`.
- **`unverified`** (`· unverified`) — the router hasn't labeled
  `verified_mode` (or labeled it as the literal string `"false"`, which
  is a router-side catalog-generator bug). ~97% of the catalog is in
  this bucket. Most of these work but we can't prove it without a paid
  probe. Treat as cautiously optimistic: acceptable to call on user
  request, but warn the user that it's not formally verified.

### Decision rule for the LLM

When the user asks to call a paid API via MPP Router:

1. Fetch the catalog fresh.
2. Find the best service match.
3. Check its `payment_mode`:
   - `charge` → proceed silently.
   - `session` → **refuse to call it.** Tell the user: "This service is
     currently in session-only mode on MPP Router. Paying via Stellar
     charge mode would succeed but the upstream would reject the
     receipt, so you'd lose the fee with no result. Waiting on a
     router-side fix. Alternative service?"
   - `unverified` → proceed but surface a brief caveat in your
     response ("this service isn't formally verified for Stellar charge
     mode; proceeding anyway — let me know if the call fails after
     payment").
4. Never override the user's explicit instruction to call a `session`
   service, but do warn them loudly before doing it.

## Service record shape

Discover enriches each record with a `payment_mode` field (one of
`charge`, `session`, `unverified`) derived from `verified_mode`. This
is the field the LLM should branch on — it normalizes the router's
raw `verified_mode` string (which can be missing or literally
`"false"`) into a fixed vocabulary.

```json
{
  "id": "parallel_search",
  "name": "Parallel Search",
  "category": "search",
  "description": "...",
  "public_path": "/v1/services/parallel/search",
  "method": "POST",
  "price": "$0.01/request",
  "payment_method": "stellar",
  "network": "stellar-mainnet",
  "asset": "USDC",
  "status": "active",
  "methods": { "stellar": { "intents": ["charge", "channel"] } },
  "verified_mode": "charge",
  "payment_mode": "charge"
}
```

## How to run

```bash
# List all services
npx tsx skills/discover/run.ts

# Filter by category
npx tsx skills/discover/run.ts --category search

# Match a free-text intent (uses simple keyword match)
npx tsx skills/discover/run.ts --query "web search"

# JSON output for piping
npx tsx skills/discover/run.ts --json
```

## Full end-to-end example

```bash
# Discover which service to use
SERVICE=$(npx tsx skills/discover/run.ts --query "web search" --pick-one --json | jq -r '.public_path')

# Call it — pay-per-call handles the 402 → pay → retry loop
npx tsx skills/pay-per-call/run.ts "https://apiserver.mpprouter.dev$SERVICE" \
  --body '{"query": "Summarize https://stripe.com/docs"}'
```

## Anti-patterns

- ❌ Don't hardcode service paths — the catalog is the source of truth.
- ❌ Don't pay twice for one call — credentials are single-use and HMAC-bound to amount/currency/recipient.
- ❌ Don't use testnet — MPP Router is mainnet-only.
- ❌ Don't cache the catalog for more than a minute — prices and service availability can change.
