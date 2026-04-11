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

## Service catalog (live, verified)

| id | path | price | upstream |
|---|---|---|---|
| `parallel_search` | `POST /v1/services/parallel/search` | $0.01/req | Parallel.ai web search |
| `exa_search` | `POST /v1/services/exa/search` | $0.005/req | Exa neural search |
| `firecrawl_scrape` | `POST /v1/services/firecrawl/scrape` | $0.002/req | Firecrawl HTML → markdown |
| `openrouter_chat` | `POST /v1/services/openrouter/chat` | dynamic | OpenRouter LLM proxy |

This list can change — always call the catalog endpoint fresh, never cache.

## Service record shape

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
  "verified_mode": "charge"
}
```

## How to run

```bash
# List all services
npx tsx commands/discover/run.ts

# Filter by category
npx tsx commands/discover/run.ts --category search

# Match a free-text intent (uses simple keyword match)
npx tsx commands/discover/run.ts --query "web search"

# JSON output for piping
npx tsx commands/discover/run.ts --json
```

## Full end-to-end example

```bash
# Discover which service to use
SERVICE=$(npx tsx commands/discover/run.ts --query "web search" --pick-one --json | jq -r '.public_path')

# Call it — pay-per-call handles the 402 → pay → retry loop
npx tsx commands/pay-per-call/run.ts "https://apiserver.mpprouter.dev$SERVICE" \
  --body '{"query": "Summarize https://stripe.com/docs"}'
```

## Anti-patterns

- ❌ Don't hardcode service paths — the catalog is the source of truth.
- ❌ Don't pay twice for one call — credentials are single-use and HMAC-bound to amount/currency/recipient.
- ❌ Don't use testnet — MPP Router is mainnet-only.
- ❌ Don't cache the catalog for more than a minute — prices and service availability can change.
